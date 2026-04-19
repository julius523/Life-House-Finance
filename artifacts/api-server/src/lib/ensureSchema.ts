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

  // Task #52 — backfill expenses.accounting_status for rows that pre-date
  // this column. Per spec, legacy approved expenses are NOT auto-generated;
  // they are marked not_applicable so the blocked queue / regenerate
  // endpoint never picks them up automatically. New expenses default to
  // 'pending' via the column default and only the /approve hook flips them.
  //
  // Predicate (idempotent and safe across boots, no time heuristic):
  //   - status = 'approved'                  : only pre-existing approved rows
  //   - accounting_status = 'pending'        : column default, never touched
  //   - accounting_generated_at IS NULL      : never went through /approve hook
  //   - accounting_block_reason IS NULL      : never went through /approve hook
  //   - no row in accounting_source_links    : never produced a draft
  // The combined predicate is impossible for any row that has ever been
  // through the new approval hook, so this can run on every boot without
  // misclassifying legitimate pending or blocked rows.
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
}
