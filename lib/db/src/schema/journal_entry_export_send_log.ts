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
    /**
     * Task #89 — snapshot of the resolved "Display Name <email>" labels for
     * the schedule's posted-by / approver filters at the moment this run
     * fired. Stored alongside the row so the send-log table stays auditable
     * even after an admin later edits the schedule's filter (or the
     * referenced user is deleted). Null when no filter was set on that run.
     */
    filterPostedByUserLabel: text("filter_posted_by_user_label"),
    filterApproverUserLabel: text("filter_approver_user_label"),
  },
);

export type JournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferSelect;
export type InsertJournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferInsert;
