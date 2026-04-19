import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import { db } from "@workspace/db";
import {
  expensesTable,
  programsTable,
  activityLogTable,
  expenseCategoriesTable,
} from "@workspace/db";
import { eq, and, desc, count, sql, ne } from "drizzle-orm";
import { createNotification, findUserByEmail } from "../lib/notifications";
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

// Resolve the categoryId we should persist on a write:
//  - If client provided one, validate it exists & is active.
//  - Otherwise, fall back to the seeded "Uncategorized" system row so every
//    expense always has a deterministic mapping (Task #51 invariant; Task #52
//    auto-draft generation depends on this).
// Returns either the resolved id or an error string for the caller to surface.
async function resolveCategoryIdForWrite(
  categoryId: number | null | undefined,
): Promise<{ ok: true; categoryId: number | null } | { ok: false; error: string }> {
  if (categoryId !== undefined && categoryId !== null) {
    const [cat] = await db
      .select({ id: expenseCategoriesTable.id, isActive: expenseCategoriesTable.isActive })
      .from(expenseCategoriesTable)
      .where(eq(expenseCategoriesTable.id, categoryId))
      .limit(1);
    if (!cat) return { ok: false, error: "Unknown expense category" };
    if (!cat.isActive) return { ok: false, error: "Expense category is archived" };
    return { ok: true, categoryId: cat.id };
  }
  // Default to system "Uncategorized" — seed guarantees its presence.
  const [uncat] = await db
    .select({ id: expenseCategoriesTable.id })
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.name, "Uncategorized"))
    .limit(1);
  return { ok: true, categoryId: uncat?.id ?? null };
}

async function getProgramName(programId: number | null | undefined): Promise<string | undefined> {
  if (!programId) return undefined;
  const [prog] = await db.select({ name: programsTable.name }).from(programsTable).where(eq(programsTable.id, programId));
  return prog?.name;
}

function formatExpense(
  e: typeof expensesTable.$inferSelect,
  programName?: string,
  potentialDuplicateIds: number[] = [],
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
    status: e.status as "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "needs_correction",
    managerApprovedBy: e.managerApprovedBy ?? undefined,
    financeApprovedBy: e.financeApprovedBy ?? undefined,
    rejectionReason: e.rejectionReason ?? undefined,
    reimbursedDate: e.reimbursedDate ?? undefined,
    receiptIds: e.receiptIds ?? undefined,
    accountingEntryRef: e.accountingEntryRef ?? undefined,
    duplicateDismissed: e.duplicateDismissed,
    potentialDuplicateIds: e.duplicateDismissed ? [] : potentialDuplicateIds,
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

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [expenses, totalResult] = await Promise.all([
    db.select().from(expensesTable).where(where).orderBy(desc(expensesTable.createdAt)).limit(pageSize).offset(offset),
    db.select({ cnt: count() }).from(expensesTable).where(where),
  ]);

  const dupMap = await buildDuplicateMap(expenses);
  const items = await Promise.all(
    expenses.map(async (e) => {
      const programName = await getProgramName(e.programId);
      return formatExpense(e, programName, dupMap.get(e.id) ?? []);
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

  const catResolved = await resolveCategoryIdForWrite(data.categoryId);
  if (!catResolved.ok) {
    res.status(400).json({ error: catResolved.error });
    return;
  }

  const [expense] = await db
    .insert(expensesTable)
    .values({
      submittedBy: data.submittedBy,
      submittedByEmail: data.submittedByEmail,
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
  res.json(
    GetExpenseResponse.parse(
      formatExpense(
        expense,
        programName,
        dups.map((d) => d.id),
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
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.merchant !== undefined) updates["merchant"] = data.merchant;
  if (data.description !== undefined) updates["description"] = data.description;
  if (data.amount !== undefined) updates["amount"] = String(data.amount);
  if (data.expenseDate !== undefined) updates["expenseDate"] = data.expenseDate;
  if (data.paymentMethod !== undefined) updates["paymentMethod"] = data.paymentMethod;
  if (data.programId !== undefined) updates["programId"] = data.programId;
  if (data.categoryId !== undefined) {
    const resolved = await resolveCategoryIdForWrite(data.categoryId);
    if (!resolved.ok) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    updates["categoryId"] = resolved.categoryId;
  }
  if (data.receiptIds !== undefined) updates["receiptIds"] = data.receiptIds;
  if (data.status !== undefined) updates["status"] = data.status;

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
    amount: String(expense.amount),
    referenceId: expense.id,
    referenceType: "expense",
  });

  const programName = await getProgramName(expense.programId);
  res.json(ApproveExpenseResponse.parse(formatExpense(expense, programName)));
});

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

router.post("/expenses/:id/dismiss-duplicate", async (req, res): Promise<void> => {
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
});

export default router;
