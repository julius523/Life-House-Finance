import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { journalEntriesTable } from "./journal_entries";

/**
 * Manual journal entry drafts.
 *
 * History:
 *   - Task #29A — added the table for save/resume of work-in-progress
 *     manual journal entries. Persistence-only; no workflow.
 *   - Task #29B — extended the same table with a controlled lifecycle:
 *       draft → submitted → approved → rejected → posted
 *     so manual JEs go through a real maker/checker review before they
 *     touch the ledger.
 *
 * Lifecycle states:
 *   - draft       — author is still editing. Editable + deletable by
 *                   the author and admin/approver reviewers.
 *   - submitted   — handed off for review. Locked; cannot be edited or
 *                   deleted. Can only transition to approved or rejected.
 *   - approved    — reviewer (different from submitter when
 *                   accounting_settings.separationOfDuties is true) has
 *                   accepted it. Ready to be posted to the ledger.
 *   - rejected    — reviewer sent it back. Editable again so the author
 *                   can fix and re-submit. `rejection_reason` carries
 *                   the reviewer's explanation.
 *   - posted      — has been posted to the ledger via the existing
 *                   `postManualJournalEntry` service (Task 25A path).
 *                   `posted_journal_entry_id` links to the resulting
 *                   `journal_entries` row, and that row carries the
 *                   reverse linkage `manual_draft_id`. Terminal state —
 *                   the row is NEVER deleted, so the approval chain
 *                   stays auditable.
 *
 * Visibility (enforced by the route layer):
 *   - The user who created the draft can always see it.
 *   - Admins and approvers can see, edit, and act on any draft within
 *     the rules of the lifecycle.
 *
 * Posting path (Task #29B):
 *   The "post approved draft" endpoint must internally call the existing
 *   `postManualJournalEntry` service with a deterministic Idempotency-Key
 *   derived from the draft id. There is NO second posting implementation
 *   and NO bypass route. Closed-period block, balanced-entry checks,
 *   archived/non-manual account rejection, and Task 25A idempotency all
 *   apply automatically.
 */
export const MANUAL_JE_DRAFT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "posted",
] as const;
export type ManualJournalEntryDraftStatus =
  (typeof MANUAL_JE_DRAFT_STATUSES)[number];

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

    // --- Task #29B lifecycle -------------------------------------------------
    /**
     * Current workflow state. Defaults to 'draft' so historical Task #29A
     * rows that pre-date this column are valid out of the box.
     */
    status: text("status").notNull().default("draft"),

    submittedByUserId: integer("submitted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    submittedAt: timestamp("submitted_at"),

    approvedByUserId: integer("approved_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    approvedAt: timestamp("approved_at"),

    rejectedByUserId: integer("rejected_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),

    /**
     * Set when the draft has been posted. Mirrors the FK on the
     * journal_entries side (`manual_draft_id`), so a SQL join from
     * either direction recovers the full approval chain.
     *
     * Self-FK style declaration to break the schema cycle (drafts →
     * journal_entries and journal_entries → drafts both want to point
     * at each other).
     */
    postedJournalEntryId: integer("posted_journal_entry_id").references(
      (): AnyPgColumn => journalEntriesTable.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("manual_je_drafts_user_idx").on(
      table.createdByUserId,
      table.updatedAt,
    ),
    index("manual_je_drafts_updated_idx").on(table.updatedAt),
    index("manual_je_drafts_status_idx").on(table.status, table.updatedAt),
  ],
);

// Task #29B — true relational FK from journal_entries.manual_draft_id
// back to this table. drizzle-kit cannot reliably declare cross-table
// constraints from a circular schema like this one (drafts already
// imports journal_entries; the reverse import would create a module
// cycle), so the constraint is applied at app boot via a one-shot
// IF NOT EXISTS / DO $$ ... $$ DDL block in
// artifacts/api-server/src/lib/ensureSchema.ts. The partial unique
// index on journal_entries.manual_draft_id still guarantees one-JE-
// per-draft regardless.

export type ManualJournalEntryDraftRow =
  typeof manualJournalEntryDraftsTable.$inferSelect;
export type ManualJournalEntryDraftInsert =
  typeof manualJournalEntryDraftsTable.$inferInsert;
