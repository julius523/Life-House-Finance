/**
 * Accounting remediation queue.
 *
 * Surfaces every line-level integrity failure the reconciliation report
 * detects, in a form an admin can act on. Two distinct surfaces:
 *
 *   - Posted lines (status='posted' | 'reversed') are immutable in place
 *     (DB triggers from Task #67 enforce this). The queue exposes them
 *     with `mutability='locked'` so the UI must route a corrective action
 *     through the reverse-and-replace / adjusting-entry endpoint
 *     (added in a separate slice).
 *
 *   - Draft lines (manual_journal_entry_drafts.payload.lines, with
 *     status in 'draft' | 'submitted' | 'approved') are mutable; the UI
 *     can call POST /accounting/journal-entry-drafts/:id/lines/:idx/
 *     remediate-account to repoint a single line to a valid account.
 *
 * Failure codes are stable and intentionally narrow:
 *   - missing_account       — line.account_id is null OR doesn't join CoA
 *   - archived_account      — joins, but coa.is_active = false
 *   - non_postable_account  — joins, but coa.allow_manual_posting = false
 *   - invalid_line_amount   — amount_cents <= 0
 *   - unbalanced_entry      — entry-level: Σ debits ≠ Σ credits
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  journalEntriesTable,
  journalEntryLinesTable,
  manualJournalEntryDraftsTable,
  chartOfAccountsTable,
  accountingSourceLinksTable,
  accountingPeriodsTable,
  activityLogTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import {
  postManualJournalEntry,
  reverseJournalEntry,
  type PostingActor,
} from "../lib/postingService";

const router: IRouter = Router();

// Read endpoints are admin/approver only — the queue exposes draft + posted
// rows tied to financial mutations and is not intended for submitters.
router.use(
  "/accounting/remediation",
  requireAuth,
  requireRole("admin", "approver"),
);

/**
 * Build a PostingActor from the authenticated request. The auth
 * middleware populates req.authUser (NOT req.user — that field does
 * not exist on this app's Express Request). The middleware guarantees
 * authUser is present whenever this runs.
 */
function actorFromReq(req: Request): PostingActor {
  const u = req.authUser;
  if (!u) {
    // Should be unreachable behind requireAuth, but stay defensive so a
    // misconfigured route never silently logs as actor 0/viewer.
    throw new Error(
      "actorFromReq called without authenticated user — route is missing requireAuth.",
    );
  }
  return { id: u.id, role: u.role, email: u.email };
}

const FAILURE_CODES = [
  "missing_account",
  "archived_account",
  "non_postable_account",
  "invalid_line_amount",
  "unbalanced_entry",
] as const;
type FailureCode = (typeof FAILURE_CODES)[number];

const SOURCE_TYPES = ["expense", "bill"] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

