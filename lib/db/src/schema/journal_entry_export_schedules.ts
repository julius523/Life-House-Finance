import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Task #49 — Scheduled CSV exports of journal entries.
 *
 * One row per recurring export configuration. The scheduler reads
 * `enabled = true AND next_run_at <= now()` and claims rows by
 * atomically advancing `next_run_at` to the next boundary (so a
 * concurrent tick or a duplicate process cannot double-send).
 *
 * Cadence semantics — the exported date range is derived deterministically
 * from cadence at run time:
 *   - daily   → previous calendar day (single-day window)
 *   - weekly  → previous 7 calendar days ending yesterday
 *   - monthly → previous calendar month
 *
 * The actual run hour (UTC) is encoded in `next_run_at`; humans configure
 * cadence + recipients only.
 */
export const EXPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ExportCadence = (typeof EXPORT_CADENCES)[number];

export const EXPORT_FILTER_STATUSES = ["posted", "reversed"] as const;
export type ExportFilterStatus = (typeof EXPORT_FILTER_STATUSES)[number];

export const EXPORT_FILTER_SOURCES = [
  "copilot",
  "manual",
  "expense",
  "bill",
] as const;
export type ExportFilterSource = (typeof EXPORT_FILTER_SOURCES)[number];

export const EXPORT_RUN_STATUSES = ["sent", "failed", "empty"] as const;
export type ExportRunStatus = (typeof EXPORT_RUN_STATUSES)[number];

export const journalEntryExportSchedulesTable = pgTable(
  "journal_entry_export_schedules",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cadence: text("cadence").notNull(),
    /** Postgres text[]; stored lower-cased + trimmed by the API layer. */
    recipients: text("recipients").array().notNull(),
    filterStatus: text("filter_status"),
    filterSource: text("filter_source"),
    /**
     * Task #71 — optional "Posted by" / "Approver" user filters that the
     * scheduler passes through to `generateJournalEntryCsv`. Mirror the
     * on-demand CSV download, so an admin can email "Brittney's approvals
     * every Monday" without first having to run a one-off export.
     * `set null` on user delete so a removed user doesn't break the row.
     */
    filterPostedByUserId: integer("filter_posted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    filterApproverUserId: integer("filter_approver_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    includeLines: boolean("include_lines").notNull().default(false),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at"),
    lastRunStatus: text("last_run_status"),
    lastRunError: text("last_run_error"),
    /** When NULL the schedule never runs; fill on enable. */
    nextRunAt: timestamp("next_run_at"),
    /**
     * Task #68 — count of *consecutive* failed runs (sent/empty resets to 0).
     * When this hits MAX_CONSECUTIVE_FAILURES the scheduler auto-disables the
     * row so we stop hammering SendGrid with the same broken send.
     */
    consecutiveFailureCount: integer("consecutive_failure_count")
      .notNull()
      .default(0),
    /** Set when the scheduler auto-pauses; cleared when admin re-enables. */
    autoPausedAt: timestamp("auto_paused_at"),
    autoPausedReason: text("auto_paused_reason"),
  },
);

export type JournalEntryExportSchedule =
  typeof journalEntryExportSchedulesTable.$inferSelect;
export type InsertJournalEntryExportSchedule =
  typeof journalEntryExportSchedulesTable.$inferInsert;
