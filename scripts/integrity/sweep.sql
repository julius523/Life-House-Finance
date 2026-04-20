-- =============================================================================
-- Life House Finance Portal — Accounting Integrity Sweep
-- =============================================================================
-- Read-only diagnostic. Each subquery returns a single row: (check, n).
-- A clean DB returns n=0 for every row. Any non-zero is a finding to triage.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/integrity/sweep.sql
--
-- Last run: 2026-04-20 — all 30 checks at zero.
-- =============================================================================

WITH checks(check_name, n) AS (
  -- accounting_source_links structural integrity ----------------------------
  SELECT 'asl_je_dangling',                  COUNT(*)::int FROM accounting_source_links a WHERE a.journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id=a.journal_entry_id) UNION ALL
  SELECT 'asl_draft_dangling',               COUNT(*)::int FROM accounting_source_links a WHERE a.manual_journal_entry_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manual_journal_entry_drafts d WHERE d.id=a.manual_journal_entry_draft_id) UNION ALL
  SELECT 'asl_no_targets',                   COUNT(*)::int FROM accounting_source_links WHERE journal_entry_id IS NULL AND manual_journal_entry_draft_id IS NULL UNION ALL
  SELECT 'asl_expense_missing_source',       COUNT(*)::int FROM accounting_source_links a WHERE a.source_type='expense' AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id=a.source_id) UNION ALL
  SELECT 'asl_bill_missing_source',          COUNT(*)::int FROM accounting_source_links a WHERE a.source_type='bill' AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.id=a.source_id) UNION ALL
  SELECT 'asl_unknown_source_type',          COUNT(*)::int FROM accounting_source_links WHERE source_type NOT IN ('expense','bill') UNION ALL
  SELECT 'asl_expense_bad_event',            COUNT(*)::int FROM accounting_source_links WHERE source_type='expense' AND event_type<>'primary' UNION ALL
  SELECT 'asl_bill_bad_event',               COUNT(*)::int FROM accounting_source_links WHERE source_type='bill' AND event_type NOT IN ('accrual','payment') UNION ALL

  -- JE / draft consistency --------------------------------------------------
  SELECT 'je_manual_draft_dangling',         COUNT(*)::int FROM journal_entries je WHERE je.manual_draft_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manual_journal_entry_drafts d WHERE d.id=je.manual_draft_id) UNION ALL
  SELECT 'draft_posted_je_dangling',         COUNT(*)::int FROM manual_journal_entry_drafts d WHERE d.posted_journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id=d.posted_journal_entry_id) UNION ALL
  SELECT 'draft_posted_no_je',               COUNT(*)::int FROM manual_journal_entry_drafts WHERE status='posted' AND posted_journal_entry_id IS NULL UNION ALL
  SELECT 'draft_unposted_with_je',           COUNT(*)::int FROM manual_journal_entry_drafts WHERE status<>'posted' AND posted_journal_entry_id IS NOT NULL UNION ALL
  -- Reciprocal symmetry: every JE pointing at a posted draft must be the same JE the draft points back at.
  SELECT 'je_draft_back_pointer_asym',       COUNT(*)::int FROM journal_entries je JOIN manual_journal_entry_drafts d ON d.id=je.manual_draft_id WHERE d.status='posted' AND d.posted_journal_entry_id IS DISTINCT FROM je.id UNION ALL
  SELECT 'draft_je_back_pointer_asym',       COUNT(*)::int FROM manual_journal_entry_drafts d JOIN journal_entries je ON je.id=d.posted_journal_entry_id WHERE je.manual_draft_id IS DISTINCT FROM d.id UNION ALL

  -- Reversal pointer integrity ----------------------------------------------
  SELECT 'je_reversed_by_dangling',          COUNT(*)::int FROM journal_entries je WHERE je.reversed_by_journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries je2 WHERE je2.id=je.reversed_by_journal_entry_id) UNION ALL
  SELECT 'je_reverses_dangling',             COUNT(*)::int FROM journal_entries je WHERE je.reverses_journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries je2 WHERE je2.id=je.reverses_journal_entry_id) UNION ALL
  SELECT 'je_reversal_asym_a',               COUNT(*)::int FROM journal_entries a JOIN journal_entries b ON b.id=a.reversed_by_journal_entry_id WHERE b.reverses_journal_entry_id IS DISTINCT FROM a.id UNION ALL
  SELECT 'je_reversal_asym_b',               COUNT(*)::int FROM journal_entries b JOIN journal_entries a ON a.id=b.reverses_journal_entry_id WHERE a.reversed_by_journal_entry_id IS DISTINCT FROM b.id UNION ALL
  SELECT 'je_reversed_status_no_b',          COUNT(*)::int FROM journal_entries a WHERE a.status='reversed' AND NOT EXISTS (SELECT 1 FROM journal_entries b WHERE b.reverses_journal_entry_id=a.id) UNION ALL
  SELECT 'je_multi_reversals',               COUNT(*)::int FROM (SELECT reverses_journal_entry_id FROM journal_entries WHERE reverses_journal_entry_id IS NOT NULL GROUP BY reverses_journal_entry_id HAVING COUNT(*)>1) x UNION ALL
  SELECT 'je_status_posted_with_reversed_by',COUNT(*)::int FROM journal_entries WHERE status='posted' AND reversed_by_journal_entry_id IS NOT NULL UNION ALL
  SELECT 'je_status_reversed_no_pointer',    COUNT(*)::int FROM journal_entries WHERE status='reversed' AND reversed_by_journal_entry_id IS NULL UNION ALL

  -- Expense bridge state vs links -------------------------------------------
  SELECT 'expense_posted_no_link',           COUNT(*)::int FROM expenses e WHERE e.accounting_status='posted'        AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='expense' AND a.source_id=e.id AND a.journal_entry_id IS NOT NULL) UNION ALL
  SELECT 'expense_draft_no_link',            COUNT(*)::int FROM expenses e WHERE e.accounting_status='draft_created' AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='expense' AND a.source_id=e.id AND a.manual_journal_entry_draft_id IS NOT NULL) UNION ALL
  SELECT 'expense_posted_with_block',        COUNT(*)::int FROM expenses WHERE accounting_status='posted'  AND accounting_block_reason IS NOT NULL UNION ALL
  SELECT 'expense_blocked_no_reason',        COUNT(*)::int FROM expenses WHERE accounting_status='blocked' AND accounting_block_reason IS NULL UNION ALL

  -- Bill bridge (accrual + payment) -----------------------------------------
  SELECT 'bill_accrual_posted_no_link',      COUNT(*)::int FROM bills b WHERE b.accounting_status='posted'                AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='bill' AND a.source_id=b.id AND a.event_type='accrual' AND a.journal_entry_id IS NOT NULL) UNION ALL
  SELECT 'bill_payment_posted_no_link',      COUNT(*)::int FROM bills b WHERE b.accounting_payment_status='posted'        AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='bill' AND a.source_id=b.id AND a.event_type='payment' AND a.journal_entry_id IS NOT NULL) UNION ALL
  SELECT 'bill_accrual_draft_no_link',       COUNT(*)::int FROM bills b WHERE b.accounting_status='draft_created'         AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='bill' AND a.source_id=b.id AND a.event_type='accrual' AND a.manual_journal_entry_draft_id IS NOT NULL) UNION ALL
  SELECT 'bill_payment_draft_no_link',       COUNT(*)::int FROM bills b WHERE b.accounting_payment_status='draft_created' AND NOT EXISTS (SELECT 1 FROM accounting_source_links a WHERE a.source_type='bill' AND a.source_id=b.id AND a.event_type='payment' AND a.manual_journal_entry_draft_id IS NOT NULL) UNION ALL

  -- Posted lines must have a real account_id (Task #67 backfill invariant) --
  SELECT 'lines_posted_no_account_id',       COUNT(*)::int FROM journal_entry_lines jel JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE jel.account_id IS NULL AND je.status IN ('posted','reversed') UNION ALL
  SELECT 'lines_inactive_account',           COUNT(*)::int FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id=jel.account_id JOIN journal_entries je ON je.id=jel.journal_entry_id WHERE coa.is_active=false AND je.status IN ('posted','reversed')
)
SELECT
  check_name,
  n,
  CASE WHEN n = 0 THEN 'OK' ELSE 'FINDING' END AS status
FROM checks
ORDER BY n DESC, check_name;
