import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { chartOfAccountsTable } from "./chart_of_accounts";

/**
 * Task #51 — Expense category mapping foundation.
 *
 * Each expense_categories row gives finance a deterministic way to
 * translate an operational expense into a journal entry: the category
 * supplies the debit (expense) account, and the related
 * `expense_category_payment_method_rules` row supplies the credit
 * (cash / AP / credit-card-clearing) account based on how the expense
 * was paid.
 */
export const expenseCategoriesTable = pgTable(
  "expense_categories",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    debitAccountId: integer("debit_account_id")
      .notNull()
      .references(() => chartOfAccountsTable.id, { onDelete: "restrict" }),
    isActive: boolean("is_active").notNull().default(true),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("expense_categories_name_uniq").on(table.name),
    index("expense_categories_active_idx").on(table.isActive),
  ],
);

export type ExpenseCategoryRow = typeof expenseCategoriesTable.$inferSelect;
export type ExpenseCategoryInsert = typeof expenseCategoriesTable.$inferInsert;

/**
 * Per-category, per-payment-method credit-account rules. Lookup at
 * draft-generation time is: pick the rule whose paymentMethod matches
 * the expense; if none, fall back to the rule flagged isDefault=true.
 * The category must always have at least one isDefault=true rule —
 * the API enforces this on every write.
 */
export const expenseCategoryPaymentMethodRulesTable = pgTable(
  "expense_category_payment_method_rules",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => expenseCategoriesTable.id, { onDelete: "cascade" }),
    paymentMethod: text("payment_method").notNull(),
    creditAccountId: integer("credit_account_id")
      .notNull()
      .references(() => chartOfAccountsTable.id, { onDelete: "restrict" }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("expense_category_pm_rules_uniq").on(
      table.categoryId,
      table.paymentMethod,
    ),
    index("expense_category_pm_rules_category_idx").on(table.categoryId),
  ],
);

export type ExpenseCategoryPaymentMethodRuleRow =
  typeof expenseCategoryPaymentMethodRulesTable.$inferSelect;
export type ExpenseCategoryPaymentMethodRuleInsert =
  typeof expenseCategoryPaymentMethodRulesTable.$inferInsert;

export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "check",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "other",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];
