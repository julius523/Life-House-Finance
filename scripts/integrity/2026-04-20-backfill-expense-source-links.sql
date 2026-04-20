-- Integrity sweep finding 2026-04-20:
--
-- Three expenses (id 4, 6, 7) have accounting_status='draft_created' and a
-- valid manual_journal_entry_drafts row (id 52, 53, 54) but NO row in
-- accounting_source_links. Compare canonical pattern at expense ids 8/9/10
-- which have proper asl rows (id 4/5/6, idempotency_key 'expense-draft-N').
-- Cause: these expenses were created in a brief window before the
-- accountingSourceLinks insert was wired into the expense bridge
-- (artifacts/api-server/src/lib/expenseDraftService.ts:318) — within the
-- same minute as expense #8 which was the first one with the wiring live.
--
-- Drafts 52/53/54 are still in status='draft' (unposted), so the backfill
-- only needs to populate manual_journal_entry_draft_id; journal_entry_id
-- stays NULL exactly like the canonical rows.
--
-- Idempotency / audit semantics:
--   • Bridge inserts: ON CONFLICT (source_type, source_id, event_type) DO NOTHING.
--   • Audit rows are driven from RETURNING of the actual insert via CTE,
--     so a replay against an already-fixed DB writes ZERO audit rows
--     (no phantom "we backfilled this" entries).
--   • created_by_user_id is NULL — this is a system-initiated repair, not
--     a user action. Stays portable across environments where user id 1
--     may not exist.
--   • A second UPDATE normalises the 2026-04-20 first-run rows (which
--     were inserted with created_by_user_id=1 before this audit-safety
--     correction) to NULL so the asl table tells one consistent story.

BEGIN;

WITH ins AS (
  INSERT INTO accounting_source_links
    (source_type, source_id, event_type, idempotency_key,
     manual_journal_entry_draft_id, journal_entry_id, created_by_user_id)
  VALUES
    ('expense', 4, 'primary', 'expense-draft-4', 52, NULL, NULL),
    ('expense', 6, 'primary', 'expense-draft-6', 53, NULL, NULL),
    ('expense', 7, 'primary', 'expense-draft-7', 54, NULL, NULL)
  ON CONFLICT (source_type, source_id, event_type) DO NOTHING
  RETURNING source_id, manual_journal_entry_draft_id
)
INSERT INTO activity_log (type, description, actor, reference_type, reference_id)
SELECT
  'accounting_source_link_backfilled',
  '[2026-04-20 sweep] Backfilled accounting_source_links for expense #'
    || ins.source_id || ' -> draft #' || ins.manual_journal_entry_draft_id
    || ' (legacy from pre-wiring window).',
  'system',
  'expense',
  ins.source_id
FROM ins;

-- Normalise first-run rows that were committed before this audit-safety
-- correction (they used created_by_user_id=1; fix to NULL to reflect that
-- this was a system-initiated repair, not a Julius action).
UPDATE accounting_source_links
   SET created_by_user_id = NULL
 WHERE source_type = 'expense'
   AND source_id IN (4, 6, 7)
   AND event_type = 'primary'
   AND created_by_user_id = 1;

-- Inline verification — must be 0 after this script runs.
SELECT COUNT(*) AS expense_draft_no_link_after
FROM expenses e
WHERE e.accounting_status = 'draft_created'
  AND NOT EXISTS (
    SELECT 1 FROM accounting_source_links a
    WHERE a.source_type = 'expense'
      AND a.source_id = e.id
      AND a.manual_journal_entry_draft_id IS NOT NULL
  );

COMMIT;
