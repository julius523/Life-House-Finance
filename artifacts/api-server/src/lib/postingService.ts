/**
 * Step 8 — Controlled ledger posting service.
 *
 * This module owns the rules for moving an approved
 * `agent_actions.draft_journal_entry` into the real ledger
 * (`journal_entries` + `journal_entry_lines`), and for posting
 * reversal entries.
 *
 * Hard rules implemented here (per Step 8 non-negotiables):
 *   - Posting is server-side only and requires admin or approver.
 *   - Posting is idempotent at two layers:
 *       (1) application: short-circuit if `postedJournalEntryId` is set;
 *       (2) database: UNIQUE partial index on `journal_entries.agent_action_id`.
 *   - Period locks block posting (and reversal) into closed periods.
 *   - Every posted JE links: thread, assistant message, approver, agent
 *     action id, and a frozen evidence snapshot.
 *   - Reversal creates a NEW JE with swapped debit/credit lines and links
 *     both ways. The original is flipped to `status='reversed'`. We never
 *     mutate or delete posted line items.
 *
 * The result type uses a discriminated union so route handlers can map
 * each case to the right HTTP code without re-parsing strings.
 */

import { sql, and, eq, lte, gte, inArray } from "drizzle-orm";
import {
  db,
  agentActionsTable,
  accountingPeriodsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  chartOfAccountsTable,
  activityLogTable,
  type AgentActionRow,
  type JournalEntryRow,
  type JournalEntryLineRow,
} from "@workspace/db";
import { extractCodeFromLegacyAccountString } from "./seedChartOfAccounts";

