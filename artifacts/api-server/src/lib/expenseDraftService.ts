/**
 * Task #52 — Bridge expense approvals into the manual JE draft workflow.
 *
 * generateDraftFromExpense(expenseId, actor) is the single entry point.
 * It is invoked from:
 *   - POST /expenses/:id/approve            (post-approval hook)
 *   - POST /expenses/:id/regenerate-accounting-draft  (manual retry)
 *
 * Idempotency model — two database-level fences:
 *   1. UNIQUE (source_type, source_id) on accounting_source_links
 *   2. UNIQUE idempotency_key on accounting_source_links, where the key
 *      is the deterministic string `expense-draft-<expenseId>`
 * Either guard catches duplicate work — even across two parallel
 * approvers double-clicking the button — and we re-fetch and return the
 * winning row instead of producing a second draft.
 *
 * No auto-submit, no auto-post: the generated row is a vanilla manual
 * draft with status='draft' and goes through the existing maker/checker
 * controls before it can ever touch the ledger.
 */

import { and, eq, or } from "drizzle-orm";
import {
  db,
  expensesTable,
  expenseCategoriesTable,
  expenseCategoryPaymentMethodRulesTable,
  manualJournalEntryDraftsTable,
  accountingSourceLinksTable,
  chartOfAccountsTable,
  activityLogTable,
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
  id: number;
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

export function expenseDraftIdempotencyKey(expenseId: number): string {
  return `expense-draft-${expenseId}`;
}

function buildMemo(e: {
  merchant: string;
  description: string;
  id: number;
}): string {
  // Deterministic per spec: <merchant> — <description> (expense #<ref>)
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
      actorUserId: args.actor.id,
      referenceId: args.expenseId,
      referenceType: "expense",
      metadata: { reason: args.reason, message: args.message },
    });
  });
}

async function fetchExistingByKey(
  key: string,
): Promise<ManualJournalEntryDraftRow | null> {
  const [link] = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(eq(accountingSourceLinksTable.idempotencyKey, key))
    .limit(1);
  if (!link || !link.manualJournalEntryDraftId) return null;
  const [draft] = await db
    .select()
    .from(manualJournalEntryDraftsTable)
    .where(eq(manualJournalEntryDraftsTable.id, link.manualJournalEntryDraftId))
    .limit(1);
  return draft ?? null;
}

