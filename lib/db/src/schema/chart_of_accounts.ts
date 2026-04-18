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
/**
 * Locked enum (Step 9 9th-pass tightening). Adding contra-* and "other" so
 * the schema can express the full chart most nonprofits actually need
 * without a future migration. The DB column stays `text`, so this is a
 * pure application-level validation list — no DB migration required.
 */
export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
  "contra_asset",
  "contra_liability",
  "contra_revenue",
  "other",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["debit", "credit"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/**
 * Default normal balance for a given account type, per the Sprint 1
 * tightening rules. `other` returns null because the user must pick
 * explicitly.
 */
export function defaultNormalBalanceFor(
  type: AccountType,
): NormalBalance | null {
  switch (type) {
    case "asset":
    case "expense":
    case "contra_liability":
    case "contra_revenue":
      return "debit";
    case "liability":
    case "equity":
    case "revenue":
    case "contra_asset":
      return "credit";
    case "other":
      return null;
  }
}

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
