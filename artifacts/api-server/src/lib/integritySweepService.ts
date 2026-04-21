/**
 * Task #103 — Integrity Sweep detection service.
 *
 * Read-only diagnostic that ports every check from
 * `scripts/integrity/sweep.sql` into a typed service. Returns the
 * locked {@link IntegritySweepReport} shape with per-check counts and
 * up to {@link INTEGRITY_SAMPLE_CAP} sample IDs so an operator (or the
 * follow-up Findings UI in task #104) can drill into the actual rows
 * causing each finding.
 *
 * Hard guarantees (per task-103.md):
 *   - No writes of any kind. No repair rows, no activity_log entries,
 *     no caching tables, no "last run" persistence.
 *   - `count` is the FULL affected count, even when sample refs are
 *     truncated. Never silently underreports.
 *   - All-OK runs still return the full check list with zeros and
 *     `ok: true`.
 *   - Each service `key` maps 1:1 to the corresponding sweep.sql check
 *     name (see CHECKS table below).
 *
 * SQL → service key mapping (1:1, sweep.sql order preserved):
 *   asl_je_dangling                  → asl_je_dangling
 *   asl_draft_dangling               → asl_draft_dangling
 *   asl_no_targets                   → asl_no_targets
 *   asl_expense_missing_source       → asl_expense_missing_source
 *   asl_bill_missing_source          → asl_bill_missing_source
 *   asl_unknown_source_type          → asl_unknown_source_type
 *   asl_expense_bad_event            → asl_expense_bad_event
 *   asl_bill_bad_event               → asl_bill_bad_event
 *   je_manual_draft_dangling         → je_manual_draft_dangling
 *   draft_posted_je_dangling         → draft_posted_je_dangling
 *   draft_posted_no_je               → draft_posted_no_je
 *   draft_unposted_with_je           → draft_unposted_with_je
 *   je_draft_back_pointer_asym       → je_draft_back_pointer_asym
 *   draft_je_back_pointer_asym       → draft_je_back_pointer_asym
 *   je_reversed_by_dangling          → je_reversed_by_dangling
 *   je_reverses_dangling             → je_reverses_dangling
 *   je_reversal_asym_a               → je_reversal_asym_a
 *   je_reversal_asym_b               → je_reversal_asym_b
 *   je_reversed_status_no_b          → je_reversed_status_no_b
 *   je_multi_reversals               → je_multi_reversals
 *   je_status_posted_with_reversed_by→ je_status_posted_with_reversed_by
 *   je_status_reversed_no_pointer    → je_status_reversed_no_pointer
 *   expense_posted_no_link           → expense_posted_no_link
 *   expense_draft_no_link            → expense_draft_no_link
 *   expense_posted_with_block        → expense_posted_with_block
 *   expense_blocked_no_reason        → expense_blocked_no_reason
 *   bill_accrual_posted_no_link      → bill_accrual_posted_no_link
 *   bill_payment_posted_no_link      → bill_payment_posted_no_link
 *   bill_accrual_draft_no_link       → bill_accrual_draft_no_link
 *   bill_payment_draft_no_link       → bill_payment_draft_no_link
 *   lines_posted_no_account_id       → lines_posted_no_account_id
 *   lines_inactive_account           → lines_inactive_account
 */
import { sql } from "drizzle-orm";
import {
  db,
  INTEGRITY_SAMPLE_CAP,
  type IntegrityCategory,
  type IntegrityCheckResult,
  type IntegritySampleKind,
  type IntegritySeverity,
  type IntegritySweepReport,
} from "@workspace/db";

type CheckSpec = {
  key: string;
  name: string;
  category: IntegrityCategory;
  severity: IntegritySeverity;
  sampleKind: IntegritySampleKind;
  /**
   * Inner SELECT producing rows with column `_id`. The wrapper computes
   * the full count and pulls up to {@link INTEGRITY_SAMPLE_CAP} sample
   * IDs in one round trip.
   */
  matchesSql: string;
};

// ---------------------------------------------------------------------------
// Check definitions (sweep.sql order preserved)
// ---------------------------------------------------------------------------

