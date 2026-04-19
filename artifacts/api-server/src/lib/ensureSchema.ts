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
}
