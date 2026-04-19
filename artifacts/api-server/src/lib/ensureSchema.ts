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
}
