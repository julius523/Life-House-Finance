import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Drafts of manual journal entries — work-in-progress saves from the
 * "New journal entry" page so accountants can step away and resume later.
 *
 * These rows NEVER affect the ledger. The full editor state (header +
 * lines, including blank/invalid fields) is preserved verbatim in
 * `payload` so a draft can be resumed exactly as it was left, even if
 * it would not yet pass posting validation.
 *
 * Visibility (enforced by the route layer):
 *   - The user who created the draft can always see, edit, and discard it.
 *   - Admins and approvers can see, edit, and discard any user's drafts.
 *
 * Posting a draft is a separate operation: the client posts the entry
 * via the existing `/accounting/journal-entries` endpoint and then
 * deletes the draft on success.
 */
export const manualJournalEntryDraftsTable = pgTable(
  "manual_journal_entry_drafts",
  {
    id: serial("id").primaryKey(),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /**
     * Optional header fields stored alongside `payload` so the list view
     * can render a useful summary without parsing JSON.
     */
    entryDate: text("entry_date"),
    memo: text("memo"),
    /**
     * Verbatim editor state: { entryDate, memo, lines: LineDraft[] }.
     * Lines may have empty/invalid values — we never validate at save
     * time so partial work is preserved.
     */
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("manual_je_drafts_user_idx").on(
      table.createdByUserId,
      table.updatedAt,
    ),
    index("manual_je_drafts_updated_idx").on(table.updatedAt),
  ],
);

export type ManualJournalEntryDraftRow =
  typeof manualJournalEntryDraftsTable.$inferSelect;
export type ManualJournalEntryDraftInsert =
  typeof manualJournalEntryDraftsTable.$inferInsert;
