import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import {
  canReadExpense,
  canMutateExpense,
  isOwnExpense,
} from "../lib/recordAuthz";
import { db } from "@workspace/db";
import {
  expensesTable,
  programsTable,
  activityLogTable,
  expenseCategoriesTable,
  accountingSourceLinksTable,
  manualJournalEntryDraftsTable,
  journalEntriesTable,
} from "@workspace/db";
import { eq, and, desc, count, sql, ne, inArray } from "drizzle-orm";
import { createNotification, findUserByEmail } from "../lib/notifications";
import { generateDraftFromExpense } from "../lib/expenseDraftService";
import {
  ListExpensesQueryParams,
  ListExpensesResponse,
  CreateExpenseBody,
  GetExpenseParams,
  GetExpenseResponse,
  UpdateExpenseParams,
  UpdateExpenseBody,
  UpdateExpenseResponse,
  DeleteExpenseParams,
  ApproveExpenseParams,
  ApproveExpenseBody,
  ApproveExpenseResponse,
  RejectExpenseParams,
  RejectExpenseBody,
  RejectExpenseResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Validate a categoryId provided by the client: must exist and be active.
// Used by both create and update paths. Create requires a non-null id;
// update may receive null only to clear (rare) — both paths funnel here.
async function validateCategoryId(
  categoryId: number,
): Promise<{ ok: true; categoryId: number } | { ok: false; error: string }> {
  const [cat] = await db
    .select({ id: expenseCategoriesTable.id, isActive: expenseCategoriesTable.isActive })
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.id, categoryId))
    .limit(1);
  if (!cat) return { ok: false, error: "Unknown expense category" };
  if (!cat.isActive) return { ok: false, error: "Expense category is archived" };
  return { ok: true, categoryId: cat.id };
}

async function getProgramName(programId: number | null | undefined): Promise<string | undefined> {
  if (!programId) return undefined;
  const [prog] = await db.select({ name: programsTable.name }).from(programsTable).where(eq(programsTable.id, programId));
  return prog?.name;
}

/**
 * Task #53 — compact accounting bridge summary surfaced on the expense
 * detail response so the UI can render an "Accounting" card linking
 * back to the generated draft and (once posted) the journal entry.
 * Built from accounting_source_links so future bill bridges reuse the
 * same shape on the read side.
 */
type AccountingLinkSummary = {
  draftId: number | null;
  draftStatus:
    | "draft"
    | "submitted"
    | "approved"
    | "rejected"
    | "posted"
    | null;
  // Task #53 review fix — surface enough draft context that the
  // expense-side Accounting card can show what's pending without an
  // extra fetch.
  draftEntryDate: string | null;
  draftMemo: string | null;
  journalEntryId: number | null;
  journalEntryNo: string | null;
  journalEntryDate: string | null;
  journalEntryStatus: "posted" | "reversed" | null;
};

