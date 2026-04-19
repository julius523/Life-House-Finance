/**
 * Task #51 — Seed the "Uncategorized" expense category and backfill any
 * existing expenses to it.
 *
 * Idempotent: safe to call on every server boot.
 *  - Creates the system category only if it does not already exist.
 *  - Creates a default credit-rule for it (paymentMethod="other",
 *    isDefault=true) so legacy backfilled expenses can still resolve a
 *    credit account if generation is ever attempted on them.
 *  - Backfills expenses.category_id for any rows where it is currently
 *    NULL.
 */

import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  chartOfAccountsTable,
  expenseCategoriesTable,
  expenseCategoryPaymentMethodRulesTable,
  expensesTable,
} from "@workspace/db";

const UNCATEGORIZED_NAME = "Uncategorized";
// 6900 — Miscellaneous Expense (debit) and 2100 — Credit Card Payable
// (credit) are the most defensible defaults: both come from the seeded
// system CoA and both are active + manually-postable.
const DEFAULT_DEBIT_CODE = "6900";
const DEFAULT_CREDIT_CODE = "2100";

export async function seedExpenseCategories(): Promise<{
  categoryCreated: boolean;
  ruleCreated: boolean;
  expensesBackfilled: number;
}> {
  // Look up the seed account ids; bail gracefully if CoA seed has not
  // run yet (the bootstrap runs CoA seed before this).
  const [debitAcct] = await db
    .select({ id: chartOfAccountsTable.id })
    .from(chartOfAccountsTable)
    .where(eq(chartOfAccountsTable.code, DEFAULT_DEBIT_CODE))
    .limit(1);
  const [creditAcct] = await db
    .select({ id: chartOfAccountsTable.id })
    .from(chartOfAccountsTable)
    .where(eq(chartOfAccountsTable.code, DEFAULT_CREDIT_CODE))
    .limit(1);

  if (!debitAcct || !creditAcct) {
    return { categoryCreated: false, ruleCreated: false, expensesBackfilled: 0 };
  }

  // 1. Upsert the system "Uncategorized" row.
  let category: { id: number } | undefined;
  const [existing] = await db
    .select({ id: expenseCategoriesTable.id })
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.name, UNCATEGORIZED_NAME))
    .limit(1);
  let categoryCreated = false;
  if (existing) {
    category = existing;
    // Ensure the system flag is set even if a pre-existing row was created
    // outside the seed flow — the lock protections in PATCH/deactivate key
    // off isSystem so this row must always be marked.
    await db
      .update(expenseCategoriesTable)
      .set({ isSystem: true, isActive: true })
      .where(eq(expenseCategoriesTable.id, existing.id));
  } else {
    const [created] = await db
      .insert(expenseCategoriesTable)
      .values({
        name: UNCATEGORIZED_NAME,
        debitAccountId: debitAcct.id,
        isActive: true,
        isSystem: true,
      })
      .returning({ id: expenseCategoriesTable.id });
    category = created;
    categoryCreated = true;
  }
  if (!category) {
    return { categoryCreated, ruleCreated: false, expensesBackfilled: 0 };
  }

  // 2. Ensure at least one DEFAULT credit rule exists for it. (Checking
  // for *any* rule is insufficient — a non-default rule could otherwise
  // satisfy the check yet leave the category without a fallback.)
  const [existingDefaultRule] = await db
    .select({ id: expenseCategoryPaymentMethodRulesTable.id })
    .from(expenseCategoryPaymentMethodRulesTable)
    .where(
      and(
        eq(expenseCategoryPaymentMethodRulesTable.categoryId, category.id),
        eq(expenseCategoryPaymentMethodRulesTable.isDefault, true),
      ),
    )
    .limit(1);
  let ruleCreated = false;
  if (!existingDefaultRule) {
    await db
      .insert(expenseCategoryPaymentMethodRulesTable)
      .values({
        categoryId: category.id,
        paymentMethod: "other",
        creditAccountId: creditAcct.id,
        isDefault: true,
      });
    ruleCreated = true;
  }

  // 3. Backfill expenses with NULL categoryId.
  const result = await db
    .update(expensesTable)
    .set({ categoryId: category.id })
    .where(isNull(expensesTable.categoryId))
    .returning({ id: expensesTable.id });

  return {
    categoryCreated,
    ruleCreated,
    expensesBackfilled: result.length,
  };
}