export type PostingActor = {
  id: number;
  role: "admin" | "approver" | "submitter";
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

type JournalLineInput = {
  type: "debit" | "credit";
  amount: unknown;
  account?: unknown;
  account_code?: unknown;
  accountId?: unknown;
  program?: unknown;
  fund?: unknown;
  memo?: unknown;
};

type ResolvedJournalLine = {
  type: "debit" | "credit";
  amount: number;
  account: string;
  /** Step 9: resolved & validated CoA row for this line. */
  accountId: number;
  program: string | null;
  fund: string | null;
  memo: string | null;
};

export type PostJournalEntryResult =
  | {
      kind: "ok";
      idempotent: boolean;
      journalEntry: JournalEntryRow;
      lines: JournalEntryLineRow[];
      agentAction: AgentActionRow;
    }
  | { kind: "not_found" }
  | { kind: "wrong_action_type"; actionType: string }
  | { kind: "not_approved"; status: string }
  | { kind: "forbidden"; reason: string }
  | { kind: "invalid_payload"; reason: string }
  | { kind: "unbalanced"; debitsCents: number; creditsCents: number }
  | {
      kind: "invalid_account";
      lineNo: number;
      account: string;
      reason:
        | "unknown_account"
        | "archived_account"
        | "manual_posting_disabled";
    }
  | {
      kind: "period_locked";
      entryDate: string;
      periodLabel: string | null;
    };

export type ReverseJournalEntryResult =
  | {
      kind: "ok";
      idempotent: boolean;
      original: JournalEntryRow;
      reversal: JournalEntryRow;
      reversalLines: JournalEntryLineRow[];
    }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string }
  | { kind: "missing_reason" }
  | {
      kind: "period_locked";
      entryDate: string;
      periodLabel: string | null;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSTING_ALLOWED_ROLES: ReadonlyArray<PostingActor["role"]> = [
  "admin",
  "approver",
];
const REVERSAL_ALLOWED_ROLES: ReadonlyArray<PostingActor["role"]> = ["admin"];

function toCents(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function todayIsoDate(): string {
  // Use UTC date to avoid timezone-dependent off-by-one between server
  // and database. Reversal "today" = UTC today.
  return new Date().toISOString().slice(0, 10);
}

function yearOfIsoDate(iso: string): number {
  // "YYYY-MM-DD" → YYYY
  return Number(iso.slice(0, 4));
}

/**
 * Find the accounting period that covers `entryDate`. Returns null if no
 * period covers the date — callers MUST treat that as a posting block, not
 * a permissive default. Step 8 is fail-closed about period coverage.
 */
async function findCoveringPeriod(
  tx: typeof db,
  entryDate: string,
): Promise<{ id: number; label: string; status: string } | null> {
  // FOR UPDATE locks the period row for the lifetime of this transaction so
  // a concurrent `POST /periods/:id/close` cannot flip the status from `open`
  // to `closed` between our check and our INSERT. The close endpoint takes a
  // FOR UPDATE row lock (via `SELECT ... FOR UPDATE` before its UPDATE) on
  // the same row, which means a posting tx that wins the lock first either
  // commits (and the close blocks until done, then sees status='posted'
  // history) or aborts (and the close proceeds). Either way, we never post
  // into a period that has already committed `closed`.
  const result = (await tx.execute(sql`
    SELECT id, label, status
    FROM accounting_periods
    WHERE period_start <= ${entryDate}
      AND period_end >= ${entryDate}
    LIMIT 1
    FOR UPDATE
  `)) as unknown as {
    rows: Array<{ id: number; label: string; status: string }>;
  };
  return result.rows?.[0] ?? null;
}

/**
 * Allocate the next entry number for a given year. We use a per-year
 * Postgres advisory transaction lock so concurrent postings serialize on
 * the allocation step only, not the whole table. The lock is released
 * automatically at end of transaction.
 */
async function allocateEntryNo(
  tx: typeof db,
  year: number,
): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${year})`);
  const prefix = `JE-${year}-`;
  const startPos = prefix.length + 1;
  const result = (await tx.execute(sql`
    SELECT COALESCE(
      MAX(CAST(SUBSTRING(entry_no FROM ${sql.raw(String(startPos))}) AS INTEGER)),
      0
    ) AS max_no
    FROM journal_entries
    WHERE entry_no LIKE ${prefix + "%"}
  `)) as unknown as { rows: Array<{ max_no: number | string | null }> };
  const maxNo = Number(result.rows?.[0]?.max_no ?? 0);
  const next = (Number.isFinite(maxNo) ? maxNo : 0) + 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

type SanitizeResult =
  | { ok: true; lines: ResolvedJournalLine[] }
  | { ok: false; reason: string }
  | {
      ok: false;
      kind: "invalid_account";
      lineNo: number;
      account: string;
      accountReason:
        | "unknown_account"
        | "archived_account"
        | "manual_posting_disabled";
    };

/**
 * Step 9 — sanitize + resolve every line against the live Chart of Accounts.
 * Loads each distinct account string in a single query and returns the
 * resolved CoA id alongside the immutable `account` text. Rejects unknown
 * accounts, archived accounts, and accounts with allow_manual_posting=false.
 */
// Drizzle's transaction object exposes the same query-builder surface
// as `db` but is a different concrete type. We model only what
// sanitizeLines actually uses (a `select(...).from(...).where(...)`
// chain) so callers can pass either `db` or a `tx` without an
// `as unknown as typeof db` escape hatch.
type DbReader = Pick<typeof db, "select">;

async function sanitizeLines(
  tx: DbReader,
  rawLines: unknown,
): Promise<SanitizeResult> {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { ok: false, reason: "JE payload has no lines." };
  }
  type Pending = {
    lineNo: number;
    type: "debit" | "credit";
    cents: number;
    accountId: number | null;
    accountRaw: string;
    accountKey: string | null;
    program: string | null;
    fund: string | null;
    memo: string | null;
  };
  const pending: Pending[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] as JournalLineInput;
    const lineNo = i + 1;
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: `Line ${lineNo} is not an object.` };
    }
    if (raw.type !== "debit" && raw.type !== "credit") {
      return { ok: false, reason: `Line ${lineNo} has invalid type.` };
    }
    // Step 9 — accept three identifier shapes, in priority order:
    //   (1) numeric `accountId` — direct CoA primary key (most precise)
    //   (2) `account_code` — preferred string code from copilot drafts
    //   (3) legacy `account` free-text field (back-compat for old payloads)
    const accountIdNum =
      typeof raw.accountId === "number" && Number.isInteger(raw.accountId)
        ? raw.accountId
        : null;
    const codeStr =
      typeof raw.account_code === "string" && raw.account_code.trim().length
        ? raw.account_code.trim()
        : typeof raw.account === "string" && raw.account.trim().length
          ? raw.account.trim()
          : null;
    if (accountIdNum === null && !codeStr) {
      return {
        ok: false,
        reason: `Line ${lineNo} is missing an account_id or account_code.`,
      };
    }
    const cents = toCents(raw.amount);
    if (cents === null || cents <= 0) {
      return {
        ok: false,
        reason: `Line ${lineNo} has invalid amount; must be positive.`,
      };
    }
    const accountRaw = codeStr ?? `#${accountIdNum}`;
    const accountKey =
      codeStr === null
        ? null
        : (extractCodeFromLegacyAccountString(accountRaw) ?? accountRaw);
    pending.push({
      lineNo,
      type: raw.type,
      cents,
      accountId: accountIdNum,
      accountRaw,
      accountKey,
      program: typeof raw.program === "string" ? raw.program : null,
      fund: typeof raw.fund === "string" ? raw.fund : null,
      memo: typeof raw.memo === "string" ? raw.memo : null,
    });
  }

  // Bulk-lookup: by id when provided, otherwise by code.
  const distinctIds = Array.from(
    new Set(
      pending
        .map((p) => p.accountId)
        .filter((x): x is number => x !== null),
    ),
  );
  const distinctCodes = Array.from(
    new Set(
      pending
        .map((p) => p.accountKey)
        .filter((x): x is string => x !== null),
    ),
  );
  const [byIdRows, byCodeRows] = await Promise.all([
    distinctIds.length
      ? tx
          .select({
            id: chartOfAccountsTable.id,
            code: chartOfAccountsTable.code,
            isActive: chartOfAccountsTable.isActive,
            allowManualPosting: chartOfAccountsTable.allowManualPosting,
          })
          .from(chartOfAccountsTable)
          .where(inArray(chartOfAccountsTable.id, distinctIds))
      : Promise.resolve([] as Array<{ id: number; code: string; isActive: boolean; allowManualPosting: boolean }>),
    distinctCodes.length
      ? tx
          .select({
            id: chartOfAccountsTable.id,
            code: chartOfAccountsTable.code,
            isActive: chartOfAccountsTable.isActive,
            allowManualPosting: chartOfAccountsTable.allowManualPosting,
          })
          .from(chartOfAccountsTable)
          .where(inArray(chartOfAccountsTable.code, distinctCodes))
      : Promise.resolve([] as Array<{ id: number; code: string; isActive: boolean; allowManualPosting: boolean }>),
  ]);
  const byId = new Map(byIdRows.map((r) => [r.id, r]));
  const byCode = new Map(byCodeRows.map((r) => [r.code, r]));

  const resolved: ResolvedJournalLine[] = [];
  for (const p of pending) {
    const hit =
      (p.accountId !== null ? byId.get(p.accountId) : undefined) ??
      (p.accountKey !== null ? byCode.get(p.accountKey) : undefined);
    if (!hit) {
      return {
        ok: false,
        kind: "invalid_account",
        lineNo: p.lineNo,
        account: p.accountRaw,
        accountReason: "unknown_account",
      };
    }
    if (!hit.isActive) {
      return {
        ok: false,
        kind: "invalid_account",
        lineNo: p.lineNo,
        account: p.accountRaw,
        accountReason: "archived_account",
      };
    }
    if (!hit.allowManualPosting) {
      return {
        ok: false,
        kind: "invalid_account",
        lineNo: p.lineNo,
        account: p.accountRaw,
        accountReason: "manual_posting_disabled",
      };
    }
    resolved.push({
      type: p.type,
      amount: p.cents / 100,
      account: p.accountRaw,
      accountId: hit.id,
      program: p.program,
      fund: p.fund,
      memo: p.memo,
    });
  }
  return { ok: true, lines: resolved };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export async function postApprovedJournalEntry(
  agentActionId: number,
  actor: PostingActor,
): Promise<PostJournalEntryResult> {
  if (!POSTING_ALLOWED_ROLES.includes(actor.role)) {
    return {
      kind: "forbidden",
      reason: `Role '${actor.role}' is not allowed to post journal entries. Allowed roles: ${POSTING_ALLOWED_ROLES.join(", ")}.`,
    };
  }

  return db.transaction(async (tx) => {
    const [action] = await tx
      .select()
      .from(agentActionsTable)
      .where(eq(agentActionsTable.id, agentActionId))
      .for("update");
    if (!action) return { kind: "not_found" as const };
    if (action.actionType !== "draft_journal_entry") {
      return {
        kind: "wrong_action_type" as const,
        actionType: action.actionType,
      };
    }
    if (action.status !== "approved") {
      return { kind: "not_approved" as const, status: action.status };
    }
    // Belt-and-suspenders: even though approval is already enforced to not
    // be self-approval, the submitter must not be the one who clicks
    // "post" on their own draft either. This keeps the maker/checker
    // separation through the entire chain.
    if (action.userId === actor.id) {
      return {
        kind: "forbidden" as const,
        reason:
          "You cannot post a journal entry that you submitted yourself. Ask another reviewer to post it.",
      };
    }

    // ---------- Idempotency short-circuit -----------------------------------
    if (action.postedJournalEntryId) {
      const [existing] = await tx
        .select()
        .from(journalEntriesTable)
        .where(eq(journalEntriesTable.id, action.postedJournalEntryId));
      if (existing) {
        const lines = await tx
          .select()
          .from(journalEntryLinesTable)
          .where(eq(journalEntryLinesTable.journalEntryId, existing.id));
        return {
          kind: "ok" as const,
          idempotent: true,
          journalEntry: existing,
          lines,
          agentAction: action,
        };
      }
      // Linkage column was populated but the JE is gone — refuse to
      // re-create silently. Treat as a hard error rather than overwriting.
      return {
        kind: "invalid_payload" as const,
        reason: `Agent action #${action.id} is linked to a missing journal entry (#${action.postedJournalEntryId}). Refusing to re-post.`,
      };
    }

    // ---------- Validate payload -------------------------------------------
    const payload = (action.payload ?? {}) as Record<string, unknown>;
    const entryDate = payload["date"];
    const memo = payload["memo"];
    if (typeof entryDate !== "string" || entryDate.length < 10) {
      return {
        kind: "invalid_payload" as const,
        reason: "Draft is missing a valid entry date.",
      };
    }
    if (typeof memo !== "string" || memo.length === 0) {
      return {
        kind: "invalid_payload" as const,
        reason: "Draft is missing a memo.",
      };
    }
    const sanitized = await sanitizeLines(
      tx,
      payload["lines"],
    );
    if (!sanitized.ok) {
      if ("kind" in sanitized && sanitized.kind === "invalid_account") {
        return {
          kind: "invalid_account" as const,
          lineNo: sanitized.lineNo,
          account: sanitized.account,
          reason: sanitized.accountReason,
        };
      }
      return { kind: "invalid_payload" as const, reason: sanitized.reason };
    }
    const lines = sanitized.lines;

    // Re-check balance in cents at posting time (defence-in-depth).
    let debitsCents = 0;
    let creditsCents = 0;
    for (const ln of lines) {
      const cents = toCents(ln.amount)!;
      if (ln.type === "debit") debitsCents += cents;
      else creditsCents += cents;
    }
    if (debitsCents !== creditsCents) {
      return {
        kind: "unbalanced" as const,
        debitsCents,
        creditsCents,
      };
    }

    // ---------- Period lock --------------------------------------------------
    const period = await findCoveringPeriod(tx as unknown as typeof db, entryDate);
    if (!period || period.status !== "open") {
      return {
        kind: "period_locked" as const,
        entryDate,
        periodLabel: period?.label ?? null,
      };
    }

    // ---------- Allocate entry no & insert JE -------------------------------
    const entryNo = await allocateEntryNo(
      tx as unknown as typeof db,
      yearOfIsoDate(entryDate),
    );

    const evidenceSnapshot = {
      payload_at_posting: payload,
      evidence_at_posting: action.evidence ?? null,
      confidence: action.confidence ?? null,
      risk_flags: action.riskFlags ?? null,
      submitter_user_id: action.userId,
      approver: {
        user_id: action.reviewedBy,
        reviewed_at: action.reviewedAt
          ? action.reviewedAt.toISOString()
          : null,
        review_notes: action.reviewNotes ?? null,
      },
      poster: {
        user_id: actor.id,
        role: actor.role,
        email: actor.email,
      },
      snapshot_taken_at: new Date().toISOString(),
    };

    const [je] = await tx
      .insert(journalEntriesTable)
      .values({
        entryNo,
        entryDate,
        memo,
        totalsDebitsCents: debitsCents,
        totalsCreditsCents: creditsCents,
        status: "posted",
        postedByUserId: actor.id,
        agentActionId: action.id,
        threadId: action.threadId,
        assistantMessageId: action.assistantMessageId,
        approverUserId: action.reviewedBy,
        evidenceSnapshot,
      })
      .returning();

    const lineRows = await tx
      .insert(journalEntryLinesTable)
      .values(
        lines.map((ln, i) => ({
          journalEntryId: je!.id,
          lineNo: i + 1,
          type: ln.type,
          amountCents: toCents(ln.amount)!,
          account: ln.account,
          accountId: ln.accountId,
          program: ln.program,
          fund: ln.fund,
          memo: ln.memo,
        })),
      )
      .returning();

    const updatedPayload = {
      ...payload,
      ledger_posted: true,
      posted_journal_entry_id: je!.id,
      posted_journal_entry_no: je!.entryNo,
      posting_outcome: `Posted to ledger as ${je!.entryNo} on ${je!.postedAt.toISOString()}.`,
    };

    const [updatedAction] = await tx
      .update(agentActionsTable)
      .set({
        postedJournalEntryId: je!.id,
        payload: updatedPayload,
      })
      .where(eq(agentActionsTable.id, action.id))
      .returning();

    await tx.insert(activityLogTable).values({
      type: "journal_entry_posted",
      description: `${actor.firstName ?? ""} ${actor.lastName ?? ""} posted ${je!.entryNo} (${(debitsCents / 100).toFixed(2)}) from agent_action #${action.id}`,
      actor: `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || actor.email || `user#${actor.id}`,
      referenceId: je!.id,
      referenceType: "journal_entry",
    });

    return {
      kind: "ok" as const,
      idempotent: false,
      journalEntry: je!,
      lines: lineRows,
      agentAction: updatedAction!,
    };
  });
}