async function loadAccountingLinkForExpense(
  expenseId: number,
): Promise<AccountingLinkSummary | null> {
  const links = await db
    .select({
      draftId: accountingSourceLinksTable.manualJournalEntryDraftId,
      journalEntryId: accountingSourceLinksTable.journalEntryId,
    })
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "expense"),
        eq(accountingSourceLinksTable.sourceId, expenseId),
      ),
    );
  if (links.length === 0) return null;
  // Prefer the link with a posted journal entry; fall back to the draft
  // link. In practice an expense has at most one of each.
  const draftId =
    links.find((l) => l.draftId !== null)?.draftId ?? null;
  const journalEntryId =
    links.find((l) => l.journalEntryId !== null)?.journalEntryId ?? null;

  let draftStatus: AccountingLinkSummary["draftStatus"] = null;
  let draftEntryDate: string | null = null;
  let draftMemo: string | null = null;
  if (draftId !== null) {
    const [d] = await db
      .select({
        status: manualJournalEntryDraftsTable.status,
        entryDate: manualJournalEntryDraftsTable.entryDate,
        memo: manualJournalEntryDraftsTable.memo,
      })
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, draftId))
      .limit(1);
    draftStatus =
      (d?.status as AccountingLinkSummary["draftStatus"]) ?? null;
    draftEntryDate = d?.entryDate ?? null;
    draftMemo = d?.memo ?? null;
  }

  // Task #53 review fix — JE fallback through the draft. Some
  // accounting_source_links rows only carry the draft linkage; if that
  // draft was later posted we still want to surface the resulting
  // journal entry on the expense detail card. Resolve the JE via
  // journal_entries.manual_draft_id when the bridge row didn't already
  // carry one.
  let resolvedJournalEntryId = journalEntryId;
  if (resolvedJournalEntryId === null && draftId !== null) {
    const [jeFromDraft] = await db
      .select({ id: journalEntriesTable.id })
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.manualDraftId, draftId))
      .limit(1);
    if (jeFromDraft?.id) {
      resolvedJournalEntryId = jeFromDraft.id;
    }
  }

  let journalEntryNo: string | null = null;
  let journalEntryDate: string | null = null;
  let journalEntryStatus: AccountingLinkSummary["journalEntryStatus"] = null;
  if (resolvedJournalEntryId !== null) {
    const [je] = await db
      .select({
        entryNo: journalEntriesTable.entryNo,
        entryDate: journalEntriesTable.entryDate,
        status: journalEntriesTable.status,
      })
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, journalEntryId))
      .limit(1);
    if (je) {
      journalEntryNo = je.entryNo;
      journalEntryDate = je.entryDate;
      journalEntryStatus =
        je.status as AccountingLinkSummary["journalEntryStatus"];
    }
  }

  return {
    draftId,
    draftStatus,
    draftEntryDate,
    draftMemo,
    journalEntryId,
    journalEntryNo,
    journalEntryDate,
    journalEntryStatus,
  };
}

