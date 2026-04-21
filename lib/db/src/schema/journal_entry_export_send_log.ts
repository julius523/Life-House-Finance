import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  boolean,
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
    /**
     * Task #97 — snapshot of the schedule's non-user filters as they were
     * configured at the moment this run fired. Same audit motivation as the
     * Task #89 user-label snapshots above: editing a schedule's status /
     * source / cadence / include-lines flag would otherwise silently rewrite
     * how older send-log rows are interpreted. Persisting them on the row
     * lets the "Recent send log" table show exactly what each historical run
     * was configured to export. Nullable for rows written before #97.
     */
    filterStatus: text("filter_status"),
    filterSource: text("filter_source"),
    cadence: text("cadence"),
    includeLines: boolean("include_lines"),
  },
);

export type JournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferSelect;
export type InsertJournalEntryExportSendLog =
  typeof journalEntryExportSendLogTable.$inferInsert;
