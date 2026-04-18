import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { chartOfAccountsTable } from "./chart_of_accounts";
import { usersTable } from "./users";

/**
 * Step 9 — Accounting Settings.
 *
 * Single-row table. The seed inserts id=1 with safe defaults; the
 * Settings UI updates that row in place. Multi-tenancy is deferred —
 * if/when an organization_id is introduced, this table grows that
 * column and gains a UNIQUE(organization_id) constraint.
 *
 * The `default_*_account_id` columns are nullable because at first
 * boot the CoA may not yet contain the matching seed account. The
 * seed routine fills them in once the CoA is in place.
 */
export const ACCOUNTING_METHODS = ["cash", "accrual"] as const;
export type AccountingMethod = (typeof ACCOUNTING_METHODS)[number];

export const accountingSettingsTable = pgTable("accounting_settings", {
  id: serial("id").primaryKey(),
  accountingMethod: text("accounting_method").notNull().default("accrual"),
  /**
   * Maker/checker enforcement: when true, the user who submitted a draft
   * cannot approve or post it. Already enforced in code; this flag lets
   * an admin temporarily relax it (e.g. for a one-person bookkeeping
   * setup) — the audit trail records the change.
   */
  separationOfDuties: boolean("separation_of_duties")
    .notNull()
    .default(true),
  defaultCashAccountId: integer("default_cash_account_id").references(
    () => chartOfAccountsTable.id,
    { onDelete: "set null" },
  ),
  defaultApAccountId: integer("default_ap_account_id").references(
    () => chartOfAccountsTable.id,
    { onDelete: "set null" },
  ),
  defaultArAccountId: integer("default_ar_account_id").references(
    () => chartOfAccountsTable.id,
    { onDelete: "set null" },
  ),
  defaultExpenseClearingAccountId: integer(
    "default_expense_clearing_account_id",
  ).references(() => chartOfAccountsTable.id, { onDelete: "set null" }),
  defaultRoundingAccountId: integer(
    "default_rounding_account_id",
  ).references(() => chartOfAccountsTable.id, { onDelete: "set null" }),
  /**
   * Receipts are required for any expense above this amount. Stored as
   * cents to keep currency arithmetic integer-only across the system.
   */
  receiptRequiredOverCents: integer("receipt_required_over_cents")
    .notNull()
    .default(7500),
  /**
   * If true, only admin can close an accounting period. (Today's
   * `/periods/:id/close` route already enforces admin-only; this flag
   * is wired to the Settings UI for future relaxation.)
   */
  periodCloseRequiresAdmin: boolean("period_close_requires_admin")
    .notNull()
    .default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AccountingSettingsRow =
  typeof accountingSettingsTable.$inferSelect;
export type AccountingSettingsInsert =
  typeof accountingSettingsTable.$inferInsert;