// ---------------------------------------------------------------------------
// Manual posting (no agent_action — staff entered the JE by hand)
// ---------------------------------------------------------------------------

export type ManualJournalEntryInput = {
  entryDate: string;
  memo: string;
  lines: unknown;
  /**
   * Task 25A — required for the HTTP route. Service-level callers (tests,
   * future internal flows) may pass null to opt out of idempotency, but
   * the route layer enforces presence. When set, two requests with the
   * same key MUST resolve to the same JE (replay) or 409 (conflict).
   */
  idempotencyKey?: string | null;
  /**
   * Task 25A — caller-computed stable fingerprint of the logical payload
   * (date + memo + normalized sorted lines). Used to detect "same key,
   * different payload" conflicts on replay. The route computes this so
   * the service does not have to know the wire format.
   */
  fingerprint?: string | null;
};

export type PostManualJournalEntryResult =
  | {
      kind: "ok";
      journalEntry: JournalEntryRow;
      lines: JournalEntryLineRow[];
      /**
       * Task 25A — true when this call resolved to a previously-posted JE
       * via the idempotency key (no new row, no new activity_log row).
       */
      idempotent: boolean;
    }
  | { kind: "forbidden"; reason: string }
  | { kind: "invalid_payload"; reason: string }
  | { kind: "unbalanced"; debitsCents: number; creditsCents: number }
  | {
      kind: "invalid_account";
      lineNo: number;
      account: string;
      reason:
        | "unknown_account"
        | "archived_account"
        | "manual_posting_disabled";
    }
  | {
      kind: "period_locked";
      entryDate: string;
      periodLabel: string | null;
    }
  | {
      /**
       * Task 25A — same idempotency key was previously used for a
       * meaningfully different payload. The route maps this to 409.
       */
      kind: "idempotency_conflict";
      idempotencyKey: string;
      existingJournalEntryId: number;
    };

