/**
 * Task #52 — Bridge expense approvals into the manual JE draft workflow.
 *
 * generateDraftFromExpense(expenseId, actor) is the single entry point.
 * It is invoked from:
 *   - POST /expenses/:id/approve            (post-approval hook)
 *   - POST /expenses/:id/regenerate-accounting-draft  (manual retry)
 *
 * Idempotency model:
 *   The function is wrapped in a SERIALIZABLE-style transaction *and*
 *   the underlying DB carries a UNIQUE (source_type, source_id) on
 *   accounting_source_links. Either guard catches duplicate work — even
 *   across two parallel approvers double-clicking the button — and we
 *   simply return the existing linked draft.
 *
 * No auto-submit, no auto-post: the generated row is a vanilla manual
 * draft with status='draft' and goes through the existing maker/checker
 * controls before it can ever touch the ledger.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import {
  db,
  expensesTable,
  expenseCategoriesTable,
  expenseCategoryPaymentMethodRulesTable,
  manualJournalEntryDraftsTable,
  accountingSourceLinksTable,
  chartOfAccountsTable,
  activityLogTable,
  usersTable,
  type ManualJournalEntryDraftRow,
} from "@workspace/db";
import { logger } from "./logger";

export const ACCOUNTING_BLOCK_REASONS = [
  "missing_category",
  "missing_mapping",
  "archived_account",
  "non_postable_account",
  "invalid_payment_method_rule",
  "other",
] as const;
export type AccountingBlockReason = (typeof ACCOUNTING_BLOCK_REASONS)[number];

export type ExpenseDraftActor = {
  id?: number | null;
  display: string;
};

export type GenerateDraftResult =
  | {
      ok: true;
      created: boolean;
      draftId: number;
      draft: ManualJournalEntryDraftRow;
    }
  | {
      ok: false;
      reason: AccountingBlockReason;
      message: string;
    };

function buildMemo(e: {
  merchant: string;
  description: string;
  id: number;
}): string {
  // Deterministic per spec: <merchant> — <description> (expense #<ref>)
  // Truncated lightly so it always fits the draft memo limit.
  const merchant = (e.merchant ?? "").trim();
  const description = (e.description ?? "").trim();
  const base = `${merchant} — ${description} (expense #${e.id})`;
  return base.length > 1900 ? base.slice(0, 1900) : base;
}

async function writeBlocked(args: {
  expenseId: number;
  reason: AccountingBlockReason;
  actor: ExpenseDraftActor;
  message: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(expensesTable)
      .set({
        accountingStatus: "blocked",
        accountingBlockReason: args.reason,
        updatedAt: new Date(),
      })
      .where(eq(expensesTable.id, args.expenseId));

    await tx.insert(activityLogTable).values({
      type: "accounting_draft_generation_blocked",
      description: `Accounting draft generation blocked for expense #${args.expenseId}: ${args.message}`,
      actor: args.actor.display,
      actorUserId: args.actor.id ?? null,
      referenceId: args.expenseId,
      referenceType: "expense",
      metadata: { reason: args.reason, message: args.message },
    });
  });
}

export async function generateDraftFromExpense(
  expenseId: number,
  actor: ExpenseDraftActor,
): Promise<GenerateDraftResult> {
  // 1. Fast-path idempotency: if a link already exists outside any
  //    transaction, return it. Avoids touching anything else.
  const [existingLink] = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "expense"),
        eq(accountingSourceLinksTable.sourceId, expenseId),
      ),
    )
    .limit(1);

  if (existingLink && existingLink.manualJournalEntryDraftId) {
    const [existingDraft] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(
        eq(
          manualJournalEntryDraftsTable.id,
          existingLink.manualJournalEntryDraftId,
        ),
      )
      .limit(1);
    if (existingDraft) {
      return {
        ok: true,
        created: false,
        draftId: existingDraft.id,
        draft: existingDraft,
      };
    }
  }

  // 2. Resolve mapping outside the write tx — read-only validations.
  const [expense] = await db
    .select()
    .from(expensesTable)
    .where(eq(expensesTable.id, expenseId))
    .limit(1);

  if (!expense) {
    return {
      ok: false,
      reason: "other",
      message: `Expense ${expenseId} not found`,
    };
  }

  if (!expense.categoryId) {
    await writeBlocked({
      expenseId,
      reason: "missing_category",
      actor,
      message: "Expense has no category mapping",
    });
    return {
      ok: false,
      reason: "missing_category",
      message: "Expense has no category mapping",
    };
  }

  const [category] = await db
    .select()
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.id, expense.categoryId))
    .limit(1);

  if (!category) {
    await writeBlocked({
      expenseId,
      reason: "missing_category",
      actor,
      message: "Linked category does not exist",
    });
    return {
      ok: false,
      reason: "missing_category",
      message: "Linked category does not exist",
    };
  }

  // Resolve payment-method rule: exact paymentMethod first, otherwise
  // the category's isDefault rule.
  const ruleCandidates = await db
    .select()
    .from(expenseCategoryPaymentMethodRulesTable)
    .where(
      and(
        eq(expenseCategoryPaymentMethodRulesTable.categoryId, category.id),
        or(
          eq(
            expenseCategoryPaymentMethodRulesTable.paymentMethod,
            expense.paymentMethod,
          ),
          eq(expenseCategoryPaymentMethodRulesTable.isDefault, true),
        ),
      ),
    );

  const exactRule = ruleCandidates.find(
    (r) => r.paymentMethod === expense.paymentMethod,
  );
  const defaultRule = ruleCandidates.find((r) => r.isDefault);
  const rule = exactRule ?? defaultRule;

  if (!rule) {
    await writeBlocked({
      expenseId,
      reason: "invalid_payment_method_rule",
      actor,
      message: `No payment-method rule found for category #${category.id} (paymentMethod=${expense.paymentMethod})`,
    });
    return {
      ok: false,
      reason: "invalid_payment_method_rule",
      message: "No payment-method rule found",
    };
  }

  // Validate both accounts: must be active AND manual-postable.
  const accountIds = [category.debitAccountId, rule.creditAccountId];
  const accounts = await db
    .select()
    .from(chartOfAccountsTable)
    .where(
      or(
        eq(chartOfAccountsTable.id, accountIds[0]!),
        eq(chartOfAccountsTable.id, accountIds[1]!),
      ),
    );

  const debitAcct = accounts.find((a) => a.id === category.debitAccountId);
  const creditAcct = accounts.find((a) => a.id === rule.creditAccountId);

  if (!debitAcct || !creditAcct) {
    await writeBlocked({
      expenseId,
      reason: "missing_mapping",
      actor,
      message: "Mapped account record not found",
    });
    return {
      ok: false,
      reason: "missing_mapping",
      message: "Mapped account record not found",
    };
  }

  if (!debitAcct.isActive || !creditAcct.isActive) {
    const which = !debitAcct.isActive ? debitAcct.code : creditAcct.code;
    await writeBlocked({
      expenseId,
      reason: "archived_account",
      actor,
      message: `Account ${which} is archived`,
    });
    return {
      ok: false,
      reason: "archived_account",
      message: `Account ${which} is archived`,
    };
  }

  if (!debitAcct.allowManualPosting || !creditAcct.allowManualPosting) {
    const which = !debitAcct.allowManualPosting
      ? debitAcct.code
      : creditAcct.code;
    await writeBlocked({
      expenseId,
      reason: "non_postable_account",
      actor,
      message: `Account ${which} is not manually postable`,
    });
    return {
      ok: false,
      reason: "non_postable_account",
      message: `Account ${which} is not manually postable`,
    };
  }

  // 3. All validation passed — build payload and insert inside a tx.
  //    The UNIQUE on accounting_source_links is the definitive idempotency
  //    fence even under parallel approval calls.
  const amountStr = String(expense.amount);
  const memo = buildMemo({
    merchant: expense.merchant,
    description: expense.description,
    id: expense.id,
  });
  const programIdStr = expense.programId != null ? String(expense.programId) : "";

  const payload = {
    entryDate: expense.expenseDate,
    memo,
    lines: [
      {
        type: "debit" as const,
        accountCode: debitAcct.code,
        amount: amountStr,
        program: programIdStr,
        fund: "",
        memo,
      },
      {
        type: "credit" as const,
        accountCode: creditAcct.code,
        amount: amountStr,
        program: programIdStr,
        fund: "",
        memo,
      },
    ],
  };

  try {
    return await db.transaction(async (tx) => {
      // Re-resolve mapping/account state INSIDE the tx so determinism
      // holds even if a category, rule, or account was archived between
      // our outer read and this insert. If anything regressed, throw a
      // typed marker so the outer catch can write the proper block row.
      const [expenseInTx] = await tx
        .select()
        .from(expensesTable)
        .where(eq(expensesTable.id, expenseId))
        .limit(1);
      if (!expenseInTx || !expenseInTx.categoryId) {
        throw new BlockInTxError("missing_category", "Expense lost its category mid-transaction");
      }
      const [categoryInTx] = await tx
        .select()
        .from(expenseCategoriesTable)
        .where(eq(expenseCategoriesTable.id, expenseInTx.categoryId))
        .limit(1);
      if (!categoryInTx) {
        throw new BlockInTxError("missing_category", "Linked category disappeared mid-transaction");
      }
      const ruleCandidatesInTx = await tx
        .select()
        .from(expenseCategoryPaymentMethodRulesTable)
        .where(
          and(
            eq(expenseCategoryPaymentMethodRulesTable.categoryId, categoryInTx.id),
            or(
              eq(
                expenseCategoryPaymentMethodRulesTable.paymentMethod,
                expenseInTx.paymentMethod,
              ),
              eq(expenseCategoryPaymentMethodRulesTable.isDefault, true),
            ),
          ),
        );
      const ruleInTx =
        ruleCandidatesInTx.find((r) => r.paymentMethod === expenseInTx.paymentMethod) ??
        ruleCandidatesInTx.find((r) => r.isDefault);
      if (!ruleInTx) {
        throw new BlockInTxError(
          "invalid_payment_method_rule",
          "No payment-method rule found mid-transaction",
        );
      }
      const accountsInTx = await tx
        .select()
        .from(chartOfAccountsTable)
        .where(
          or(
            eq(chartOfAccountsTable.id, categoryInTx.debitAccountId),
            eq(chartOfAccountsTable.id, ruleInTx.creditAccountId),
          ),
        );
      const debitInTx = accountsInTx.find((a) => a.id === categoryInTx.debitAccountId);
      const creditInTx = accountsInTx.find((a) => a.id === ruleInTx.creditAccountId);
      if (!debitInTx || !creditInTx) {
        throw new BlockInTxError("missing_mapping", "Mapped account record disappeared");
      }
      if (!debitInTx.isActive || !creditInTx.isActive) {
        const which = !debitInTx.isActive ? debitInTx.code : creditInTx.code;
        throw new BlockInTxError("archived_account", `Account ${which} is archived`);
      }
      if (!debitInTx.allowManualPosting || !creditInTx.allowManualPosting) {
        const which = !debitInTx.allowManualPosting ? debitInTx.code : creditInTx.code;
        throw new BlockInTxError(
          "non_postable_account",
          `Account ${which} is not manually postable`,
        );
      }

      // Re-check link inside tx to avoid a race where two callers passed
      // the outer fast-path check simultaneously.
      const [linkInTx] = await tx
        .select()
        .from(accountingSourceLinksTable)
        .where(
          and(
            eq(accountingSourceLinksTable.sourceType, "expense"),
            eq(accountingSourceLinksTable.sourceId, expenseId),
          ),
        )
        .limit(1);

      if (linkInTx && linkInTx.manualJournalEntryDraftId) {
        const [draftRow] = await tx
          .select()
          .from(manualJournalEntryDraftsTable)
          .where(
            eq(
              manualJournalEntryDraftsTable.id,
              linkInTx.manualJournalEntryDraftId,
            ),
          )
          .limit(1);
        if (draftRow) {
          return {
            ok: true as const,
            created: false,
            draftId: draftRow.id,
            draft: draftRow,
          };
        }
      }

      // We need a non-null createdByUserId. If actor.id is missing,
      // fall back to one of the seeded admin users so the FK holds.
      let cbu = actor.id ?? null;
      if (!cbu) {
        const [anyAdmin] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.role, "admin"))
          .limit(1);
        cbu = anyAdmin?.id ?? null;
      }

      if (!cbu) {
        // No admin to attribute creation to — surface as 'other' block.
        throw new BlockInTxError("other", "No attributable user for draft creation");
      }

      const [draft] = await tx
        .insert(manualJournalEntryDraftsTable)
        .values({
          createdByUserId: cbu,
          entryDate: expenseInTx.expenseDate,
          memo,
          payload,
          status: "draft",
          version: 0,
        })
        .returning();

      if (!draft) {
        throw new Error("DRAFT_INSERT_FAILED");
      }

      // Insert the source link. UNIQUE (source_type, source_id) is the
      // definitive idempotency fence; on PG 23505 (unique violation)
      // for our specific constraint we treat it as a lost race and
      // re-fetch the winning row outside this tx.
      try {
        await tx.insert(accountingSourceLinksTable).values({
          sourceType: "expense",
          sourceId: expenseId,
          manualJournalEntryDraftId: draft.id,
          journalEntryId: null,
          createdByUserId: cbu,
        });
      } catch (e: unknown) {
        if (isAccountingSourceLinkUniqueViolation(e)) {
          throw new RaceLostError();
        }
        throw e;
      }

      await tx
        .update(expensesTable)
        .set({
          accountingStatus: "draft_created",
          accountingBlockReason: null,
          accountingGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(expensesTable.id, expenseId));

      await tx.insert(activityLogTable).values([
        {
          type: "accounting_draft_generated_from_expense",
          description: `Accounting draft #${draft.id} generated from expense #${expenseId}`,
          actor: actor.display,
          actorUserId: actor.id ?? null,
          amount: amountStr,
          referenceId: draft.id,
          referenceType: "manual_je_draft",
          metadata: {
            expenseId,
            debitAccountCode: debitAcct.code,
            creditAccountCode: creditAcct.code,
          },
        },
        {
          type: "accounting_draft_created",
          description: `Expense #${expenseId} produced accounting draft #${draft.id}`,
          actor: actor.display,
          actorUserId: actor.id ?? null,
          amount: amountStr,
          referenceId: expenseId,
          referenceType: "expense",
          metadata: { manualJournalEntryDraftId: draft.id },
        },
      ]);

      return {
        ok: true as const,
        created: true,
        draftId: draft.id,
        draft,
      };
    });
  } catch (e: unknown) {
    if (e instanceof BlockInTxError) {
      await writeBlocked({
        expenseId,
        reason: e.reason,
        actor,
        message: e.message,
      });
      return { ok: false, reason: e.reason, message: e.message };
    }
    if (e instanceof RaceLostError) {
      // Re-fetch the winning link/draft outside of any tx.
      const [winLink] = await db
        .select()
        .from(accountingSourceLinksTable)
        .where(
          and(
            eq(accountingSourceLinksTable.sourceType, "expense"),
            eq(accountingSourceLinksTable.sourceId, expenseId),
          ),
        )
        .limit(1);
      if (winLink && winLink.manualJournalEntryDraftId) {
        const [winDraft] = await db
          .select()
          .from(manualJournalEntryDraftsTable)
          .where(
            eq(
              manualJournalEntryDraftsTable.id,
              winLink.manualJournalEntryDraftId,
            ),
          )
          .limit(1);
        if (winDraft) {
          return {
            ok: true,
            created: false,
            draftId: winDraft.id,
            draft: winDraft,
          };
        }
      }
      // Fall through to generic block.
    }

    const msg = (e as { message?: string })?.message ?? String(e);
    logger.error({ err: e, expenseId }, "expenseDraftService failure");
    await writeBlocked({
      expenseId,
      reason: "other",
      actor,
      message: `Internal error generating draft: ${msg}`,
    });
    return {
      ok: false,
      reason: "other",
      message: msg,
    };
  }
}

class RaceLostError extends Error {
  constructor() {
    super("RACE_LOST");
  }
}

class BlockInTxError extends Error {
  constructor(
    public readonly reason: AccountingBlockReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Robust detection of a unique-violation against the
 * accounting_source_links_source_uniq index. PostgreSQL surfaces error
 * code 23505 with the constraint name; we check both rather than
 * substring-matching the message text (which varies across drivers and
 * locales). Falls back to a name check for safety.
 */
function isAccountingSourceLinkUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
  const isUniqueViolation = err.code === "23505";
  const constraint = err.constraint ?? err.constraint_name ?? "";
  if (isUniqueViolation && constraint === "accounting_source_links_source_uniq") {
    return true;
  }
  if (isUniqueViolation && constraint.startsWith("accounting_source_links_")) {
    return true;
  }
  // Last-ditch fallback for drivers that do not surface the constraint
  // name on the error object.
  if (isUniqueViolation && (err.message ?? "").includes("accounting_source_links_source_uniq")) {
    return true;
  }
  return false;
}

// Avoid unused import warnings on `isNull`; reserved for future "only
// re-link if currently null" recovery flows.
void isNull;
