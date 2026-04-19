import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotent post-migration DDL fixups that drizzle-kit cannot reliably
 * emit on its own. Today this enforces the cross-table FK
 *
 *   journal_entries.manual_draft_id -> manual_journal_entry_drafts.id
 *
 * (Task #29B). drizzle-kit can't declare it from either schema file
 * without creating an import cycle, so we apply it here at boot. The
 * DO block is a no-op once the constraint already exists.
 */
export async function ensureSchemaConstraints(): Promise<void> {
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'journal_entries_manual_draft_fk'
      ) THEN
        ALTER TABLE journal_entries
        ADD CONSTRAINT journal_entries_manual_draft_fk
        FOREIGN KEY (manual_draft_id)
        REFERENCES manual_journal_entry_drafts(id)
        ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  logger.info(
    "ensureSchemaConstraints: journal_entries_manual_draft_fk verified",
  );

  // Task #52 — backfill expenses.accounting_status for legacy approved rows.
  const backfill = await db.execute(sql`
    UPDATE expenses
    SET accounting_status = 'not_applicable'
    WHERE status = 'approved'
      AND accounting_status = 'pending'
      AND accounting_generated_at IS NULL
      AND accounting_block_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM accounting_source_links l
        WHERE l.source_type = 'expense' AND l.source_id = expenses.id
      )
  `);
  logger.info(
    { rowCount: backfill.rowCount ?? 0 },
    "ensureSchemaConstraints: legacy approved expenses backfilled to not_applicable",
  );

  // Task #63 — backfill bills.accounting_status / accounting_payment_status
  // for rows that pre-date the bridge. Same logic as expenses: any bill
  // that has never been through the new bridge is marked not_applicable so
  // it never appears in the blocked queue. New bills default to 'pending'
  // via the column default and only the /approve and payment hooks flip
  // them. accrual leg keys off status >= approved; payment leg keys off
  // status = paid.
  const billAccrualBackfill = await db.execute(sql`
    UPDATE bills
    SET accounting_status = 'not_applicable'
    WHERE status IN ('approved', 'paid')
      AND accounting_status = 'pending'
      AND accounting_generated_at IS NULL
      AND accounting_block_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM accounting_source_links l
        WHERE l.source_type = 'bill'
          AND l.source_id = bills.id
          AND l.event_type = 'accrual'
      )
  `);
  logger.info(
    { rowCount: billAccrualBackfill.rowCount ?? 0 },
    "ensureSchemaConstraints: legacy bills accrual backfilled to not_applicable",
  );

  const billPaymentBackfill = await db.execute(sql`
    UPDATE bills
    SET accounting_payment_status = 'not_applicable'
    WHERE status = 'paid'
      AND accounting_payment_status = 'pending'
      AND accounting_payment_generated_at IS NULL
      AND accounting_payment_block_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM accounting_source_links l
        WHERE l.source_type = 'bill'
          AND l.source_id = bills.id
          AND l.event_type = 'payment'
      )
  `);
  logger.info(
    { rowCount: billPaymentBackfill.rowCount ?? 0 },
    "ensureSchemaConstraints: legacy bills payment backfilled to not_applicable",
  );

  // Task #48 — lock posted journal entries (and all journal_entry_lines)
  // at the database level. The application already routes corrections
  // through reverseJournalEntry(), but a stray UPDATE/DELETE — from a
  // hand-run SQL script, a future bug, or a misbehaving job — must not
  // be able to silently mutate the ledger. These triggers fail-closed:
  //
  //   journal_entries
  //     - DELETE: never allowed.
  //     - UPDATE: allowed only as the controlled posted -> reversed flip.
  //       Specifically: status goes from 'posted' to 'reversed', and
  //       reversed_by_journal_entry_id goes from NULL to non-NULL. Every
  //       other column must be unchanged. (reversal_reason changes too,
  //       and is permitted because it is set in the same UPDATE.)
  //   journal_entry_lines
  //     - UPDATE / DELETE: never allowed. Lines are immutable once
  //       inserted; reversals create a new JE with swapped lines.
  //
  // CREATE OR REPLACE FUNCTION/TRIGGER make this idempotent across
  // restarts. Triggers are BEFORE so the RAISE prevents the row change.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION journal_entries_lock_trg()
    RETURNS trigger AS $func$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'journal_entries are immutable: deletion is not allowed (post a reversing entry instead).'
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'posted'
           AND NEW.status = 'reversed'
           AND OLD.reversed_by_journal_entry_id IS NULL
           AND NEW.reversed_by_journal_entry_id IS NOT NULL
           AND OLD.id = NEW.id
           AND OLD.entry_no IS NOT DISTINCT FROM NEW.entry_no
           AND OLD.entry_date IS NOT DISTINCT FROM NEW.entry_date
           AND OLD.memo IS NOT DISTINCT FROM NEW.memo
           AND OLD.totals_debits_cents IS NOT DISTINCT FROM NEW.totals_debits_cents
           AND OLD.totals_credits_cents IS NOT DISTINCT FROM NEW.totals_credits_cents
           AND OLD.posted_at IS NOT DISTINCT FROM NEW.posted_at
           AND OLD.posted_by_user_id IS NOT DISTINCT FROM NEW.posted_by_user_id
           AND OLD.agent_action_id IS NOT DISTINCT FROM NEW.agent_action_id
           AND OLD.thread_id IS NOT DISTINCT FROM NEW.thread_id
           AND OLD.assistant_message_id IS NOT DISTINCT FROM NEW.assistant_message_id
           AND OLD.approver_user_id IS NOT DISTINCT FROM NEW.approver_user_id
           AND OLD.evidence_snapshot IS NOT DISTINCT FROM NEW.evidence_snapshot
           AND OLD.reverses_journal_entry_id IS NOT DISTINCT FROM NEW.reverses_journal_entry_id
           AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
           AND OLD.manual_draft_id IS NOT DISTINCT FROM NEW.manual_draft_id
           AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
        THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Posted journal entries are locked. The only permitted update is the controlled posted -> reversed flip set by reverseJournalEntry().'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`
    DROP TRIGGER IF EXISTS journal_entries_lock ON journal_entries;
  `);
  await db.execute(sql`
    CREATE TRIGGER journal_entries_lock
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_lock_trg();
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION journal_entry_lines_lock_trg()
    RETURNS trigger AS $func$
    BEGIN
      -- DELETEs are always rejected — a posted line cannot be removed;
      -- corrections must be posted as a separate reversing entry.
      IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'journal_entry_lines are immutable: DELETE is not allowed (post a reversing entry instead).'
          USING ERRCODE = 'check_violation';
      END IF;

      -- The only permitted UPDATE is the controlled chart-of-accounts
      -- backfill that fills in account_id on legacy rows where it is
      -- still NULL. That backfill is run at startup by
      -- seedChartOfAccountsAndSettings() and only ever moves account_id
      -- from NULL to a non-NULL value while leaving every other column
      -- untouched. Any other column change is a tampering attempt.
      IF (
        OLD.account_id IS NULL
        AND NEW.account_id IS NOT NULL
        AND NEW.id IS NOT DISTINCT FROM OLD.id
        AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
        AND NEW.line_no IS NOT DISTINCT FROM OLD.line_no
        AND NEW.type IS NOT DISTINCT FROM OLD.type
        AND NEW.account IS NOT DISTINCT FROM OLD.account
        AND NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents
        AND NEW.program IS NOT DISTINCT FROM OLD.program
        AND NEW.fund IS NOT DISTINCT FROM OLD.fund
        AND NEW.memo IS NOT DISTINCT FROM OLD.memo
      ) THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'journal_entry_lines are immutable: UPDATE is not allowed (post a reversing entry instead).'
        USING ERRCODE = 'check_violation';
    END;
    $func$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`
    DROP TRIGGER IF EXISTS journal_entry_lines_lock ON journal_entry_lines;
  `);
  await db.execute(sql`
    CREATE TRIGGER journal_entry_lines_lock
    BEFORE UPDATE OR DELETE ON journal_entry_lines
    FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_lock_trg();
  `);
  logger.info(
    "ensureSchemaConstraints: journal_entries / journal_entry_lines lock triggers installed",
  );
}
