/**
 * Step 9 — Seed default Chart of Accounts + Accounting Settings + backfill
 * historical journal_entry_lines.account_id.
 *
 * All three operations are idempotent so this can run on every server boot
 * without producing duplicates or undoing user edits:
 *   - CoA seed: INSERT … ON CONFLICT (code) DO NOTHING — never overwrites
 *     a row a user might have customized.
 *   - Settings seed: INSERT only when no row exists (id=1 is the singleton).
 *   - Backfill: only fills NULL account_id values; never rewrites a link
 *     that's already set, never mutates the immutable `account` text column.
 */

import { sql, eq, isNull, inArray } from "drizzle-orm";
import {
  db,
  chartOfAccountsTable,
  accountingSettingsTable,
  journalEntryLinesTable,
  type ChartOfAccountInsert,
  type AccountType,
  type NormalBalance,
} from "@workspace/db";

type SeedAccount = {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  subtype?: string;
  description?: string;
  allowManualPosting?: boolean;
};

/**
 * Default Chart of Accounts based on the Sprint 1 implementation guide.
 * `is_system=true` for every seed row — the CRUD layer treats them as
 * permanent (no delete; archiving and description edits still allowed).
 */
const DEFAULT_ACCOUNTS: ReadonlyArray<SeedAccount> = [
  // Assets ----------------------------------------------------------------
  { code: "1000", name: "Cash — Operating", type: "asset", normalBalance: "debit", subtype: "cash" },
  { code: "1010", name: "Cash — Restricted", type: "asset", normalBalance: "debit", subtype: "cash" },
  { code: "1100", name: "Accounts Receivable", type: "asset", normalBalance: "debit", subtype: "ar" },
  { code: "1200", name: "Prepaid Expenses", type: "asset", normalBalance: "debit", subtype: "prepaid" },
  { code: "1500", name: "Fixed Assets", type: "asset", normalBalance: "debit", subtype: "fixed_assets" },
  { code: "1510", name: "Accumulated Depreciation", type: "asset", normalBalance: "credit", subtype: "fixed_assets" },

  // Liabilities -----------------------------------------------------------
  { code: "2000", name: "Accounts Payable", type: "liability", normalBalance: "credit", subtype: "ap" },
  { code: "2010", name: "Accrued Expenses", type: "liability", normalBalance: "credit", subtype: "accrued" },
  { code: "2100", name: "Credit Card Payable", type: "liability", normalBalance: "credit", subtype: "credit_card" },

  // Equity / Net Assets ---------------------------------------------------
  { code: "3000", name: "Net Assets — Unrestricted", type: "equity", normalBalance: "credit", subtype: "net_assets" },
  { code: "3100", name: "Net Assets — With Donor Restrictions", type: "equity", normalBalance: "credit", subtype: "net_assets" },

  // Revenue ---------------------------------------------------------------
  { code: "4000", name: "Contributions — Unrestricted", type: "revenue", normalBalance: "credit", subtype: "contributions" },
  { code: "4100", name: "Contributions — Restricted", type: "revenue", normalBalance: "credit", subtype: "contributions" },
  { code: "4200", name: "Grant Revenue", type: "revenue", normalBalance: "credit", subtype: "grants" },
  { code: "4300", name: "Program Service Revenue", type: "revenue", normalBalance: "credit", subtype: "program_revenue" },

  // Cost of Goods / Direct Program Costs ----------------------------------
  { code: "5000", name: "Direct Program Costs", type: "expense", normalBalance: "debit", subtype: "program" },

  // Operating Expenses (6xxx block) --------------------------------------
  { code: "6000", name: "Salaries & Wages", type: "expense", normalBalance: "debit", subtype: "payroll" },
  { code: "6100", name: "Benefits & Payroll Taxes", type: "expense", normalBalance: "debit", subtype: "payroll" },
  { code: "6200", name: "Occupancy", type: "expense", normalBalance: "debit", subtype: "occupancy" },
  { code: "6210", name: "Rent", type: "expense", normalBalance: "debit", subtype: "occupancy" },
  { code: "6220", name: "Utilities", type: "expense", normalBalance: "debit", subtype: "occupancy" },
  { code: "6300", name: "Software & Subscriptions", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6400", name: "Office Supplies", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6500", name: "Travel & Meals", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6600", name: "Professional Fees", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6700", name: "Insurance", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6800", name: "Bank & Processing Fees", type: "expense", normalBalance: "debit", subtype: "operating" },
  { code: "6900", name: "Miscellaneous Expense", type: "expense", normalBalance: "debit", subtype: "operating" },
];

const DEFAULT_ACCOUNT_CODES = new Set(DEFAULT_ACCOUNTS.map((a) => a.code));

/** True iff a string looks like a recognizable account code (digits, optionally with a dash/dot). */
function looksLikeAccountCode(s: string): boolean {
  return /^[0-9]{3,8}([.\-][0-9A-Za-z]+)?$/.test(s.trim());
}

/**
 * Best-effort extraction of a code from a free-text account string the
 * older copilot may have produced (e.g. "6210", "6210 - Rent", "Rent").
 * Returns null if no leading code is detectable.
 */
export function extractCodeFromLegacyAccountString(s: string): string | null {
  const trimmed = s.trim();
  if (looksLikeAccountCode(trimmed)) return trimmed;
  const m = trimmed.match(/^([0-9]{3,8})(?:[\s\-:.]|$)/);
  return m ? m[1]! : null;
}

export async function seedChartOfAccountsAndSettings(): Promise<{
  accountsInserted: number;
  settingsInserted: boolean;
  backfilledLines: number;
  unmappedAccounts: string[];
}> {
  // -------- 1. Insert default CoA rows (skip on conflict) ----------------
  const inserts: ChartOfAccountInsert[] = DEFAULT_ACCOUNTS.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type,
    normalBalance: a.normalBalance,
    subtype: a.subtype ?? null,
    description: a.description ?? null,
    isSystem: true,
    isActive: true,
    allowManualPosting: a.allowManualPosting ?? true,
  }));
  const insertedDefaults = await db
    .insert(chartOfAccountsTable)
    .values(inserts)
    .onConflictDoNothing({ target: chartOfAccountsTable.code })
    .returning({ id: chartOfAccountsTable.id });

  // -------- 2. Settings singleton ----------------------------------------
  const existingSettings = await db.select().from(accountingSettingsTable).limit(1);
  let settingsInserted = false;
  if (existingSettings.length === 0) {
    // Pull defaults that exist now (post-CoA-seed).
    const accountsByCode = new Map<string, number>();
    const allCoa = await db
      .select({ id: chartOfAccountsTable.id, code: chartOfAccountsTable.code })
      .from(chartOfAccountsTable);
    for (const r of allCoa) accountsByCode.set(r.code, r.id);
    await db.insert(accountingSettingsTable).values({
      accountingMethod: "accrual",
      separationOfDuties: true,
      defaultCashAccountId: accountsByCode.get("1000") ?? null,
      defaultApAccountId: accountsByCode.get("2000") ?? null,
      defaultArAccountId: accountsByCode.get("1100") ?? null,
      defaultExpenseClearingAccountId: accountsByCode.get("6900") ?? null,
      defaultRoundingAccountId: accountsByCode.get("6900") ?? null,
      receiptRequiredOverCents: 7500,
      periodCloseRequiresAdmin: true,
    });
    settingsInserted = true;
  }

  // -------- 3. Historical backfill of journal_entry_lines.account_id ----
  // Only touch rows where account_id IS NULL.
  const nullRows = await db
    .select({
      id: journalEntryLinesTable.id,
      account: journalEntryLinesTable.account,
    })
    .from(journalEntryLinesTable)
    .where(isNull(journalEntryLinesTable.accountId));

  let backfilled = 0;
  const unmapped = new Set<string>();
  if (nullRows.length > 0) {
    // Build a map: distinct legacy account string → CoA id (creating
    // non-system rows for any string that doesn't match a seeded code).
    const distinct = Array.from(new Set(nullRows.map((r) => r.account)));
    const linkMap = new Map<string, number>();

    // Look up or create per distinct string.
    for (const raw of distinct) {
      const code = extractCodeFromLegacyAccountString(raw);
      if (code && DEFAULT_ACCOUNT_CODES.has(code)) {
        const [hit] = await db
          .select({ id: chartOfAccountsTable.id })
          .from(chartOfAccountsTable)
          .where(eq(chartOfAccountsTable.code, code))
          .limit(1);
        if (hit) {
          linkMap.set(raw, hit.id);
          continue;
        }
      }
      // Try literal-string match first (covers prior backfill runs and
      // any explicitly-entered legacy account name).
      const [byName] = await db
        .select({ id: chartOfAccountsTable.id })
        .from(chartOfAccountsTable)
        .where(eq(chartOfAccountsTable.code, raw.trim()))
        .limit(1);
      if (byName) {
        linkMap.set(raw, byName.id);
        continue;
      }
      // Otherwise mint a non-system, archived-by-default placeholder so
      // the FK can be filled without polluting the active CoA. We mark
      // these `is_active=false, allow_manual_posting=false` so future
      // postings cannot reference them — they exist purely to preserve
      // historical linkage.
      unmapped.add(raw);
      // Deterministic, collision-resistant placeholder code: short prefix
      // of the legacy string + 10-hex-char SHA-256 suffix so distinct
      // legacy strings sharing the same first 32 chars get distinct CoA
      // rows (and re-running the backfill is idempotent).
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256")
        .update(raw)
        .digest("hex")
        .slice(0, 10);
      const safePrefix = raw.trim().slice(0, 24).replace(/[^A-Za-z0-9._\- ]/g, "_");
      const placeholderCode = `LEGACY-${safePrefix}-${hash}`;
      const [created] = await db
        .insert(chartOfAccountsTable)
        .values({
          code: placeholderCode,
          name: `Legacy account: ${raw}`,
          description: `Auto-created during Step 9 CoA backfill from historical free-text JE line "${raw}". Inactive — kept for audit trail only.`,
          type: "expense",
          normalBalance: "debit",
          isSystem: false,
          isActive: false,
          allowManualPosting: false,
        })
        .onConflictDoNothing({ target: chartOfAccountsTable.code })
        .returning({ id: chartOfAccountsTable.id });
      if (created) {
        linkMap.set(raw, created.id);
      } else {
        // Conflict — fetch existing.
        const [existing] = await db
          .select({ id: chartOfAccountsTable.id })
          .from(chartOfAccountsTable)
          .where(eq(chartOfAccountsTable.code, placeholderCode))
          .limit(1);
        if (existing) linkMap.set(raw, existing.id);
      }
    }

    // Bulk update — group by linkMap value.
    const grouped = new Map<number, number[]>();
    for (const r of nullRows) {
      const id = linkMap.get(r.account);
      if (id === undefined) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id)!.push(r.id);
    }
    for (const [accountId, lineIds] of grouped) {
      const result = await db
        .update(journalEntryLinesTable)
        .set({ accountId })
        .where(inArray(journalEntryLinesTable.id, lineIds))
        .returning({ id: journalEntryLinesTable.id });
      backfilled += result.length;
    }
  }

  return {
    accountsInserted: insertedDefaults.length,
    settingsInserted,
    backfilledLines: backfilled,
    unmappedAccounts: Array.from(unmapped),
  };
}

/**
 * Fast read: resolve a free-text account string to an active CoA row.
 * Used by the posting validator. Returns null if no active CoA row matches.
 */
export async function resolveAccountByCodeOrText(input: string): Promise<
  | { id: number; code: string; isActive: boolean; allowManualPosting: boolean }
  | null
> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const code = extractCodeFromLegacyAccountString(trimmed) ?? trimmed;
  const [row] = await db
    .select({
      id: chartOfAccountsTable.id,
      code: chartOfAccountsTable.code,
      isActive: chartOfAccountsTable.isActive,
      allowManualPosting: chartOfAccountsTable.allowManualPosting,
    })
    .from(chartOfAccountsTable)
    .where(eq(chartOfAccountsTable.code, code))
    .limit(1);
  return row ?? null;
}

// Suppress unused-warnings for sql import (kept for future ad-hoc queries).
void sql;
