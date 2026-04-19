import {
  db,
  journalEntriesTable,
  journalEntryLinesTable,
  accountingSourceLinksTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

/**
 * Task #49 — Shared CSV-export helper for journal entries.
 *
 * Both the on-demand `/accounting/journal-entries.csv` route and the
 * scheduled-export job call this function so the file the scheduler
 * emails is byte-identical to the file an admin would download for the
 * same filter set. There must be exactly one rendering path; if a new
 * column or filter is added, it must be added here.
 */

export const CSV_EXPORT_MAX_ENTRIES = 10_000;

export type JournalEntryCsvFilters = {
  status?: "posted" | "reversed" | null;
  source?: "copilot" | "manual" | "expense" | "bill" | null;
  /** YYYY-MM-DD inclusive lower bound on entry_date. */
  from?: string | null;
  /** YYYY-MM-DD inclusive upper bound on entry_date. */
  to?: string | null;
  includeLines?: boolean;
};

export type JournalEntryCsvResult =
  | {
      ok: true;
      csv: string;
      rowCount: number;
      filename: string;
      includeLines: boolean;
    }
  | {
      ok: false;
      reason: "too_large";
      max: number;
    };

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralize spreadsheet formula injection (CWE-1236): cells whose first
  // character is =, +, -, @, or a leading tab/CR are interpreted as
  // formulas by Excel/Sheets when the file is opened. Prefix with a single
  // quote so the cell is treated as text. Genuine numeric strings (e.g.
  // "-12.34" from formatCentsForCsv) are left alone so debit/credit
  // columns still aggregate as numbers in the spreadsheet.
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCentsForCsv(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function buildSourceClauseFor(
  source: NonNullable<JournalEntryCsvFilters["source"]>,
): SQL[] {
  if (source === "copilot") {
    return [sql`${journalEntriesTable.agentActionId} IS NOT NULL`];
  }
  if (source === "manual") {
    return [
      sql`${journalEntriesTable.agentActionId} IS NULL`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${accountingSourceLinksTable}
        WHERE ${accountingSourceLinksTable.sourceType} IN ('expense','bill')
          AND (
            ${accountingSourceLinksTable.journalEntryId} = ${journalEntriesTable.id}
            OR (
              ${journalEntriesTable.manualDraftId} IS NOT NULL
              AND ${accountingSourceLinksTable.manualJournalEntryDraftId} = ${journalEntriesTable.manualDraftId}
            )
          )
      )`,
    ];
  }
  // expense | bill
  return [
    sql`${journalEntriesTable.agentActionId} IS NULL`,
    sql`EXISTS (
      SELECT 1 FROM ${accountingSourceLinksTable}
      WHERE ${accountingSourceLinksTable.sourceType} = ${source}
        AND (
          ${accountingSourceLinksTable.journalEntryId} = ${journalEntriesTable.id}
          OR (
            ${journalEntriesTable.manualDraftId} IS NOT NULL
            AND ${accountingSourceLinksTable.manualJournalEntryDraftId} = ${journalEntriesTable.manualDraftId}
          )
        )
    )`,
  ];
}

export async function generateJournalEntryCsv(
  filters: JournalEntryCsvFilters,
): Promise<JournalEntryCsvResult> {
  const includeLines = filters.includeLines === true;
  const conds: SQL[] = [];
  if (filters.status === "posted" || filters.status === "reversed") {
    conds.push(eq(journalEntriesTable.status, filters.status));
  }
  if (
    filters.source === "copilot" ||
    filters.source === "manual" ||
    filters.source === "expense" ||
    filters.source === "bill"
  ) {
    conds.push(...buildSourceClauseFor(filters.source));
  }
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
    conds.push(sql`${journalEntriesTable.entryDate} >= ${filters.from}`);
  }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    conds.push(sql`${journalEntriesTable.entryDate} <= ${filters.to}`);
  }
  const whereExpr = conds.length ? and(...conds) : undefined;

  const entries = await db
    .select()
    .from(journalEntriesTable)
    .where(whereExpr)
    .orderBy(desc(journalEntriesTable.postedAt))
    .limit(CSV_EXPORT_MAX_ENTRIES + 1);

  if (entries.length > CSV_EXPORT_MAX_ENTRIES) {
    return { ok: false, reason: "too_large", max: CSV_EXPORT_MAX_ENTRIES };
  }

  const linesByEntry = new Map<
    number,
    Array<typeof journalEntryLinesTable.$inferSelect>
  >();
  if (includeLines && entries.length > 0) {
    const ids = entries.map((e) => e.id);
    const allLines = await db
      .select()
      .from(journalEntryLinesTable)
      .where(inArray(journalEntryLinesTable.journalEntryId, ids))
      .orderBy(
        asc(journalEntryLinesTable.journalEntryId),
        asc(journalEntryLinesTable.lineNo),
      );
    for (const ln of allLines) {
      const arr = linesByEntry.get(ln.journalEntryId) ?? [];
      arr.push(ln);
      linesByEntry.set(ln.journalEntryId, arr);
    }
  }

  const rows: string[] = [];
  if (includeLines) {
    rows.push(
      [
        "entry_date",
        "entry_no",
        "memo",
        "source",
        "status",
        "line_no",
        "account",
        "debit",
        "credit",
        "program",
        "fund",
        "line_memo",
      ].join(","),
    );
    for (const e of entries) {
      const src = e.agentActionId !== null ? "copilot" : "manual";
      const lines = linesByEntry.get(e.id) ?? [];
      if (lines.length === 0) {
        rows.push(
          [
            csvEscape(e.entryDate),
            csvEscape(e.entryNo),
            csvEscape(e.memo),
            csvEscape(src),
            csvEscape(e.status),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          ].join(","),
        );
        continue;
      }
      for (const ln of lines) {
        rows.push(
          [
            csvEscape(e.entryDate),
            csvEscape(e.entryNo),
            csvEscape(e.memo),
            csvEscape(src),
            csvEscape(e.status),
            csvEscape(ln.lineNo),
            csvEscape(ln.account),
            csvEscape(
              ln.type === "debit" ? formatCentsForCsv(ln.amountCents) : "",
            ),
            csvEscape(
              ln.type === "credit" ? formatCentsForCsv(ln.amountCents) : "",
            ),
            csvEscape(ln.program),
            csvEscape(ln.fund),
            csvEscape(ln.memo),
          ].join(","),
        );
      }
    }
  } else {
    rows.push(
      [
        "entry_date",
        "entry_no",
        "memo",
        "total_debits",
        "total_credits",
        "source",
        "status",
      ].join(","),
    );
    for (const e of entries) {
      const src = e.agentActionId !== null ? "copilot" : "manual";
      rows.push(
        [
          csvEscape(e.entryDate),
          csvEscape(e.entryNo),
          csvEscape(e.memo),
          csvEscape(formatCentsForCsv(e.totalsDebitsCents)),
          csvEscape(formatCentsForCsv(e.totalsCreditsCents)),
          csvEscape(src),
          csvEscape(e.status),
        ].join(","),
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `journal-entries-${today}${
    includeLines ? "-with-lines" : ""
  }.csv`;
  // Prepend UTF-8 BOM so Excel opens non-ASCII memos correctly.
  const csv = "\uFEFF" + rows.join("\r\n") + "\r\n";
  return {
    ok: true,
    csv,
    rowCount: entries.length,
    filename,
    includeLines,
  };
}
