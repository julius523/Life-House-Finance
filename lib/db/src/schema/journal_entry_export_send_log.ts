import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { journalEntryExportSchedulesTable } from "./journal_entry_export_schedules";

/**
 * Task #49 — Per-send audit row for scheduled CSV exports of journal
 * entries. Every attempt — successful, empty, or failed — writes one
 * row so admins can see when the last export went out without parsing
 * activity log strings.
 */
export const journalEntryExportSendLogTable = pgTable(
  "journal_entry_export_send_log",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => journalEntryExportSchedulesTable.id, {
        onDelete: "cascade",
      }),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    recipients: text("recipients").array().notNull(),
    rowCount: integer("row_count").notNull(),
    rangeFrom: date("range_from"),
    rangeTo: date("range_to"),
    /** sent | failed | empty */
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    filename: text("filename").notNull(),
    /** schedule | manual — captures whether a human "Run now"-clicked it. */
    triggeredBy: text("triggered_by").notNull().default("schedule"),
    triggeredByUserId: integer("triggered_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
  },
);

export type JournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferSelect;
export type InsertJournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferInsert;
