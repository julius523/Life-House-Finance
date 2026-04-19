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
 * Task #52 / #63 — canonical bridge between operational source documents
 * (expenses, bills) and accounting artefacts (manual JE drafts and
 * posted journal entries).
 *
 * eventType (Task #63) discriminates the lifecycle event that produced
 * the link. Today:
 *   'primary'  — expense approval (legacy default; backfilled)
 *   'accrual'  — bill approval (Dr expense / Cr A/P)
 *   'payment'  — bill payment   (Dr A/P / Cr cash)
 *
 * The DB-level idempotency fence is (sourceType, sourceId, eventType)
 * UNIQUE — a single bill can produce both an 'accrual' and a 'payment'
 * row but never two rows with the same eventType.
 */
export const ACCOUNTING_SOURCE_TYPES = ["expense", "bill"] as const;
export type AccountingSourceType = (typeof ACCOUNTING_SOURCE_TYPES)[number];
export const ACCOUNTING_EVENT_TYPES = ["primary", "accrual", "payment"] as const;
export type AccountingEventType = (typeof ACCOUNTING_EVENT_TYPES)[number];

export const accountingSourceLinksTable = pgTable(
  "accounting_source_links",
  {
    id: serial("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: integer("source_id").notNull(),
    /**
     * Task #63 — lifecycle discriminator. Defaults to 'primary' so existing
     * expense links remain unique under (sourceType, sourceId, eventType).
     */
    eventType: text("event_type").notNull().default("primary"),
    /**
     * Deterministic per-event idempotency key. Format:
     *   "<sourceType>-draft-<sourceId>"               (eventType='primary')
     *   "<sourceType>-<eventType>-draft-<sourceId>"   (other event types)
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
    uniqueIndex("accounting_source_links_source_event_uniq").on(
      table.sourceType,
      table.sourceId,
      table.eventType,
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