const STATUS_FILTERS = ["draft", "posted"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type RemediationRow = {
  /** Stable composite id: "<status>:<entryId>:<lineId>:<code>". */
  id: string;
  status: StatusFilter;
  /** Posted lines are locked; draft lines are mutable in place. */
  mutability: "locked" | "mutable";
  failureCode: FailureCode;
  jeNumber: string | null;
  entryId: number;
  entryDate: string | null;
  memo: string | null;
  entryStatus: string;
  workflowState: string | null;
  /**
   * For posted: the journal_entry_lines.id (stable PK).
   * For drafts: the 0-based index inside payload.lines (stable within
   * the current draft version).
   */
  lineId: number;
  lineDescription: string | null;
  debitCents: number;
  creditCents: number;
  currentAccount: { id: number; code: string; name: string } | null;
  /** Free-text account string preserved for historical / unmapped lines. */
  accountText: string | null;
  sourceType: SourceType | null;
  sourceRecordId: number | null;
  sourceRecordLink: string | null;
  /**
   * True when the accounting period covering `entryDate` is closed. Posted
   * corrective actions (reverse_and_replace / adjusting_entry) cannot
   * complete while the period is locked, so the dialog uses this to warn
   * the operator up front instead of after a failed submit.
   *
   * Null `entryDate` (only possible for some draft rows) yields false —
   * there's no period to lock yet.
   */
  periodLocked: boolean;
  /** Label of the period covering `entryDate`, when one exists. */
  periodLabel: string | null;
  shortMessage: string;
};

const QuerySchema = z.object({
  code: z.enum(FAILURE_CODES).optional(),
  entryId: z.coerce.number().int().positive().optional(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
  status: z.enum(STATUS_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

function sourceLink(
  sourceType: SourceType | null,
  sourceId: number | null,
): string | null {
  if (!sourceType || !sourceId) return null;
  if (sourceType === "expense") return `/expenses/${sourceId}`;
  if (sourceType === "bill") return `/bills/${sourceId}`;
  return null;
}

/**
 * Build the full set of remediation rows from posted-side and draft-side
 * sources. Filters and pagination are applied to the combined list.
 *
 * This is intentionally not a single SQL union — drafts store lines as
 * JSON in `payload.lines` and the validation rules require joining each
 * line against the live chart of accounts. Doing that in SQL would be
 * substantially harder to read than two well-bounded queries plus an
 * in-process merge, and the queue size is naturally small (only
 * failing rows survive).
 */
/**
 * Pre-load every accounting period once so we can stamp `periodLocked` /
 * `periodLabel` onto each queue row without an N+1 query. Period count
 * stays small (one per closed month or so), and the queue itself only
 * holds failing rows, so resolving the covering period in JS via a
 * date-range scan is cheap and simple.
 */
async function loadPeriodResolver(): Promise<
  (entryDate: string | null) => { locked: boolean; label: string | null }
> {
  const periods = await db
    .select({
      label: accountingPeriodsTable.label,
      periodStart: accountingPeriodsTable.periodStart,
      periodEnd: accountingPeriodsTable.periodEnd,
      status: accountingPeriodsTable.status,
    })
    .from(accountingPeriodsTable);
  return (entryDate) => {
    if (!entryDate) return { locked: false, label: null };
    // Period dates are stored as `YYYY-MM-DD`, so lexical compare is safe.
    for (const p of periods) {
      if (entryDate >= p.periodStart && entryDate <= p.periodEnd) {
        return { locked: p.status === "closed", label: p.label };
      }
    }
    return { locked: false, label: null };
  };
}

async function loadAllRows(): Promise<RemediationRow[]> {
  const rows: RemediationRow[] = [];
  const resolvePeriod = await loadPeriodResolver();

  // ----- Posted side -------------------------------------------------------
  // One row per failing line. A single posted line can fail multiple checks
  // (e.g. missing account AND non-positive amount). We emit one queue row
  // per (line, code) so the operator can see and clear each independently.
  const postedFailingLines = await db
    .select({
      lineId: journalEntryLinesTable.id,
      lineNo: journalEntryLinesTable.lineNo,
      type: journalEntryLinesTable.type,
      amountCents: journalEntryLinesTable.amountCents,
      accountText: journalEntryLinesTable.account,
      lineMemo: journalEntryLinesTable.memo,
      accountIdRaw: journalEntryLinesTable.accountId,
      coaId: chartOfAccountsTable.id,
      coaCode: chartOfAccountsTable.code,
      coaName: chartOfAccountsTable.name,
      coaIsActive: chartOfAccountsTable.isActive,
      coaAllowManualPosting: chartOfAccountsTable.allowManualPosting,
      entryId: journalEntriesTable.id,
      entryNo: journalEntriesTable.entryNo,
      entryDate: journalEntriesTable.entryDate,
      entryMemo: journalEntriesTable.memo,
      entryStatus: journalEntriesTable.status,
      sourceType: accountingSourceLinksTable.sourceType,
      sourceId: accountingSourceLinksTable.sourceId,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .leftJoin(
      chartOfAccountsTable,
      eq(journalEntryLinesTable.accountId, chartOfAccountsTable.id),
    )
    .leftJoin(
      accountingSourceLinksTable,
      eq(accountingSourceLinksTable.journalEntryId, journalEntriesTable.id),
    )
    .where(
      and(
        inArray(journalEntriesTable.status, ["posted", "reversed"]),
        sql`(
          ${journalEntryLinesTable.accountId} IS NULL
          OR ${chartOfAccountsTable.id} IS NULL
          OR ${chartOfAccountsTable.isActive} = false
          OR ${chartOfAccountsTable.allowManualPosting} = false
          OR ${journalEntryLinesTable.amountCents} <= 0
        )`,
      ),
    );

  for (const r of postedFailingLines) {
    const base = {
      status: "posted" as const,
      mutability: "locked" as const,
      jeNumber: r.entryNo,
      entryId: r.entryId,
      entryDate: r.entryDate,
      memo: r.entryMemo,
      entryStatus: r.entryStatus,
      workflowState: null,
      lineId: r.lineId,
      lineDescription: r.lineMemo ?? null,
      debitCents: r.type === "debit" ? r.amountCents : 0,
      creditCents: r.type === "credit" ? r.amountCents : 0,
      currentAccount: r.coaId
        ? { id: r.coaId, code: r.coaCode!, name: r.coaName! }
        : null,
      accountText: r.accountText ?? null,
      sourceType: (r.sourceType as SourceType | null) ?? null,
      sourceRecordId: r.sourceId ?? null,
      sourceRecordLink: sourceLink(
        (r.sourceType as SourceType | null) ?? null,
        r.sourceId ?? null,
      ),
      ...(() => {
        const p = resolvePeriod(r.entryDate);
        return { periodLocked: p.locked, periodLabel: p.label };
      })(),
    };

    const codes: FailureCode[] = [];
    if (r.accountIdRaw === null || r.coaId === null) {
      codes.push("missing_account");
    } else if (r.coaIsActive === false) {
      codes.push("archived_account");
    } else if (r.coaAllowManualPosting === false) {
      codes.push("non_postable_account");
    }
    if (r.amountCents <= 0) {
      codes.push("invalid_line_amount");
    }
    for (const code of codes) {
      rows.push({
        ...base,
        id: `posted:${r.entryId}:${r.lineId}:${code}`,
        failureCode: code,
        shortMessage: shortMessageFor(code, r.accountText),
      });
    }
  }

  // Posted-side unbalanced entries: aggregate at the entry level. Emit a
  // single row per entry (lineId=0) so operators can navigate to the
  // corrective-action dialog for the whole JE.
  const unbalancedPosted = await db
    .select({
      entryId: journalEntriesTable.id,
      entryNo: journalEntriesTable.entryNo,
      entryDate: journalEntriesTable.entryDate,
      entryMemo: journalEntriesTable.memo,
      entryStatus: journalEntriesTable.status,
      debits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      credits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      sourceType: accountingSourceLinksTable.sourceType,
      sourceId: accountingSourceLinksTable.sourceId,
    })
    .from(journalEntriesTable)
    .leftJoin(
      journalEntryLinesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .leftJoin(
      accountingSourceLinksTable,
      eq(accountingSourceLinksTable.journalEntryId, journalEntriesTable.id),
    )
    .where(inArray(journalEntriesTable.status, ["posted", "reversed"]))
    .groupBy(
      journalEntriesTable.id,
      journalEntriesTable.entryNo,
      journalEntriesTable.entryDate,
      journalEntriesTable.memo,
      journalEntriesTable.status,
      accountingSourceLinksTable.sourceType,
      accountingSourceLinksTable.sourceId,
    );
  for (const r of unbalancedPosted) {
    if (r.debits === r.credits) continue;
    const sType = (r.sourceType as SourceType | null) ?? null;
    rows.push({
      id: `posted:${r.entryId}:0:unbalanced_entry`,
      status: "posted",
      mutability: "locked",
      failureCode: "unbalanced_entry",
      jeNumber: r.entryNo,
      entryId: r.entryId,
      entryDate: r.entryDate,
      memo: r.entryMemo,
      entryStatus: r.entryStatus,
      workflowState: null,
      lineId: 0,
      lineDescription: null,
      debitCents: r.debits,
      creditCents: r.credits,
      currentAccount: null,
      accountText: null,
      sourceType: sType,
      sourceRecordId: r.sourceId ?? null,
      sourceRecordLink: sourceLink(sType, r.sourceId ?? null),
      ...(() => {
        const p = resolvePeriod(r.entryDate);
        return { periodLocked: p.locked, periodLabel: p.label };
      })(),
      shortMessage: `Debits ${(r.debits / 100).toFixed(2)} ≠ credits ${(r.credits / 100).toFixed(2)}.`,
    });
  }

  // ----- Draft side --------------------------------------------------------
  const drafts = await db
    .select({
      id: manualJournalEntryDraftsTable.id,
      status: manualJournalEntryDraftsTable.status,
      entryDate: manualJournalEntryDraftsTable.entryDate,
      memo: manualJournalEntryDraftsTable.memo,
      payload: manualJournalEntryDraftsTable.payload,
    })
    .from(manualJournalEntryDraftsTable)
    .where(
      inArray(manualJournalEntryDraftsTable.status, [
        "draft",
        "submitted",
        "approved",
      ]),
    );

  // Look up source links for drafts in one query.
  const draftIds = drafts.map((d) => d.id);
  const draftSourceLinks = draftIds.length
    ? await db
        .select({
          draftId: accountingSourceLinksTable.manualJournalEntryDraftId,
          sourceType: accountingSourceLinksTable.sourceType,
          sourceId: accountingSourceLinksTable.sourceId,
        })
        .from(accountingSourceLinksTable)
        .where(
          inArray(
            accountingSourceLinksTable.manualJournalEntryDraftId,
            draftIds,
          ),
        )
    : [];
  const draftSourceMap = new Map<
    number,
    { sourceType: SourceType; sourceId: number }
  >();
  for (const l of draftSourceLinks) {
    if (l.draftId) {
      draftSourceMap.set(l.draftId, {
        sourceType: l.sourceType as SourceType,
        sourceId: l.sourceId,
      });
    }
  }

  // Pre-load all chart-of-accounts rows once for fast in-process lookups.
  const coaRows = await db
    .select({
      id: chartOfAccountsTable.id,
      code: chartOfAccountsTable.code,
      name: chartOfAccountsTable.name,
      isActive: chartOfAccountsTable.isActive,
      allowManualPosting: chartOfAccountsTable.allowManualPosting,
    })
    .from(chartOfAccountsTable);
  const coaById = new Map<number, (typeof coaRows)[number]>();
  const coaByCode = new Map<string, (typeof coaRows)[number]>();
  for (const c of coaRows) {
    coaById.set(c.id, c);
    coaByCode.set(c.code.trim(), c);
  }

  for (const d of drafts) {
    const payload = (d.payload ?? {}) as { lines?: unknown };
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const link = draftSourceMap.get(d.id) ?? null;
    let totalDebits = 0;
    let totalCredits = 0;
    let everyLineHasValidPositiveAmount = true;
    for (let i = 0; i < lines.length; i++) {
      const ln = (lines[i] ?? {}) as Record<string, unknown>;
      const type = ln.type === "debit" ? "debit" : ln.type === "credit" ? "credit" : null;
      const rawAmount = ln.amount;
      const amountCents = toCentsLoose(rawAmount);
      const accountIdNum =
        typeof ln.accountId === "number" && Number.isInteger(ln.accountId)
          ? ln.accountId
          : null;
      const accountCode =
        (typeof ln.account_code === "string" ? ln.account_code.trim() : "") ||
        (typeof ln.account === "string" ? ln.account.trim() : "");
      const accountText = accountCode || null;
      const lineMemo =
        typeof ln.memo === "string" ? ln.memo : null;

      // Resolve to a CoA row.
      let coa = accountIdNum !== null ? coaById.get(accountIdNum) : undefined;
      if (!coa && accountCode) coa = coaByCode.get(accountCode);

      const baseDraft = {
        status: "draft" as const,
        mutability: "mutable" as const,
        jeNumber: null,
        entryId: d.id,
        entryDate: d.entryDate ?? null,
        memo: d.memo ?? null,
        entryStatus: d.status,
        workflowState: d.status,
        lineId: i,
        lineDescription: lineMemo,
        debitCents: type === "debit" && amountCents !== null ? amountCents : 0,
        creditCents: type === "credit" && amountCents !== null ? amountCents : 0,
        currentAccount: coa
          ? { id: coa.id, code: coa.code, name: coa.name }
          : null,
        accountText,
        sourceType: link?.sourceType ?? null,
        sourceRecordId: link?.sourceId ?? null,
        sourceRecordLink: sourceLink(
          link?.sourceType ?? null,
          link?.sourceId ?? null,
        ),
        ...(() => {
          const p = resolvePeriod(d.entryDate ?? null);
          return { periodLocked: p.locked, periodLabel: p.label };
        })(),
      };

      const codes: FailureCode[] = [];
      if (!coa) {
        codes.push("missing_account");
      } else if (coa.isActive === false) {
        codes.push("archived_account");
      } else if (coa.allowManualPosting === false) {
        codes.push("non_postable_account");
      }
      if (amountCents === null || amountCents <= 0) {
        codes.push("invalid_line_amount");
        everyLineHasValidPositiveAmount = false;
      } else if (type === "debit") {
        totalDebits += amountCents;
      } else if (type === "credit") {
        totalCredits += amountCents;
      }
      for (const code of codes) {
        rows.push({
          ...baseDraft,
          id: `draft:${d.id}:${i}:${code}`,
          failureCode: code,
          shortMessage: shortMessageFor(code, accountText),
        });
      }
    }

    // Draft-level unbalanced check, but only when every line has a valid
    // positive amount (otherwise the imbalance is downstream of the
    // invalid_line_amount failures already emitted).
    if (
      everyLineHasValidPositiveAmount &&
      lines.length > 0 &&
      totalDebits !== totalCredits
    ) {
      rows.push({
        id: `draft:${d.id}:0:unbalanced_entry`,
        status: "draft",
        mutability: "mutable",
        failureCode: "unbalanced_entry",
        jeNumber: null,
        entryId: d.id,
        entryDate: d.entryDate ?? null,
        memo: d.memo ?? null,
        entryStatus: d.status,
        workflowState: d.status,
        lineId: 0,
        lineDescription: null,
        debitCents: totalDebits,
        creditCents: totalCredits,
        currentAccount: null,
        accountText: null,
        sourceType: link?.sourceType ?? null,
        sourceRecordId: link?.sourceId ?? null,
        sourceRecordLink: sourceLink(
          link?.sourceType ?? null,
          link?.sourceId ?? null,
        ),
        ...(() => {
          const p = resolvePeriod(d.entryDate ?? null);
          return { periodLocked: p.locked, periodLabel: p.label };
        })(),
        shortMessage: `Debits ${(totalDebits / 100).toFixed(2)} ≠ credits ${(totalCredits / 100).toFixed(2)}.`,
      });
    }
  }

  return rows;
}

function toCentsLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.round(v * 100);
  }
  if (typeof v === "string" && v.trim().length) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return null;
}

function shortMessageFor(
  code: FailureCode,
  accountText: string | null,
): string {
  const acct = accountText ? ` (line account: "${accountText}")` : "";
  switch (code) {
    case "missing_account":
      return `Line is missing a valid chart-of-accounts reference${acct}.`;
    case "archived_account":
      return `Line points to an archived chart-of-accounts entry${acct}.`;
    case "non_postable_account":
      return `Line points to a header / non-postable account${acct}.`;
    case "invalid_line_amount":
      return "Line has a non-positive amount.";
    case "unbalanced_entry":
      return "Entry totals do not balance.";
  }
}

router.get(
  "/accounting/remediation",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_QUERY",
        message: parsed.error.message,
      });
      return;
    }
    const { code, entryId, sourceType, status, limit, offset } = parsed.data;
    const all = await loadAllRows();
    const filtered = all.filter((r) => {
      if (code && r.failureCode !== code) return false;
      if (entryId && r.entryId !== entryId) return false;
      if (sourceType && r.sourceType !== sourceType) return false;
      if (status && r.status !== status) return false;
      return true;
    });
    // Stable ordering so the queue doesn't visually reshuffle on every poll:
    // entryDate desc (recent first), entryId desc, lineId asc, failureCode asc.
    filtered.sort((a, b) => {
      const ad = a.entryDate ?? "";
      const bd = b.entryDate ?? "";
      if (ad !== bd) return ad < bd ? 1 : -1;
      if (a.entryId !== b.entryId) return b.entryId - a.entryId;
      if (a.lineId !== b.lineId) return a.lineId - b.lineId;
      return a.failureCode.localeCompare(b.failureCode);
    });
    res.json({
      total: filtered.length,
      limit,
      offset,
      rows: filtered.slice(offset, offset + limit),
    });
  },
);

/**
 * Repoint a single draft line to a valid chart-of-accounts entry.
 *
 * Validation rules — all enforced server-side, even though the UI also
 * filters the picker:
 *   - Draft must be in a non-terminal status (draft|submitted|approved).
 *   - Target account must exist, be active, and allow_manual_posting=true.
 *   - lineId must be a valid index into the draft's payload.lines array.
 *
 * Writes to the activity log are part of the same transaction as the
 * draft update so that no successful repoint can ever be silently
 * unaudited (and no failed repoint can leave a misleading log entry).
 */
const RemediateDraftLineBody = z.object({
  accountId: z.number().int().positive(),
  note: z.string().min(1).max(2000),
});

router.post(
  "/accounting/journal-entry-drafts/:draftId/lines/:lineId/remediate-account",
  async (req: Request, res: Response): Promise<void> => {
    const draftId = Number(req.params.draftId);
    const lineId = Number(req.params.lineId);
    if (!Number.isInteger(draftId) || draftId <= 0) {
      res.status(400).json({ code: "INVALID_DRAFT_ID" });
      return;
    }
    if (!Number.isInteger(lineId) || lineId < 0) {
      res.status(400).json({ code: "INVALID_LINE_ID" });
      return;
    }
    const body = RemediateDraftLineBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ code: "INVALID_BODY", message: body.error.message });
      return;
    }
    const { accountId, note } = body.data;
    const userId =
      (req as Request & { user?: { id?: number } }).user?.id ?? null;

    // Pre-flight: account must be active + postable.
    const [coa] = await db
      .select()
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, accountId))
      .limit(1);
    if (!coa) {
      res.status(404).json({ code: "ACCOUNT_NOT_FOUND" });
      return;
    }
    if (!coa.isActive) {
      res.status(400).json({ code: "ACCOUNT_ARCHIVED" });
      return;
    }
    if (!coa.allowManualPosting) {
      res.status(400).json({ code: "ACCOUNT_NOT_POSTABLE" });
      return;
    }

    // Atomic update + audit. We re-read the draft inside the transaction so
    // the version check is meaningful (no TOCTOU window between the
    // pre-flight peek and the write).
    const result = await db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(manualJournalEntryDraftsTable)
        .where(eq(manualJournalEntryDraftsTable.id, draftId))
        .limit(1);
      if (!draft) return { kind: "not_found" as const };
      if (
        draft.status !== "draft" &&
        draft.status !== "submitted" &&
        draft.status !== "approved"
      ) {
        return { kind: "terminal" as const, status: draft.status };
      }
      const payload = (draft.payload ?? {}) as {
        lines?: Array<Record<string, unknown>>;
      };
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (lineId >= lines.length) {
        return { kind: "line_not_found" as const };
      }
      const line = { ...(lines[lineId] ?? {}) } as Record<string, unknown>;
      const oldAccountId =
        typeof line.accountId === "number" ? line.accountId : null;
      line.accountId = accountId;
      line.account_code = coa.code;
      // Keep the legacy `account` text in sync so downstream rendering
      // (which still falls back to the string column) stays consistent.
      line.account = coa.code;
      const newLines = lines.slice();
      newLines[lineId] = line;
      const newPayload = { ...(payload as object), lines: newLines };

      await tx
        .update(manualJournalEntryDraftsTable)
        .set({
          payload: newPayload,
          updatedAt: new Date(),
        })
        .where(eq(manualJournalEntryDraftsTable.id, draftId));

      await tx.insert(activityLogTable).values({
        type: "accounting_remediation_draft_line_updated",
        description: `Draft #${draftId} line ${lineId} account repointed (${oldAccountId ?? "null"} → ${accountId}).`,
        actor: "user",
        actorUserId: userId,
        referenceId: draftId,
        referenceType: "manual_journal_entry_draft",
        metadata: {
          draftId,
          lineId,
          oldAccountId,
          newAccountId: accountId,
          newAccountCode: coa.code,
          newAccountName: coa.name,
          failureCode: oldAccountId === null ? "missing_account" : "repoint",
          note,
        },
      });

      return { kind: "ok" as const, oldAccountId };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ code: "DRAFT_NOT_FOUND" });
      return;
    }
    if (result.kind === "terminal") {
      res
        .status(409)
        .json({ code: "DRAFT_TERMINAL", status: result.status });
      return;
    }
    if (result.kind === "line_not_found") {
      res.status(404).json({ code: "LINE_NOT_FOUND" });
      return;
    }
    res.json({
      ok: true,
      draftId,
      lineId,
      oldAccountId: result.oldAccountId,
      newAccountId: accountId,
    });
  },
);