const CHECKS: CheckSpec[] = [
  // ----- accounting_source_links structural integrity ----------------------
  {
    key: "asl_je_dangling",
    name: "Source link points to a missing journal entry",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT a.id AS _id
      FROM accounting_source_links a
      WHERE a.journal_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = a.journal_entry_id)
    `,
  },
  {
    key: "asl_draft_dangling",
    name: "Source link points to a missing manual JE draft",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT a.id AS _id
      FROM accounting_source_links a
      WHERE a.manual_journal_entry_draft_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM manual_journal_entry_drafts d WHERE d.id = a.manual_journal_entry_draft_id)
    `,
  },
  {
    key: "asl_no_targets",
    name: "Source link has neither a JE nor a draft target",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT id AS _id
      FROM accounting_source_links
      WHERE journal_entry_id IS NULL AND manual_journal_entry_draft_id IS NULL
    `,
  },
  {
    key: "asl_expense_missing_source",
    name: "Expense source link points to a missing expense",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT a.id AS _id
      FROM accounting_source_links a
      WHERE a.source_type = 'expense'
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = a.source_id)
    `,
  },
  {
    key: "asl_bill_missing_source",
    name: "Bill source link points to a missing bill",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT a.id AS _id
      FROM accounting_source_links a
      WHERE a.source_type = 'bill'
        AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.id = a.source_id)
    `,
  },
  {
    key: "asl_unknown_source_type",
    name: "Source link uses an unknown source_type",
    category: "structural",
    severity: "critical",
    sampleKind: "source_link",
    matchesSql: `
      SELECT id AS _id
      FROM accounting_source_links
      WHERE source_type NOT IN ('expense','bill')
    `,
  },
  {
    key: "asl_expense_bad_event",
    name: "Expense source link uses a non-'primary' event_type",
    category: "structural",
    severity: "warning",
    sampleKind: "source_link",
    matchesSql: `
      SELECT id AS _id
      FROM accounting_source_links
      WHERE source_type = 'expense' AND event_type <> 'primary'
    `,
  },
  {
    key: "asl_bill_bad_event",
    name: "Bill source link uses an event_type outside (accrual,payment)",
    category: "structural",
    severity: "warning",
    sampleKind: "source_link",
    matchesSql: `
      SELECT id AS _id
      FROM accounting_source_links
      WHERE source_type = 'bill' AND event_type NOT IN ('accrual','payment')
    `,
  },

  // ----- JE / draft consistency --------------------------------------------
  {
    key: "je_manual_draft_dangling",
    name: "Journal entry references a missing manual draft",
    category: "structural",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT je.id AS _id
      FROM journal_entries je
      WHERE je.manual_draft_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM manual_journal_entry_drafts d WHERE d.id = je.manual_draft_id)
    `,
  },
  {
    key: "draft_posted_je_dangling",
    name: "Draft posted-JE pointer references a missing journal entry",
    category: "structural",
    severity: "critical",
    sampleKind: "draft",
    matchesSql: `
      SELECT d.id AS _id
      FROM manual_journal_entry_drafts d
      WHERE d.posted_journal_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = d.posted_journal_entry_id)
    `,
  },
  {
    key: "draft_posted_no_je",
    name: "Draft has status='posted' but no posted_journal_entry_id",
    category: "status_mismatch",
    severity: "critical",
    sampleKind: "draft",
    matchesSql: `
      SELECT id AS _id
      FROM manual_journal_entry_drafts
      WHERE status = 'posted' AND posted_journal_entry_id IS NULL
    `,
  },
  {
    key: "draft_unposted_with_je",
    name: "Non-posted draft has a posted_journal_entry_id set",
    category: "status_mismatch",
    severity: "critical",
    sampleKind: "draft",
    matchesSql: `
      SELECT id AS _id
      FROM manual_journal_entry_drafts
      WHERE status <> 'posted' AND posted_journal_entry_id IS NOT NULL
    `,
  },
  {
    key: "je_draft_back_pointer_asym",
    name: "JE→draft and draft→JE pointers disagree",
    category: "structural",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT je.id AS _id
      FROM journal_entries je
      JOIN manual_journal_entry_drafts d ON d.id = je.manual_draft_id
      WHERE d.status = 'posted' AND d.posted_journal_entry_id IS DISTINCT FROM je.id
    `,
  },
  {
    key: "draft_je_back_pointer_asym",
    name: "Draft→JE and JE→draft pointers disagree",
    category: "structural",
    severity: "critical",
    sampleKind: "draft",
    matchesSql: `
      SELECT d.id AS _id
      FROM manual_journal_entry_drafts d
      JOIN journal_entries je ON je.id = d.posted_journal_entry_id
      WHERE je.manual_draft_id IS DISTINCT FROM d.id
    `,
  },

  // ----- Reversal pointer integrity ---------------------------------------
  {
    key: "je_reversed_by_dangling",
    name: "JE.reversed_by_journal_entry_id points to a missing JE",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT je.id AS _id
      FROM journal_entries je
      WHERE je.reversed_by_journal_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries je2 WHERE je2.id = je.reversed_by_journal_entry_id)
    `,
  },
  {
    key: "je_reverses_dangling",
    name: "JE.reverses_journal_entry_id points to a missing JE",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT je.id AS _id
      FROM journal_entries je
      WHERE je.reverses_journal_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries je2 WHERE je2.id = je.reverses_journal_entry_id)
    `,
  },
  {
    key: "je_reversal_asym_a",
    name: "JE points at a reverser that doesn't point back",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT a.id AS _id
      FROM journal_entries a
      JOIN journal_entries b ON b.id = a.reversed_by_journal_entry_id
      WHERE b.reverses_journal_entry_id IS DISTINCT FROM a.id
    `,
  },
  {
    key: "je_reversal_asym_b",
    name: "Reverser JE points at an original that doesn't point back",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT b.id AS _id
      FROM journal_entries b
      JOIN journal_entries a ON a.id = b.reverses_journal_entry_id
      WHERE a.reversed_by_journal_entry_id IS DISTINCT FROM b.id
    `,
  },
  {
    key: "je_reversed_status_no_b",
    name: "JE.status='reversed' but no reverser JE exists",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT a.id AS _id
      FROM journal_entries a
      WHERE a.status = 'reversed'
        AND NOT EXISTS (SELECT 1 FROM journal_entries b WHERE b.reverses_journal_entry_id = a.id)
    `,
  },
  {
    key: "je_multi_reversals",
    name: "Multiple JEs reverse the same original entry",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT reverses_journal_entry_id AS _id
      FROM journal_entries
      WHERE reverses_journal_entry_id IS NOT NULL
      GROUP BY reverses_journal_entry_id
      HAVING COUNT(*) > 1
    `,
  },
  {
    key: "je_status_posted_with_reversed_by",
    name: "JE.status='posted' but has a reversed_by pointer",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT id AS _id
      FROM journal_entries
      WHERE status = 'posted' AND reversed_by_journal_entry_id IS NOT NULL
    `,
  },
  {
    key: "je_status_reversed_no_pointer",
    name: "JE.status='reversed' but reversed_by_journal_entry_id is NULL",
    category: "reversal",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT id AS _id
      FROM journal_entries
      WHERE status = 'reversed' AND reversed_by_journal_entry_id IS NULL
    `,
  },

  // ----- Expense bridge state vs links ------------------------------------
  {
    key: "expense_posted_no_link",
    name: "Posted expense has no source link to a journal entry",
    category: "missing_bridge",
    severity: "critical",
    sampleKind: "expense",
    matchesSql: `
      SELECT e.id AS _id
      FROM expenses e
      WHERE e.accounting_status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'expense' AND a.source_id = e.id AND a.journal_entry_id IS NOT NULL
        )
    `,
  },
  {
    key: "expense_draft_no_link",
    name: "Expense in draft_created has no source link to a draft",
    category: "missing_bridge",
    severity: "warning",
    sampleKind: "expense",
    matchesSql: `
      SELECT e.id AS _id
      FROM expenses e
      WHERE e.accounting_status = 'draft_created'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'expense' AND a.source_id = e.id AND a.manual_journal_entry_draft_id IS NOT NULL
        )
    `,
  },
  {
    key: "expense_posted_with_block",
    name: "Posted expense still carries an accounting_block_reason",
    category: "status_mismatch",
    severity: "warning",
    sampleKind: "expense",
    matchesSql: `
      SELECT id AS _id
      FROM expenses
      WHERE accounting_status = 'posted' AND accounting_block_reason IS NOT NULL
    `,
  },
  {
    key: "expense_blocked_no_reason",
    name: "Blocked expense is missing an accounting_block_reason",
    category: "status_mismatch",
    severity: "warning",
    sampleKind: "expense",
    matchesSql: `
      SELECT id AS _id
      FROM expenses
      WHERE accounting_status = 'blocked' AND accounting_block_reason IS NULL
    `,
  },

  // ----- Bill bridge (accrual + payment) ----------------------------------
  {
    key: "bill_accrual_posted_no_link",
    name: "Posted bill accrual has no source link to a journal entry",
    category: "missing_bridge",
    severity: "critical",
    sampleKind: "bill",
    matchesSql: `
      SELECT b.id AS _id
      FROM bills b
      WHERE b.accounting_status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'bill' AND a.source_id = b.id
            AND a.event_type = 'accrual' AND a.journal_entry_id IS NOT NULL
        )
    `,
  },
  {
    key: "bill_payment_posted_no_link",
    name: "Posted bill payment has no source link to a journal entry",
    category: "missing_bridge",
    severity: "critical",
    sampleKind: "bill",
    matchesSql: `
      SELECT b.id AS _id
      FROM bills b
      WHERE b.accounting_payment_status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'bill' AND a.source_id = b.id
            AND a.event_type = 'payment' AND a.journal_entry_id IS NOT NULL
        )
    `,
  },
  {
    key: "bill_accrual_draft_no_link",
    name: "Bill accrual in draft_created has no source link to a draft",
    category: "missing_bridge",
    severity: "warning",
    sampleKind: "bill",
    matchesSql: `
      SELECT b.id AS _id
      FROM bills b
      WHERE b.accounting_status = 'draft_created'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'bill' AND a.source_id = b.id
            AND a.event_type = 'accrual' AND a.manual_journal_entry_draft_id IS NOT NULL
        )
    `,
  },
  {
    key: "bill_payment_draft_no_link",
    name: "Bill payment in draft_created has no source link to a draft",
    category: "missing_bridge",
    severity: "warning",
    sampleKind: "bill",
    matchesSql: `
      SELECT b.id AS _id
      FROM bills b
      WHERE b.accounting_payment_status = 'draft_created'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_source_links a
          WHERE a.source_type = 'bill' AND a.source_id = b.id
            AND a.event_type = 'payment' AND a.manual_journal_entry_draft_id IS NOT NULL
        )
    `,
  },

  // ----- Posted lines must have a real account_id (Task #67 invariant) ---
  {
    key: "lines_posted_no_account_id",
    name: "Posted/reversed JE has line(s) with NULL account_id",
    category: "posted_line",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT DISTINCT je.id AS _id
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id IS NULL AND je.status IN ('posted','reversed')
    `,
  },
  {
    key: "lines_inactive_account",
    name: "Posted/reversed JE has line(s) on an archived chart-of-accounts row",
    category: "posted_line",
    severity: "critical",
    sampleKind: "journal_entry",
    matchesSql: `
      SELECT DISTINCT je.id AS _id
      FROM journal_entry_lines jel
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE coa.is_active = false AND je.status IN ('posted','reversed')
    `,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runOne(spec: CheckSpec): Promise<IntegrityCheckResult> {
  // One round trip per check: compute the full COUNT and pull up to
  // INTEGRITY_SAMPLE_CAP sample IDs from the same matching set. The
  // `matches` CTE is evaluated once and reused for both the count and
  // the sample selection (Postgres folds these together when safe).
  const queryText = `
    WITH matches AS (
      ${spec.matchesSql}
    )
    SELECT
      (SELECT COUNT(*)::int FROM matches) AS total,
      COALESCE(
        json_agg(t._id ORDER BY t._id) FILTER (WHERE t._id IS NOT NULL),
        '[]'::json
      ) AS ids
    FROM (
      SELECT _id FROM matches ORDER BY _id LIMIT ${INTEGRITY_SAMPLE_CAP}
    ) t
  `;
  const result = (await db.execute(sql.raw(queryText))) as unknown as {
    rows: Array<{ total: number | string | null; ids: unknown }>;
  };
  const row = result.rows[0];
  const count = row ? Number(row.total ?? 0) : 0;
  const rawIds = Array.isArray(row?.ids) ? (row?.ids as unknown[]) : [];
  const sampleRefs = rawIds
    .filter((v) => v !== null && v !== undefined)
    .map((v) => ({ kind: spec.sampleKind, id: String(v) }));
  return {
    key: spec.key,
    name: spec.name,
    category: spec.category,
    severity: spec.severity,
    count,
    sampleRefs,
  };
}

/**
 * Run every integrity check and assemble the locked report shape. All
 * checks fire in parallel against the shared pool — the workload is
 * read-only and bounded (32 small queries), so this stays well inside
 * a typical operator request window.
 */
export async function runIntegritySweep(): Promise<IntegritySweepReport> {
  const generatedAt = new Date().toISOString();
  const checks = await Promise.all(CHECKS.map(runOne));
  const failingChecks = checks.reduce(
    (n, c) => (c.count > 0 ? n + 1 : n),
    0,
  );
  return {
    generatedAt,
    ok: failingChecks === 0,
    totalChecks: checks.length,
    failingChecks,
    checks,
  };
}

/** Exported for tests / docs that want to enumerate the registered checks. */
export const INTEGRITY_CHECK_KEYS: ReadonlyArray<string> = CHECKS.map(
  (c) => c.key,
);