function formatExpense(
  e: typeof expensesTable.$inferSelect,
  programName?: string,
  potentialDuplicateIds: number[] = [],
  categoryName?: string | null,
  accountingLink?: AccountingLinkSummary | null,
) {
  return {
    id: e.id,
    submittedBy: e.submittedBy,
    submittedByEmail: e.submittedByEmail ?? undefined,
    expenseDate: e.expenseDate,
    merchant: e.merchant,
    description: e.description,
    amount: parseFloat(e.amount),
    paymentMethod: e.paymentMethod as "cash" | "check" | "credit_card" | "debit_card" | "bank_transfer" | "other",
    programId: e.programId ?? undefined,
    programName,
    categoryId: e.categoryId ?? undefined,
    categoryName: categoryName ?? undefined,
    status: e.status as "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "needs_correction",
    managerApprovedBy: e.managerApprovedBy ?? undefined,
    financeApprovedBy: e.financeApprovedBy ?? undefined,
    rejectionReason: e.rejectionReason ?? undefined,
    reimbursedDate: e.reimbursedDate ?? undefined,
    receiptIds: e.receiptIds ?? undefined,
    accountingEntryRef: e.accountingEntryRef ?? undefined,
    duplicateDismissed: e.duplicateDismissed,
    potentialDuplicateIds: e.duplicateDismissed ? [] : potentialDuplicateIds,
    // Task #52 — accounting bridge state surfaced to clients so the
    // expense list can flag blocked rows and the detail view can show
    // mapping problems / link to the generated draft.
    accountingStatus: e.accountingStatus as
      | "pending"
      | "draft_created"
      | "posted"
      | "blocked"
      | "not_applicable",
    accountingBlockReason: e.accountingBlockReason ?? undefined,
    accountingGeneratedAt: e.accountingGeneratedAt?.toISOString(),
    // Task #53 — populated only by the detail endpoint. Null when no
    // accounting_source_links row exists yet (e.g. expense still in 'pending').
    accountingLink: accountingLink ?? undefined,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

// For each (date, amount) combination across the given expenses, return a map
// from expense id -> array of OTHER expense ids that share the same date and
// amount. Used to flag potential duplicates without per-row N+1 queries.
async function buildDuplicateMap(
  expenses: (typeof expensesTable.$inferSelect)[],
): Promise<Map<number, number[]>> {
  if (expenses.length === 0) return new Map();
  const keys = Array.from(
    new Set(expenses.map((e) => `${e.expenseDate}|${e.amount}`)),
  );
  // Pull every expense whose (date, amount) matches one of the input rows.
  const candidates = await db
    .select({
      id: expensesTable.id,
      expenseDate: expensesTable.expenseDate,
      amount: expensesTable.amount,
    })
    .from(expensesTable)
    .where(
      sql`(${expensesTable.expenseDate}::text || '|' || ${expensesTable.amount}::text) in (${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  const byKey = new Map<string, number[]>();
  for (const c of candidates) {
    const k = `${c.expenseDate}|${c.amount}`;
    const arr = byKey.get(k) ?? [];
    arr.push(c.id);
    byKey.set(k, arr);
  }
  const result = new Map<number, number[]>();
  for (const e of expenses) {
    const k = `${e.expenseDate}|${e.amount}`;
    const others = (byKey.get(k) ?? []).filter((id) => id !== e.id);
    result.set(e.id, others);
  }
  return result;
}

router.get("/expenses", async (req, res): Promise<void> => {
  const parsed = ListExpensesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { status, programId, submittedBy, page = 1, pageSize = 20 } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(expensesTable.status, status));
  if (programId) conditions.push(eq(expensesTable.programId, programId));
  if (submittedBy) conditions.push(eq(expensesTable.submittedBy, submittedBy));

  // Task #107 — submitters may only see their own expenses. Admins and
  // approvers see the full org dataset (needed for approval queues and
  // reporting). The scope clause is added on top of any client filters.
  const user = req.authUser!;
  if (user.role === "submitter") {
    // Task #119 — match exclusively on submittedByEmail (the durable,
    // unique identifier). Legacy rows with a NULL email are excluded
    // from submitter-scoped results; name-based matching was removed
    // because display names are not unique and allowed same-named users
    // to see each other's records.
    conditions.push(eq(expensesTable.submittedByEmail, user.email));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [expenses, totalResult] = await Promise.all([
    db.select().from(expensesTable).where(where).orderBy(desc(expensesTable.createdAt)).limit(pageSize).offset(offset),
    db.select({ cnt: count() }).from(expensesTable).where(where),
  ]);

  const dupMap = await buildDuplicateMap(expenses);
  const catIds = Array.from(
    new Set(expenses.map((e) => e.categoryId).filter((id): id is number => id !== null)),
  );
  const catRows = catIds.length
    ? await db
        .select({ id: expenseCategoriesTable.id, name: expenseCategoriesTable.name })
        .from(expenseCategoriesTable)
        .where(inArray(expenseCategoriesTable.id, catIds))
    : [];
  const catName = new Map(catRows.map((r) => [r.id, r.name]));
  const items = await Promise.all(
    expenses.map(async (e) => {
      const programName = await getProgramName(e.programId);
      const cName = e.categoryId === null ? null : catName.get(e.categoryId) ?? null;
      return formatExpense(e, programName, dupMap.get(e.id) ?? [], cName);
    })
  );

  res.json(ListExpensesResponse.parse({ items, total: totalResult[0]?.cnt ?? 0, page, pageSize }));
});

router.post("/expenses", async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;

  // Required: every new expense must select a category (Task #51 contract).
  if (data.categoryId === undefined || data.categoryId === null) {
    res.status(400).json({ error: "categoryId is required" });
    return;
  }
  const catResolved = await validateCategoryId(data.categoryId);
  if (!catResolved.ok) {
    res.status(400).json({ error: catResolved.error });
    return;
  }

  // Task #107 — server-derived submitter identity. Previously the route
  // trusted `submittedBy` / `submittedByEmail` from the request body,
  // which let an authenticated user file an expense as someone else.
  // Always overwrite both fields from req.authUser so the audit trail
  // and ownership checks point at the real caller.
  const callerUser = req.authUser!;
  const callerDisplay =
    `${callerUser.firstName} ${callerUser.lastName}`.trim() || callerUser.email;

  const [expense] = await db
    .insert(expensesTable)
    .values({
      submittedBy: callerDisplay,
      submittedByEmail: callerUser.email,
      expenseDate: data.expenseDate,
      merchant: data.merchant,
      description: data.description,
      amount: String(data.amount),
      paymentMethod: data.paymentMethod,
      programId: data.programId,
      categoryId: catResolved.categoryId,
      receiptIds: data.receiptIds,
      status: "submitted",
    })
    .returning();

  if (!expense) {
    res.status(500).json({ error: "Failed to create expense" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "expense_submitted",
    description: `Expense submitted by ${expense.submittedBy} at ${expense.merchant}`,
    actor: expense.submittedBy,
    amount: String(expense.amount),
    referenceId: expense.id,
    referenceType: "expense",
  });

  const programName = await getProgramName(expense.programId);
  res.status(201).json(GetExpenseResponse.parse(formatExpense(expense, programName)));
});

router.get("/expenses/:id", async (req, res): Promise<void> => {
  const parsed = GetExpenseParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [expense] = await db.select().from(expensesTable).where(eq(expensesTable.id, parsed.data.id));
  if (!expense) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Task #107 — submitters can only view their own expenses. Surface 404
  // (not 403) to avoid leaking that another user's expense exists at this id.
  if (!canReadExpense(req.authUser!, expense)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const programName = await getProgramName(expense.programId);
  const dups = await db
    .select({ id: expensesTable.id })
    .from(expensesTable)
    .where(
      and(
        eq(expensesTable.expenseDate, expense.expenseDate),
        eq(expensesTable.amount, expense.amount),
        ne(expensesTable.id, expense.id),
      ),
    );
  let cName: string | null = null;
  if (expense.categoryId !== null) {
    const [c] = await db
      .select({ name: expenseCategoriesTable.name })
      .from(expenseCategoriesTable)
      .where(eq(expenseCategoriesTable.id, expense.categoryId))
      .limit(1);
    cName = c?.name ?? null;
  }
  const accountingLink = await loadAccountingLinkForExpense(expense.id);
  res.json(
    GetExpenseResponse.parse(
      formatExpense(
        expense,
        programName,
        dups.map((d) => d.id),
        cName,
        accountingLink,
      ),
    ),
  );
});

router.put("/expenses/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateExpenseParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateExpenseBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = bodyParsed.data;

  // Task #107 — gate the edit on ownership AND mutable status. Submitters
  // can only update their own expenses while still in draft / submitted /
  // needs_correction. Admins always pass; approvers do their workflow
  // edits through the approve/reject/regenerate routes which are gated
  // separately. Submitters must not be able to set `status` either.
  const callerUser = req.authUser!;
  const [existing] = await db
    .select()
    .from(expensesTable)
    .where(eq(expensesTable.id, idParsed.data.id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (callerUser.role === "submitter" && !isOwnExpense(callerUser, existing)) {
    // Same 404 as GET to avoid revealing that the id exists.
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!canMutateExpense(callerUser, existing)) {
    res.status(403).json({
      error:
        "This expense is locked from edits at its current status. Contact an approver or admin.",
      code: "EXPENSE_NOT_EDITABLE",
    });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.merchant !== undefined) updates["merchant"] = data.merchant;
  if (data.description !== undefined) updates["description"] = data.description;
  if (data.amount !== undefined) updates["amount"] = String(data.amount);
  if (data.expenseDate !== undefined) updates["expenseDate"] = data.expenseDate;
  if (data.paymentMethod !== undefined) updates["paymentMethod"] = data.paymentMethod;
  if (data.programId !== undefined) updates["programId"] = data.programId;
  if (data.categoryId !== undefined) {
    if (data.categoryId === null) {
      // Allow explicit clear so submitters/admins can detach a legacy
      // expense from its category; the next read will surface an
      // "Uncategorized" badge in the UI.
      updates["categoryId"] = null;
    } else {
      const resolved = await validateCategoryId(data.categoryId);
      if (!resolved.ok) {
        res.status(400).json({ error: resolved.error });
        return;
      }
      updates["categoryId"] = resolved.categoryId;
    }
  }
  if (data.receiptIds !== undefined) updates["receiptIds"] = data.receiptIds;
  // Task #107 — only admins may directly set `status` here. Submitters
  // and approvers must use the workflow routes (approve/reject/resubmit).
  if (data.status !== undefined && callerUser.role === "admin") {
    updates["status"] = data.status;
  }

  const [expense] = await db
    .update(expensesTable)
    .set(updates as Parameters<typeof db.update>[0] extends unknown ? never : unknown)
    .where(eq(expensesTable.id, idParsed.data.id))
    .returning();

  if (!expense) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const programName = await getProgramName(expense.programId);
  res.json(UpdateExpenseResponse.parse(formatExpense(expense, programName)));
});

router.delete("/expenses/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = DeleteExpenseParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(expensesTable).where(eq(expensesTable.id, parsed.data.id));
  res.status(204).send();
});

router.post("/expenses/:id/approve", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const idParsed = ApproveExpenseParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = ApproveExpenseBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const [expense] = await db
    .update(expensesTable)
    .set({
      status: "approved",
      financeApprovedBy: bodyParsed.data.approvedBy,
      updatedAt: new Date(),
    })
    .where(eq(expensesTable.id, idParsed.data.id))
    .returning();

  if (!expense) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "expense_approved",
    description: `Expense approved by ${bodyParsed.data.approvedBy}`,
    actor: bodyParsed.data.approvedBy,
    actorUserId: req.authUser?.id ?? null,
    amount: String(expense.amount),
    referenceId: expense.id,
    referenceType: "expense",
  });

  // Task #52 — bridge into accounting. Approval succeeds even if draft
  // generation blocks; we surface the result on the response so the UI
  // can show success / blocked / mapping issues without a second call.
  // The route is gated by requireRole, so req.authUser is guaranteed.
  const accountingResult = await generateDraftFromExpense(expense.id, {
    id: req.authUser!.id,
    display: bodyParsed.data.approvedBy,
  });

  // Re-load the expense so the response reflects updated accountingStatus.
  const [refreshed] = await db
    .select()
    .from(expensesTable)
    .where(eq(expensesTable.id, expense.id));
  const finalExpense = refreshed ?? expense;

  const programName = await getProgramName(finalExpense.programId);
  const [cat] = finalExpense.categoryId
    ? await db
        .select({ name: expenseCategoriesTable.name })
        .from(expenseCategoriesTable)
        .where(eq(expenseCategoriesTable.id, finalExpense.categoryId))
    : [undefined];
  const base = formatExpense(finalExpense, programName, [], cat?.name ?? null);
  const accounting = accountingResult.ok
    ? {
        ok: true as const,
        created: accountingResult.created,
        manualJournalEntryDraftId: accountingResult.draftId,
      }
    : {
        ok: false as const,
        reason: accountingResult.reason,
        message: accountingResult.message,
      };
  res.json({
    ...ApproveExpenseResponse.parse(base),
    accounting,
  });
});

// Task #52 — manual retry. Same generator + same idempotency contract.
// Admin/approver only because it can produce ledger-bound work.
router.post(
  "/expenses/:id/regenerate-accounting-draft",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [exp] = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.id, id));
    if (!exp) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (exp.status !== "approved") {
      res.status(409).json({
        error: "Expense must be approved before generating an accounting draft",
        code: "EXPENSE_NOT_APPROVED",
      });
      return;
    }
    const u = req.authUser!;
    const actorDisplay =
      `${u.firstName} ${u.lastName}`.trim() || u.email;
    const result = await generateDraftFromExpense(id, {
      id: u.id,
      display: actorDisplay,
    });
    if (result.ok) {
      res.json({
        ok: true,
        created: result.created,
        manualJournalEntryDraftId: result.draftId,
      });
      return;
    }
    res.status(422).json({
      ok: false,
      reason: result.reason,
      message: result.message,
    });
  },
);

router.post("/expenses/:id/reject", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const idParsed = RejectExpenseParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = RejectExpenseBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const action = bodyParsed.data.action ?? "close";
  const newStatus = action === "send_back" ? "needs_correction" : "rejected";

  const [expense] = await db
    .update(expensesTable)
    .set({
      status: newStatus,
      rejectionReason: bodyParsed.data.reason,
      updatedAt: new Date(),
    })
    .where(eq(expensesTable.id, idParsed.data.id))
    .returning();

  if (!expense) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "expense_rejected",
    description:
      action === "send_back"
        ? `Expense sent back for correction: ${bodyParsed.data.reason}`
        : `Expense rejected: ${bodyParsed.data.reason}`,
    actor: bodyParsed.data.rejectedBy,
    referenceId: expense.id,
    referenceType: "expense",
  });

  if (action === "send_back" && expense.submittedByEmail) {
    const submitter = await findUserByEmail(expense.submittedByEmail);
    if (submitter) {
      await createNotification({
        userId: submitter.id,
        type: "expense_needs_correction",
        title: `Expense #${expense.id} needs your attention`,
        body: `Your expense at ${expense.merchant} ($${Number(expense.amount).toFixed(2)}) was sent back by ${bodyParsed.data.rejectedBy}. Reason: ${bodyParsed.data.reason}`,
        link: `/expenses/${expense.id}`,
        referenceType: "expense",
        referenceId: expense.id,
        variables: {
          itemId: expense.id,
          itemName: expense.merchant,
          amount: Number(expense.amount).toFixed(2),
          actor: bodyParsed.data.rejectedBy,
          reason: bodyParsed.data.reason,
        },
      });
    }
  }

  const programName = await getProgramName(expense.programId);
  res.json(RejectExpenseResponse.parse(formatExpense(expense, programName)));
});