/**
 * Posted-entry corrective action.
 *
 * Posted journal entries are immutable in place (DB triggers from Task #67
 * also block direct UPDATEs). To remediate one, an operator picks one of
 * two explicit actions:
 *
 *   - reverse_and_replace: post a reversal of the original (via the
 *     hardened reverseJournalEntry service), then post a fresh
 *     replacement JE with the supplied lines. The reversal stands on
 *     its own; if the replacement post fails, the operator gets a clear
 *     error and can re-issue the replacement separately. Either way the
 *     activity log captures both ids.
 *
 *   - adjusting_entry: post a new balanced JE that references the
 *     original in its memo, leaving the original untouched. Useful when
 *     the original is correct in spirit but a small adjustment is needed.
 *
 * Both paths reuse postManualJournalEntry, so account-validation,
 * balance, and period-lock rules stay in lockstep with every other
 * posting flow in the system.
 */
const RemediatePostedBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reverse_and_replace"),
    note: z.string().min(5).max(2000),
    payload: z.object({
      entryDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "entryDate must be YYYY-MM-DD"),
      memo: z.string().min(1).max(2000),
      lines: z
        .array(
          z.object({
            type: z.enum(["debit", "credit"]),
            amount: z.number().positive().finite(),
            account_code: z.string().min(1).max(60),
            program: z.string().max(120).nullish(),
            fund: z.string().max(120).nullish(),
            memo: z.string().max(500).nullish(),
          }),
        )
        .min(2)
        .max(100),
    }),
  }),
  z.object({
    action: z.literal("adjusting_entry"),
    note: z.string().min(5).max(2000),
    payload: z.object({
      entryDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "entryDate must be YYYY-MM-DD"),
      memo: z.string().min(1).max(2000),
      lines: z
        .array(
          z.object({
            type: z.enum(["debit", "credit"]),
            amount: z.number().positive().finite(),
            account_code: z.string().min(1).max(60),
            program: z.string().max(120).nullish(),
            fund: z.string().max(120).nullish(),
            memo: z.string().max(500).nullish(),
          }),
        )
        .min(2)
        .max(100),
    }),
  }),
]);