export async function postManualJournalEntry(
  input: ManualJournalEntryInput,
  actor: PostingActor,
): Promise<PostManualJournalEntryResult> {
  if (!POSTING_ALLOWED_ROLES.includes(actor.role)) {
    return {
      kind: "forbidden",
      reason: `Role '${actor.role}' is not allowed to post journal entries. Allowed roles: ${POSTING_ALLOWED_ROLES.join(", ")}.`,
    };
  }
  if (typeof input.entryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) {
    return {
      kind: "invalid_payload",
      reason: "Entry date must be in YYYY-MM-DD format.",
    };
  }
  const memo = typeof input.memo === "string" ? input.memo.trim() : "";
  if (memo.length === 0) {
    return { kind: "invalid_payload", reason: "Memo is required." };
  }

  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
      ? input.idempotencyKey
      : null;
  const fingerprint =
    typeof input.fingerprint === "string" && input.fingerprint.length > 0
      ? input.fingerprint
      : null;

  // Task 25A — fast-path replay check. If a JE with this idempotency key
  // already exists, decide replay-vs-conflict here without doing any work.
  // The DB-level partial unique index is the authoritative race guard
  // (see the catch block below) — this pre-check just avoids the wasted
  // transaction in the common, sequential retry case.
  if (idempotencyKey) {
    const existing = await loadJournalEntryByIdempotencyKey(idempotencyKey);
    if (existing) {
      return resolveIdempotencyMatch(existing, fingerprint, idempotencyKey);
    }
  }

  try {
    return await db.transaction(async (tx) => {
    const sanitized = await sanitizeLines(tx, input.lines);
    if (!sanitized.ok) {
      if ("kind" in sanitized && sanitized.kind === "invalid_account") {
        return {
          kind: "invalid_account" as const,
          lineNo: sanitized.lineNo,
          account: sanitized.account,
          reason: sanitized.accountReason,
        };
      }
      return { kind: "invalid_payload" as const, reason: sanitized.reason };
    }
    const lines = sanitized.lines;

    let debitsCents = 0;
    let creditsCents = 0;
    for (const ln of lines) {
      const cents = toCents(ln.amount)!;
      if (ln.type === "debit") debitsCents += cents;
      else creditsCents += cents;
    }
    if (debitsCents === 0) {
      return {
        kind: "invalid_payload" as const,
        reason: "Journal entry total must be greater than zero.",
      };
    }
    if (debitsCents !== creditsCents) {
      return {
        kind: "unbalanced" as const,
        debitsCents,
        creditsCents,
      };
    }

    const period = await findCoveringPeriod(
      tx as unknown as typeof db,
      input.entryDate,
    );
    if (!period || period.status !== "open") {
      return {
        kind: "period_locked" as const,
        entryDate: input.entryDate,
        periodLabel: period?.label ?? null,
      };
    }

    const entryNo = await allocateEntryNo(
      tx as unknown as typeof db,
      yearOfIsoDate(input.entryDate),
    );

    const evidenceSnapshot = {
      source: "manual_ui",
      poster: {
        user_id: actor.id,
        role: actor.role,
        email: actor.email,
      },
      submitted_payload: {
        entry_date: input.entryDate,
        memo,
        lines: lines.map((ln) => ({
          type: ln.type,
          amount: ln.amount,
          account: ln.account,
          program: ln.program,
          fund: ln.fund,
          memo: ln.memo,
        })),
      },
      // Task 25A — freeze the idempotency key + fingerprint inside the
      // evidence snapshot so an auditor can prove what payload the key
      // was first bound to. The same fingerprint is recomputed by the
      // route on every request and compared against this value to detect
      // "same key, different payload" replay conflicts.
      idempotency: idempotencyKey
        ? { key: idempotencyKey, fingerprint }
        : null,
      snapshot_taken_at: new Date().toISOString(),
    };

    const [je] = await tx
      .insert(journalEntriesTable)
      .values({
        entryNo,
        entryDate: input.entryDate,
        memo,
        totalsDebitsCents: debitsCents,
        totalsCreditsCents: creditsCents,
        status: "posted",
        postedByUserId: actor.id,
        agentActionId: null,
        threadId: null,
        assistantMessageId: null,
        approverUserId: actor.id,
        evidenceSnapshot,
        idempotencyKey,
      })
      .returning();

    const lineRows = await tx
      .insert(journalEntryLinesTable)
      .values(
        lines.map((ln, i) => ({
          journalEntryId: je!.id,
          lineNo: i + 1,
          type: ln.type,
          amountCents: toCents(ln.amount)!,
          account: ln.account,
          accountId: ln.accountId,
          program: ln.program,
          fund: ln.fund,
          memo: ln.memo,
        })),
      )
      .returning();

    await tx.insert(activityLogTable).values({
      type: "journal_entry_posted",
      description: `${actor.firstName ?? ""} ${actor.lastName ?? ""} manually posted ${je!.entryNo} (${(debitsCents / 100).toFixed(2)})`,
      actor: `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || actor.email || `user#${actor.id}`,
      referenceId: je!.id,
      referenceType: "journal_entry",
    });

    return {
      kind: "ok" as const,
      journalEntry: je!,
      lines: lineRows,
      idempotent: false,
    };
    });
  } catch (err) {
    // Task 25A — race-safe idempotency. If two parallel requests with the
    // same key reach the INSERT at the same time, exactly one wins and
    // the other gets a unique-violation on `journal_entries_idempotency_key_uniq`.
    // We catch ONLY that specific code, then re-resolve through the same
    // replay/conflict path the fast-path uses.
    if (idempotencyKey && isUniqueViolationOn(err, "journal_entries_idempotency_key_uniq")) {
      const existing = await loadJournalEntryByIdempotencyKey(idempotencyKey);
      if (existing) {
        return resolveIdempotencyMatch(existing, fingerprint, idempotencyKey);
      }
    }
    throw err;
  }
}

