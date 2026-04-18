import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Step 9 — Chart of Accounts.
 *
 * Single-tenant for now (organization scoping deferred). Every posted
 * `journal_entry_lines.account_id` must resolve to an active row here.
 * The free-text `journal_entry_lines.account` column is preserved for
 * immutability of historical postings — reads prefer `account_id` and
 * fall back to the string when the FK is null (Step 9 backfill aims to
 * eliminate nulls but never mutates the immutable text column).
 */
export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["debit", "credit"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

export const chartOfAccountsTable = pgTable(
  "chart_of_accounts",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    normalBalance: text("normal_balance").notNull(),
    parentAccountId: integer("parent_account_id").references(
      (): AnyPgColumn => chartOfAccountsTable.id,
      { onDelete: "restrict" },
    ),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Seeded GAAP defaults (1000 Cash, 2000 A/P, etc.) carry is_system=true.
     * The CRUD layer refuses to delete or rename system accounts; users
     * may still archive them or change description/allow_manual_posting.
     */
    isSystem: boolean("is_system").notNull().default(false),
    /**
     * Some accounts are summary/header rows that should never receive a
     * direct manual JE line — only roll-up children. Defaults to true.
     */
    allowManualPosting: boolean("allow_manual_posting")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chart_of_accounts_code_uniq").on(table.code),
    index("chart_of_accounts_type_idx").on(table.type, table.isActive),
    index("chart_of_accounts_parent_idx").on(table.parentAccountId),
  ],
);

export type ChartOfAccountRow = typeof chartOfAccountsTable.$inferSelect;
export type ChartOfAccountInsert =
  typeof chartOfAccountsTable.$inferInsert;