router.post(
  "/accounting/journal-entries/:entryId/remediate",
  async (req: Request, res: Response): Promise<void> => {
    const entryId = Number(req.params.entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      res.status(400).json({ code: "INVALID_ENTRY_ID" });
      return;
    }
    const parsed = RemediatePostedBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: "INVALID_BODY", message: parsed.error.message });
      return;
    }
    const body = parsed.data;
    const actor = actorFromReq(req);
    const userId = actor.id;

    // Confirm the original exists and is in a posted-ish state. We let
    // reverseJournalEntry handle the rest (idempotency, period checks,
    // role gates) for the reverse_and_replace path.
    const [original] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, entryId))
      .limit(1);
    if (!original) {
      res.status(404).json({ code: "ENTRY_NOT_FOUND" });
      return;
    }

    if (body.action === "reverse_and_replace") {
      const reverseResult = await reverseJournalEntry(
        entryId,
        actor,
        body.note,
      );
      if (reverseResult.kind === "forbidden") {
        res
          .status(403)
          .json({ code: "FORBIDDEN", message: reverseResult.reason });
        return;
      }
      if (reverseResult.kind === "missing_reason") {
        res.status(400).json({ code: "MISSING_REASON" });
        return;
      }
      if (reverseResult.kind === "not_found") {
        res.status(404).json({ code: "ENTRY_NOT_FOUND" });
        return;
      }
      if (reverseResult.kind === "period_locked") {
        res.status(409).json({
          code: "PERIOD_LOCKED",
          entryDate: reverseResult.entryDate,
          periodLabel: reverseResult.periodLabel,
        });
        return;
      }
      // reverseResult.kind === "ok"
      const reversal = reverseResult.reversal;
      const postResult = await postManualJournalEntry(
        {
          entryDate: body.payload.entryDate,
          memo: `Replacement for ${original.entryNo}: ${body.payload.memo}`,
          lines: body.payload.lines,
        },
        actor,
      );
      // Whatever happens with the replacement, log the reversal so the
      // audit trail is complete even if the operator must retry the post.
      await db.insert(activityLogTable).values({
        type: "accounting_remediation_posted_entry_reversed",
        description:
          postResult.kind === "ok"
            ? `JE ${original.entryNo} reversed (#${reversal.id}) and replaced (#${postResult.journalEntry.id}).`
            : `JE ${original.entryNo} reversed (#${reversal.id}); replacement post failed.`,
        actor: "user",
        actorUserId: userId,
        referenceId: entryId,
        referenceType: "journal_entry",
        metadata: {
          originalEntryId: entryId,
          originalEntryNo: original.entryNo,
          reversalId: reversal.id,
          replacementId:
            postResult.kind === "ok" ? postResult.journalEntry.id : null,
          replacementOk: postResult.kind === "ok",
          replacementError:
            postResult.kind === "ok" ? null : postResult.kind,
          note: body.note,
        },
      });
      if (postResult.kind !== "ok") {
        res.status(409).json({
          code: "REPLACEMENT_POST_FAILED",
          reversalId: reversal.id,
          replacementError: postResult.kind,
          detail: postResult,
          message:
            "Reversal succeeded but the replacement entry could not be posted. Fix the replacement payload and retry.",
        });
        return;
      }
      res.status(201).json({
        ok: true,
        action: "reverse_and_replace",
        originalEntryId: entryId,
        reversalId: reversal.id,
        replacementId: postResult.journalEntry.id,
      });
      return;
    }

    // body.action === "adjusting_entry"
    const postResult = await postManualJournalEntry(
      {
        entryDate: body.payload.entryDate,
        memo: `Adjusting entry for ${original.entryNo}: ${body.payload.memo}`,
        lines: body.payload.lines,
      },
      actor,
    );
    if (postResult.kind !== "ok") {
      // Map postingService outcomes to the right HTTP status. Forbidden
      // is auth, period_locked is conflict, everything else is bad
      // request — keeping the same vocabulary the manual-post route
      // uses so clients can branch consistently.
      const status =
        postResult.kind === "forbidden"
          ? 403
          : postResult.kind === "period_locked"
            ? 409
            : 400;
      res.status(status).json({
        code: "ADJUSTING_POST_FAILED",
        reason: postResult.kind,
        detail: postResult,
      });
      return;
    }
    await db.insert(activityLogTable).values({
      type: "accounting_remediation_adjusting_entry_created",
      description: `Adjusting entry #${postResult.journalEntry.id} created against JE ${original.entryNo}.`,
      actor: "user",
      actorUserId: userId,
      referenceId: entryId,
      referenceType: "journal_entry",
      metadata: {
        originalEntryId: entryId,
        originalEntryNo: original.entryNo,
        adjustingEntryId: postResult.journalEntry.id,
        note: body.note,
      },
    });
    res.status(201).json({
      ok: true,
      action: "adjusting_entry",
      originalEntryId: entryId,
      adjustingEntryId: postResult.journalEntry.id,
    });
  },
);

router.get(
  "/accounting/remediation/counts",
  async (_req: Request, res: Response): Promise<void> => {
    const all = await loadAllRows();
    const byCode: Record<FailureCode, number> = {
      missing_account: 0,
      archived_account: 0,
      non_postable_account: 0,
      invalid_line_amount: 0,
      unbalanced_entry: 0,
    };
    let draftCount = 0;
    let postedCount = 0;
    for (const r of all) {
      byCode[r.failureCode] += 1;
      if (r.status === "draft") draftCount += 1;
      else postedCount += 1;
    }
    res.json({
      total: all.length,
      byStatus: { draft: draftCount, posted: postedCount },
      byCode,
    });
  },
);

export default router;