// Task 25A helpers --------------------------------------------------------
async function loadJournalEntryByIdempotencyKey(
  key: string,
): Promise<{ je: JournalEntryRow; lines: JournalEntryLineRow[] } | null> {
  const [je] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.idempotencyKey, key));
  if (!je) return null;
  const lines = await db
    .select()
    .from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.journalEntryId, je.id));
  return { je, lines };
}

function resolveIdempotencyMatch(
  existing: { je: JournalEntryRow; lines: JournalEntryLineRow[] },
  newFingerprint: string | null,
  idempotencyKey: string,
): PostManualJournalEntryResult {
  const storedFingerprint =
    (existing.je.evidenceSnapshot as { idempotency?: { fingerprint?: string | null } } | null)
      ?.idempotency?.fingerprint ?? null;
  // If the route did not supply a fingerprint (service-direct caller), be
  // strict and treat the replay as a match. The route always supplies one.
  if (newFingerprint != null && storedFingerprint != null && storedFingerprint !== newFingerprint) {
    return {
      kind: "idempotency_conflict" as const,
      idempotencyKey,
      existingJournalEntryId: existing.je.id,
    };
  }
  return {
    kind: "ok" as const,
    journalEntry: existing.je,
    lines: existing.lines,
    idempotent: true,
  };
}

