import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Step 8 — Accounting periods.
 *
 * A period is a contiguous date range with a status. Posting (and reversal)
 * is only allowed when the relevant date falls inside an `open` period.
 * Closing a period is a one-way operation in normal business flow — once
 * closed, no new postings or reversals are accepted with a date inside it.
 *
 * The period table is intentionally minimal. We do NOT store derived totals
 * here — those are always computed from `journal_entries` to avoid drift.
 */
export const ACCOUNTING_PERIOD_STATUSES = ["open", "closed"] as const;
export type AccountingPeriodStatus =
  (typeof ACCOUNTING_PERIOD_STATUSES)[number];

export const accountingPeriodsTable = pgTable(
  "accounting_periods",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at"),
    closedByUserId: integer("closed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_periods_label_uniq").on(table.label),
    index("accounting_periods_range_idx").on(
      table.periodStart,
      table.periodEnd,
    ),
    index("accounting_periods_status_idx").on(table.status),
  ],
);

export type AccountingPeriodRow = typeof accountingPeriodsTable.$inferSelect;
export type AccountingPeriodInsert =
  typeof accountingPeriodsTable.$inferInsert;