// Task #54 — flip a blocked expense to accountingStatus='not_applicable'
// with a required note. Used from the blocked-expense queue when an
// expense legitimately should never reach accounting (e.g. submitted in
// error, refund already processed elsewhere). Writes an activity log so
// the audit trail explains why the bridge was abandoned.
router.post(
  "/expenses/:id/mark-accounting-not-applicable",
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const note =
      typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (note.length < 3 || note.length > 500) {
      res
        .status(400)
        .json({ error: "note is required (3–500 characters)" });
      return;
    }
    const [exp] = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.id, id));
    if (!exp) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Only allow flipping when the expense hasn't already produced a
    // posted ledger entry. blocked / pending / not_applicable are safe;
    // draft_created and posted are not — those need a draft action first.
    if (exp.accountingStatus !== "blocked" && exp.accountingStatus !== "pending") {
      res.status(409).json({
        error:
          "Only blocked or pending expenses can be marked not applicable.",
        code: "INVALID_ACCOUNTING_STATE",
        accountingStatus: exp.accountingStatus,
      });
      return;
    }
    // Atomic guard: only flip if the row is still in a safe state. A
    // concurrent retry could have just promoted the expense to
    // draft_created/posted between the read above and this write — without
    // the inArray() filter we'd silently overwrite that progress.
    const [updated] = await db
      .update(expensesTable)
      .set({
        accountingStatus: "not_applicable",
        accountingBlockReason: null,
        accountingGeneratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expensesTable.id, id),
          inArray(expensesTable.accountingStatus, ["blocked", "pending"]),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({
        error:
          "Expense state changed; refresh and try again.",
        code: "INVALID_ACCOUNTING_STATE",
      });
      return;
    }
    const u = req.authUser!;
    const actorDisplay =
      `${u.firstName} ${u.lastName}`.trim() || u.email;
    await db.insert(activityLogTable).values({
      type: "expense_accounting_not_applicable",
      description: `Marked not applicable for accounting: ${note}`,
      actor: actorDisplay,
      actorUserId: u.id,
      referenceId: updated.id,
      referenceType: "expense",
    });
    const programName = await getProgramName(updated.programId);
    let cName: string | null = null;
    if (updated.categoryId !== null) {
      const [c] = await db
        .select({ name: expenseCategoriesTable.name })
        .from(expenseCategoriesTable)
        .where(eq(expenseCategoriesTable.id, updated.categoryId))
        .limit(1);
      cName = c?.name ?? null;
    }
    res.json(
      GetExpenseResponse.parse(
        formatExpense(updated, programName, [], cName),
      ),
    );
  },
);

router.post(
  "/expenses/:id/dismiss-duplicate",
  // Task #107 — only admins/approvers can suppress duplicate warnings.
  // Submitters previously could dismiss the warning on anyone's expense.
  requireRole("admin", "approver"),
  async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [expense] = await db
    .update(expensesTable)
    .set({ duplicateDismissed: true, updatedAt: new Date() })
    .where(eq(expensesTable.id, id))
    .returning();
  if (!expense) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const programName = await getProgramName(expense.programId);
  res.json(GetExpenseResponse.parse(formatExpense(expense, programName, [])));
  },
);

export default router;