function isUniqueViolationOn(err: unknown, indexName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== "23505") return false;
  if (e.constraint === indexName) return true;
  // Some pg drivers don't surface `constraint`; fall back to message match.
  return typeof e.message === "string" && e.message.includes(indexName);
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

export async function reverseJournalEntry(
  journalEntryId: number,
  actor: PostingActor,
  reason: string,
): Promise<ReverseJournalEntryResult> {
  if (!REVERSAL_ALLOWED_ROLES.includes(actor.role)) {
    return {
      kind: "forbidden",
      reason: `Role '${actor.role}' is not allowed to reverse journal entries. Allowed roles: ${REVERSAL_ALLOWED_ROLES.join(", ")}.`,
    };
  }
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 5) {
    return { kind: "missing_reason" };
  }

  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, journalEntryId))
      .for("update");
    if (!original) return { kind: "not_found" as const };

    // Idempotency: if already reversed, return the existing reversal.
    if (
      original.status === "reversed" &&
      original.reversedByJournalEntryId !== null
    ) {
      const [existingReversal] = await tx
        .select()
        .from(journalEntriesTable)
        .where(eq(journalEntriesTable.id, original.reversedByJournalEntryId));
      if (existingReversal) {
        const reversalLines = await tx
          .select()
          .from(journalEntryLinesTable)
          .where(
            eq(
              journalEntryLinesTable.journalEntryId,
              existingReversal.id,
            ),
          );
        return {
          kind: "ok" as const,
          idempotent: true,
          original,
          reversal: existingReversal,
          reversalLines,
        };
      }
    }

    // Refuse to reverse a row that IS itself a reversal — this prevents
    // creating an infinite chain of reversals-of-reversals.
    if (original.reversesJournalEntryId !== null) {
      return {
        kind: "forbidden" as const,
        reason:
          "This journal entry is itself a reversal. Reversals cannot be reversed.",
      };
    }

    const reversalDate = todayIsoDate();
    const period = await findCoveringPeriod(
      tx as unknown as typeof db,
      reversalDate,
    );
    if (!period || period.status !== "open") {
      return {
        kind: "period_locked" as const,
        entryDate: reversalDate,
        periodLabel: period?.label ?? null,
      };
    }

    const originalLines = await tx
      .select()
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.journalEntryId, original.id));

    const entryNo = await allocateEntryNo(
      tx as unknown as typeof db,
      yearOfIsoDate(reversalDate),
    );

    const reversalEvidence = {
      reverses_entry_no: original.entryNo,
      reverses_entry_id: original.id,
      reason: trimmedReason,
      original_evidence_snapshot: original.evidenceSnapshot,
      reverser: {
        user_id: actor.id,
        role: actor.role,
        email: actor.email,
      },
      snapshot_taken_at: new Date().toISOString(),
    };

    const [reversal] = await tx
      .insert(journalEntriesTable)
      .values({
        entryNo,
        entryDate: reversalDate,
        memo: `Reversal of ${original.entryNo}: ${trimmedReason}`,
        totalsDebitsCents: original.totalsCreditsCents,
        totalsCreditsCents: original.totalsDebitsCents,
        status: "posted",
        postedByUserId: actor.id,
        // Reversals are not posted from an agent_action; leave linkage null.
        agentActionId: null,
        threadId: original.threadId,
        assistantMessageId: original.assistantMessageId,
        approverUserId: actor.id,
        evidenceSnapshot: reversalEvidence,
        reversesJournalEntryId: original.id,
        reversalReason: trimmedReason,
      })
      .returning();

    const reversalLineRows = await tx
      .insert(journalEntryLinesTable)
      .values(
        originalLines.map((ln) => ({
          journalEntryId: reversal!.id,
          lineNo: ln.lineNo,
          type: ln.type === "debit" ? "credit" : "debit",
          amountCents: ln.amountCents,
          account: ln.account,
          accountId: ln.accountId,
          program: ln.program,
          fund: ln.fund,
          memo: ln.memo
            ? `Reversal of: ${ln.memo}`
            : `Reversal of ${original.entryNo} line ${ln.lineNo}`,
        })),
      )
      .returning();

    const [updatedOriginal] = await tx
      .update(journalEntriesTable)
      .set({
        status: "reversed",
        reversedByJournalEntryId: reversal!.id,
        reversalReason: trimmedReason,
      })
      .where(eq(journalEntriesTable.id, original.id))
      .returning();

    await tx.insert(activityLogTable).values({
      type: "journal_entry_reversed",
      description: `${actor.firstName ?? ""} ${actor.lastName ?? ""} reversed ${original.entryNo} via ${reversal!.entryNo}: ${trimmedReason}`,
      actor: `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || actor.email || `user#${actor.id}`,
      referenceId: reversal!.id,
      referenceType: "journal_entry",
    });

    return {
      kind: "ok" as const,
      idempotent: false,
      original: updatedOriginal!,
      reversal: reversal!,
      reversalLines: reversalLineRows,
    };
  });
}
