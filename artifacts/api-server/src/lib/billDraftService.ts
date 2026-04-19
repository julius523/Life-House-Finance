/**
 * Task #63 — Bridge bill approval (accrual) and bill payment (payment)
 * into the manual JE draft workflow. Mirrors expenseDraftService.
 *
 * Two entry points, one per lifecycle event:
 *   generateAccrualDraftFromBill(billId, actor)
 *     — at /bills/:id/approve. Dr expense / Cr A/P.
 *   generatePaymentDraftFromBill(billId, actor)
 *     — at /transactions/:id/link-bill and convert-to-bill.
 *       Dr A/P / Cr cash.
 *
 * Idempotency model — same DB-level fences as the expense bridge:
 *   1. UNIQUE (source_type, source_id, event_type) on accounting_source_links
 *   2. UNIQUE idempotency_key on accounting_source_links
 *
 * Generated drafts are vanilla manual drafts with status='draft'; they
 * still go through the maker/checker flow before posting.
 */

import { eq } from "drizzle-orm";
import {
  db,
  billsTable,
  vendorsTable,
  expenseCategoriesTable,
  manualJournalEntryDraftsTable,
  accountingSourceLinksTable,
  accountingSettingsTable,
  chartOfAccountsTable,
  activityLogTable,
  type ManualJournalEntryDraftRow,
} from "@workspace/db";
import { logger } from "./logger";

export const BILL_BLOCK_REASONS = [
  "missing_category",
  "missing_mapping",
  "archived_account",
  "non_postable_account",
  "missing_ap_account",
  "missing_cash_account",
  "other",
] as const;
export type BillBlockReason = (typeof BILL_BLOCK_REASONS)[number];

export type BillDraftActor = {
  id: number;
  display: string;
};

export type BillEventType = "accrual" | "payment";

export type GenerateBillDraftResult =
  | {
      ok: true;
      created: boolean;
      draftId: number;
      draft: ManualJournalEntryDraftRow;
    }
  | {
      ok: false;
      reason: BillBlockReason;
      message: string;
    };

export function billDraftIdempotencyKey(
  eventType: BillEventType,
  billId: number,
): string {
  return `bill-${eventType}-draft-${billId}`;
}

function buildAccrualMemo(args: {
  vendorName: string;
  description: string | null;
  billId: number;
}): string {
  const desc = (args.description ?? "").trim();
  const base = desc
    ? `${args.vendorName} — ${desc} (bill #${args.billId})`
    : `${args.vendorName} (bill #${args.billId})`;
  return base.length > 1900 ? base.slice(0, 1900) : base;
}

function buildPaymentMemo(args: {
  vendorName: string;
  billId: number;
}): string {
  return `Payment of bill #${args.billId} — ${args.vendorName}`.slice(0, 1900);
}

class BlockInTxError extends Error {
  constructor(
    public readonly reason: BillBlockReason,
    message: string,
  ) {
    super(message);
  }
}

class RaceLostError extends Error {
  constructor() {
    super("RACE_LOST");
  }
}

function isLinkUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; constraint?: string; constraint_name?: string; message?: string };
  if (err.code !== "23505") return false;
  const constraint = err.constraint ?? err.constraint_name ?? "";
  if (
    constraint === "accounting_source_links_source_event_uniq" ||
    constraint === "accounting_source_links_idem_key_uniq"
  ) {
    return true;
  }
  const msg = err.message ?? "";
  return (
    msg.includes("accounting_source_links_source_event_uniq") ||
    msg.includes("accounting_source_links_idem_key_uniq")
  );
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

async function writeBlocked(args: {
  billId: number;
  eventType: BillEventType;
  reason: BillBlockReason;
  actor: BillDraftActor;
  message: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const update: Record<string, unknown> =
      args.eventType === "accrual"
        ? {
            accountingStatus: "blocked",
            accountingBlockReason: args.reason,
          }
        : {
            accountingPaymentStatus: "blocked",
            accountingPaymentBlockReason: args.reason,
          };
    await tx
      .update(billsTable)
      .set(update)
      .where(eq(billsTable.id, args.billId));

    await tx.insert(activityLogTable).values({
      type: "bill_accounting_blocked",
      description: `Bill ${args.eventType} draft generation blocked for bill #${args.billId}: ${args.message}`,
      actor: args.actor.display,
      actorUserId: args.actor.id,
      referenceId: args.billId,
      referenceType: "bill",
      metadata: { reason: args.reason, message: args.message, eventType: args.eventType },
    });
  });
}