export async function generateDraftFromExpense(
  expenseId: number,
  actor: ExpenseDraftActor,
): Promise<GenerateDraftResult> {
  const idempotencyKey = expenseDraftIdempotencyKey(expenseId);

  // Fast-path: if the deterministic key is already present, return the
  // winning draft without opening a write transaction.
  const existing = await fetchExistingByKey(idempotencyKey);
  if (existing) {
    return { ok: true, created: false, draftId: existing.id, draft: existing };
  }

  try {
    return await db.transaction(async (tx) => {
      // Re-resolve mapping/account state INSIDE the tx so determinism
      // holds even if a category, rule, or account was archived between
      // our first read and this insert. Block reasons are surfaced via
      // a typed marker so the outer catch can write the audit row.
      const [expense] = await tx
        .select()
        .from(expensesTable)
        .where(eq(expensesTable.id, expenseId))
        .limit(1);
      if (!expense) {
        throw new BlockInTxError("other", `Expense ${expenseId} not found`);
      }
      // Defense-in-depth: only approved expenses generate accounting drafts.
      // Both call sites already enforce this, but reasserting here keeps
      // the service-level invariant explicit if a future caller is added.
      if (expense.status !== "approved") {
        throw new BlockInTxError(
          "other",
          `Expense #${expenseId} is not in 'approved' state (status=${expense.status})`,
        );
      }
      if (!expense.categoryId) {
        throw new BlockInTxError(
          "missing_category",
          "Expense has no category mapping",
        );
      }

      const [category] = await tx
        .select()
        .from(expenseCategoriesTable)
        .where(eq(expenseCategoriesTable.id, expense.categoryId))
        .limit(1);
      if (!category) {
        throw new BlockInTxError(
          "missing_category",
          "Linked category does not exist",
        );
      }

      // Payment-method rule lookup: exact paymentMethod first, otherwise
      // the category's isDefault fallback.
      const ruleCandidates = await tx
        .select()
        .from(expenseCategoryPaymentMethodRulesTable)
        .where(
          and(
            eq(
              expenseCategoryPaymentMethodRulesTable.categoryId,
              category.id,
            ),
            or(
              eq(
                expenseCategoryPaymentMethodRulesTable.paymentMethod,
                expense.paymentMethod,
              ),
              eq(expenseCategoryPaymentMethodRulesTable.isDefault, true),
            ),
          ),
        );
      const rule =
        ruleCandidates.find((r) => r.paymentMethod === expense.paymentMethod) ??
        ruleCandidates.find((r) => r.isDefault);
      if (!rule) {
        throw new BlockInTxError(
          "invalid_payment_method_rule",
          `No payment-method rule for category #${category.id} (paymentMethod=${expense.paymentMethod})`,
        );
      }

      const accounts = await tx
        .select()
        .from(chartOfAccountsTable)
        .where(
          or(
            eq(chartOfAccountsTable.id, category.debitAccountId),
            eq(chartOfAccountsTable.id, rule.creditAccountId),
          ),
        );
      const debit = accounts.find((a) => a.id === category.debitAccountId);
      const credit = accounts.find((a) => a.id === rule.creditAccountId);
      if (!debit || !credit) {
        throw new BlockInTxError(
          "missing_mapping",
          "Mapped account record not found",
        );
      }
      if (!debit.isActive || !credit.isActive) {
        const which = !debit.isActive ? debit.code : credit.code;
        throw new BlockInTxError(
          "archived_account",
          `Account ${which} is archived`,
        );
      }
      if (!debit.allowManualPosting || !credit.allowManualPosting) {
        const which = !debit.allowManualPosting ? debit.code : credit.code;
        throw new BlockInTxError(
          "non_postable_account",
          `Account ${which} is not manually postable`,
        );
      }

      // Re-check the link inside the tx to converge with concurrent
      // callers that passed the outer fast-path simultaneously.
      const [linkInTx] = await tx
        .select()
        .from(accountingSourceLinksTable)
        .where(eq(accountingSourceLinksTable.idempotencyKey, idempotencyKey))
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

      const amountStr = String(expense.amount);
      const memo = buildMemo({
        merchant: expense.merchant,
        description: expense.description,
        id: expense.id,
      });
      const programIdStr =
        expense.programId != null ? String(expense.programId) : "";

      const payload = {
        entryDate: expense.expenseDate,
        memo,
        lines: [
          {
            type: "debit" as const,
            accountCode: debit.code,
            amount: amountStr,
            program: programIdStr,
            fund: "",
            memo,
          },
          {
            type: "credit" as const,
            accountCode: credit.code,
            amount: amountStr,
            program: programIdStr,
            fund: "",
            memo,
          },
        ],
      };

      const [draft] = await tx
        .insert(manualJournalEntryDraftsTable)
        .values({
          createdByUserId: actor.id,
          entryDate: expense.expenseDate,
          memo,
          payload,
          status: "draft",
          version: 0,
        })
        .returning();
      if (!draft) {
        throw new Error("Draft insert returned no row");
      }

      try {
        await tx.insert(accountingSourceLinksTable).values({
          sourceType: "expense",
          sourceId: expenseId,
          idempotencyKey,
          manualJournalEntryDraftId: draft.id,
          journalEntryId: null,
          createdByUserId: actor.id,
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
          actorUserId: actor.id,
          amount: amountStr,
          referenceId: draft.id,
          referenceType: "manual_je_draft",
          metadata: {
            expenseId,
            idempotencyKey,
            debitAccountCode: debit.code,
            creditAccountCode: credit.code,
          },
        },
        {
          type: "accounting_draft_created",
          description: `Expense #${expenseId} produced accounting draft #${draft.id}`,
          actor: actor.display,
          actorUserId: actor.id,
          amount: amountStr,
          referenceId: expenseId,
          referenceType: "expense",
          metadata: {
            manualJournalEntryDraftId: draft.id,
            idempotencyKey,
          },
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
      const winner = await fetchExistingByKey(idempotencyKey);
      if (winner) {
        return { ok: true, created: false, draftId: winner.id, draft: winner };
      }
    }

    const msg = (e as { message?: string })?.message ?? String(e);
    logger.error({ err: e, expenseId }, "expenseDraftService failure");
    await writeBlocked({
      expenseId,
      reason: "other",
      actor,
      message: `Internal error generating draft: ${msg}`,
    });
    return { ok: false, reason: "other", message: msg };
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
 * Robust detection of a unique-violation against either fence on
 * accounting_source_links. PostgreSQL surfaces error code 23505 with
 * the constraint name; we check both rather than substring-matching
 * the message text, which varies across drivers and locales.
 */
function isAccountingSourceLinkUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
  if (err.code !== "23505") return false;
  const constraint = err.constraint ?? err.constraint_name ?? "";
  if (
    constraint === "accounting_source_links_source_event_uniq" ||
    constraint === "accounting_source_links_idem_key_uniq"
  ) {
    return true;
  }
  // Fallback for drivers that omit constraint metadata.
  const msg = err.message ?? "";
  return (
    msg.includes("accounting_source_links_source_event_uniq") ||
    msg.includes("accounting_source_links_idem_key_uniq")
  );
}
