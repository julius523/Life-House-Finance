import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { manualJournalEntryDraftsTable } from "./manual_journal_entry_drafts";
import { journalEntriesTable } from "./journal_entries";

/**
 * Task #52 — canonical bridge between operational source documents
 * (expenses today, bills tomorrow) and accounting artefacts (manual JE
 * drafts and posted journal entries).
 *
 * Why a separate table instead of columns on manual_journal_entry_drafts?
 *   - Bills, vendor credits, and future operational systems must plug
 *     into the same bridge without schema churn on the drafts table.
 *   - Source ↔ accounting is a many-to-one relationship over time
 *     (rejected drafts, regenerations) — keeping it out of the draft
 *     row keeps the draft schema clean.
 *   - The UNIQUE (sourceType, sourceId) is the *database-level*
 *     idempotency fence guaranteeing that two parallel approval
 *     callers cannot create two drafts for the same expense.
 *
 * Notes:
 *   - manualJournalEntryDraftId is nullable so a future "blocked but
 *     linked" workflow can still record provenance.
 *   - journalEntryId is filled later (Task #53 / posting hook) when the
 *     draft eventually posts.
 */
export const ACCOUNTING_SOURCE_TYPES = ["expense", "bill"] as const;
export type AccountingSourceType = (typeof ACCOUNTING_SOURCE_TYPES)[number];

export const accountingSourceLinksTable = pgTable(
  "accounting_source_links",
  {
    id: serial("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: integer("source_id").notNull(),
    /**
     * Deterministic per-source idempotency key. Format:
     *   "<sourceType>-draft-<sourceId>"   e.g. "expense-draft-42"
     * Required by Task #52 in addition to UNIQUE(sourceType,sourceId)
     * so callers can also assert idempotency by key (e.g. for retry
     * tooling and audits) without knowing the underlying composite.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    manualJournalEntryDraftId: integer(
      "manual_journal_entry_draft_id",
    ).references((): AnyPgColumn => manualJournalEntryDraftsTable.id, {
      onDelete: "set null",
    }),
    journalEntryId: integer("journal_entry_id").references(
      (): AnyPgColumn => journalEntriesTable.id,
      { onDelete: "set null" },
    ),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_source_links_source_uniq").on(
      table.sourceType,
      table.sourceId,
    ),
    uniqueIndex("accounting_source_links_idem_key_uniq").on(table.idempotencyKey),
    index("accounting_source_links_draft_idx").on(
      table.manualJournalEntryDraftId,
    ),
    index("accounting_source_links_je_idx").on(table.journalEntryId),
  ],
);

export type AccountingSourceLinkRow =
  typeof accountingSourceLinksTable.$inferSelect;
export type AccountingSourceLinkInsert =
  typeof accountingSourceLinksTable.$inferInsert;