async function getVendorName(vendorId: number): Promise<string> {
  const [v] = await db
    .select({ name: vendorsTable.name })
    .from(vendorsTable)
    .where(eq(vendorsTable.id, vendorId))
    .limit(1);
  return v?.name ?? "Unknown Vendor";
}

/**
 * Task #63 — accrual leg. Dr <category.debitAccount> / Cr <settings.defaultApAccount>.
 */
export async function generateAccrualDraftFromBill(
  billId: number,
  actor: BillDraftActor,
): Promise<GenerateBillDraftResult> {
  const idempotencyKey = billDraftIdempotencyKey("accrual", billId);

  const existing = await fetchExistingByKey(idempotencyKey);
  if (existing) {
    return { ok: true, created: false, draftId: existing.id, draft: existing };
  }

  try {
    return await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(billsTable)
        .where(eq(billsTable.id, billId))
        .limit(1);
      if (!bill) {
        throw new BlockInTxError("other", `Bill ${billId} not found`);
      }
      if (bill.status !== "approved" && bill.status !== "paid") {
        throw new BlockInTxError(
          "other",
          `Bill #${billId} is not in 'approved' or 'paid' state (status=${bill.status})`,
        );
      }
      if (!bill.categoryId) {
        throw new BlockInTxError(
          "missing_category",
          "Bill has no category mapping",
        );
      }

      const [category] = await tx
        .select()
        .from(expenseCategoriesTable)
        .where(eq(expenseCategoriesTable.id, bill.categoryId))
        .limit(1);
      if (!category) {
        throw new BlockInTxError(
          "missing_category",
          "Linked category does not exist",
        );
      }

      const [settings] = await tx
        .select()
        .from(accountingSettingsTable)
        .limit(1);
      const apAccountId = settings?.defaultApAccountId ?? null;
      if (!apAccountId) {
        throw new BlockInTxError(
          "missing_ap_account",
          "No default Accounts Payable account configured in Accounting Settings",
        );
      }

      const accounts = await tx.select().from(chartOfAccountsTable);
      const debit = accounts.find((a) => a.id === category.debitAccountId);
      const credit = accounts.find((a) => a.id === apAccountId);
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

      const vendorName = await getVendorName(bill.vendorId);
      const amountStr = String(bill.amount);
      const memo = buildAccrualMemo({
        vendorName,
        description: bill.description,
        billId: bill.id,
      });
      const programIdStr =
        bill.programId != null ? String(bill.programId) : "";
      const entryDate = bill.invoiceDate ?? bill.dueDate;

      const payload = {
        entryDate,
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
          entryDate,
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
          sourceType: "bill",
          sourceId: billId,
          eventType: "accrual",
          idempotencyKey,
          manualJournalEntryDraftId: draft.id,
          journalEntryId: null,
          createdByUserId: actor.id,
        });
      } catch (e: unknown) {
        if (isLinkUniqueViolation(e)) {
          throw new RaceLostError();
        }
        throw e;
      }

      await tx
        .update(billsTable)
        .set({
          accountingStatus: "draft_created",
          accountingBlockReason: null,
          accountingGeneratedAt: new Date(),
        })
        .where(eq(billsTable.id, billId));

      await tx.insert(activityLogTable).values([
        {
          type: "bill_accounting_draft_created",
          description: `Accrual draft #${draft.id} generated from bill #${billId}`,
          actor: actor.display,
          actorUserId: actor.id,
          amount: amountStr,
          referenceId: billId,
          referenceType: "bill",
          metadata: {
            manualJournalEntryDraftId: draft.id,
            idempotencyKey,
            eventType: "accrual",
            debitAccountCode: debit.code,
            creditAccountCode: credit.code,
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
        billId,
        eventType: "accrual",
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
    logger.error({ err: e, billId }, "billDraftService accrual failure");
    await writeBlocked({
      billId,
      eventType: "accrual",
      reason: "other",
      actor,
      message: `Internal error generating accrual draft: ${msg}`,
    });
    return { ok: false, reason: "other", message: msg };
  }
}

/**
 * Task #63 — payment leg. Dr <settings.defaultApAccount> / Cr <settings.defaultCashAccount>.
 *
 * `options.cashAccountIdOverride` lets the caller (typically transactions.ts
 * when linking a bank txn whose bank account maps to a non-default cash CoA)
 * substitute the credit account instead of falling back to the global
 * default. The override must reference an active, manually postable account;
 * otherwise the bridge blocks with the same `archived_account` /
 * `non_postable_account` reasons used elsewhere.
 *
 * `options.transactionId` is recorded in the activity log so finance can
 * trace which bank transaction triggered the payment leg.
 */
export async function generatePaymentDraftFromBill(
  billId: number,
  actor: BillDraftActor,
  options?: { cashAccountIdOverride?: number; transactionId?: number },
): Promise<GenerateBillDraftResult> {
  const idempotencyKey = billDraftIdempotencyKey("payment", billId);

  const existing = await fetchExistingByKey(idempotencyKey);
  if (existing) {
    return { ok: true, created: false, draftId: existing.id, draft: existing };
  }

  try {
    return await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(billsTable)
        .where(eq(billsTable.id, billId))
        .limit(1);
      if (!bill) {
        throw new BlockInTxError("other", `Bill ${billId} not found`);
      }
      if (bill.status !== "paid") {
        throw new BlockInTxError(
          "other",
          `Bill #${billId} is not in 'paid' state (status=${bill.status})`,
        );
      }

      const [settings] = await tx
        .select()
        .from(accountingSettingsTable)
        .limit(1);
      const apAccountId = settings?.defaultApAccountId ?? null;
      // Prefer the per-transaction override when provided; otherwise fall
      // back to the configured default cash account.
      const cashAccountId =
        options?.cashAccountIdOverride ?? settings?.defaultCashAccountId ?? null;
      if (!apAccountId) {
        throw new BlockInTxError(
          "missing_ap_account",
          "No default Accounts Payable account configured in Accounting Settings",
        );
      }
      if (!cashAccountId) {
        throw new BlockInTxError(
          "missing_cash_account",
          "No default Cash account configured in Accounting Settings",
        );
      }

      const accounts = await tx.select().from(chartOfAccountsTable);
      const debit = accounts.find((a) => a.id === apAccountId);
      const credit = accounts.find((a) => a.id === cashAccountId);
      if (!debit || !credit) {
        throw new BlockInTxError(
          "missing_mapping",
          "Default AP/cash account record not found",
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

      const vendorName = await getVendorName(bill.vendorId);
      const amountStr = String(bill.amount);
      const memo = buildPaymentMemo({ vendorName, billId: bill.id });
      const programIdStr =
        bill.programId != null ? String(bill.programId) : "";
      const entryDate = bill.paidDate ?? bill.dueDate;

      const payload = {
        entryDate,
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
          entryDate,
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
          sourceType: "bill",
          sourceId: billId,
          eventType: "payment",
          idempotencyKey,
          manualJournalEntryDraftId: draft.id,
          journalEntryId: null,
          createdByUserId: actor.id,
        });
      } catch (e: unknown) {
        if (isLinkUniqueViolation(e)) {
          throw new RaceLostError();
        }
        throw e;
      }

      await tx
        .update(billsTable)
        .set({
          accountingPaymentStatus: "draft_created",
          accountingPaymentBlockReason: null,
          accountingPaymentGeneratedAt: new Date(),
        })
        .where(eq(billsTable.id, billId));

      await tx.insert(activityLogTable).values([
        {
          type: "bill_accounting_draft_created",
          description: `Payment draft #${draft.id} generated from bill #${billId}`,
          actor: actor.display,
          actorUserId: actor.id,
          amount: amountStr,
          referenceId: billId,
          referenceType: "bill",
          metadata: {
            manualJournalEntryDraftId: draft.id,
            idempotencyKey,
            eventType: "payment",
            debitAccountCode: debit.code,
            creditAccountCode: credit.code,
            ...(options?.transactionId !== undefined
              ? { transactionId: options.transactionId }
              : {}),
            ...(options?.cashAccountIdOverride !== undefined
              ? { cashAccountIdOverride: options.cashAccountIdOverride }
              : {}),
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
        billId,
        eventType: "payment",
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
    logger.error({ err: e, billId }, "billDraftService payment failure");
    await writeBlocked({
      billId,
      eventType: "payment",
      reason: "other",
      actor,
      message: `Internal error generating payment draft: ${msg}`,
    });
    return { ok: false, reason: "other", message: msg };
  }
}

export function generateBillDraft(
  eventType: BillEventType,
  billId: number,
  actor: BillDraftActor,
  options?: { cashAccountIdOverride?: number; transactionId?: number },
): Promise<GenerateBillDraftResult> {
  return eventType === "accrual"
    ? generateAccrualDraftFromBill(billId, actor)
    : generatePaymentDraftFromBill(billId, actor, options);
}
