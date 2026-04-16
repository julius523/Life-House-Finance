import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  transactionsTable,
  activityLogTable,
  expensesTable,
  billsTable,
  programsTable,
  vendorsTable,
} from "@workspace/db";
import { eq, and, desc, count, sql } from "drizzle-orm";
import {
  ListTransactionsQueryParams,
  ListTransactionsResponse,
  CreateTransactionBody,
  GetTransactionParams,
  GetTransactionResponse,
  UpdateTransactionParams,
  UpdateTransactionBody,
  UpdateTransactionResponse,
  GetReconciliationSummaryQueryParams,
  GetReconciliationSummaryResponse,
} from "@workspace/api-zod";
import { z } from "zod";

const router: IRouter = Router();

type TransactionRow = typeof transactionsTable.$inferSelect;

async function programNameFor(id: number | null): Promise<string | undefined> {
  if (id === null) return undefined;
  const [p] = await db
    .select({ name: programsTable.name })
    .from(programsTable)
    .where(eq(programsTable.id, id));
  return p?.name;
}

async function formatTransaction(t: TransactionRow) {
  return {
    id: t.id,
    externalId: t.externalId ?? undefined,
    bankAccountId: t.bankAccountId ?? undefined,
    bankAccountName: t.bankAccountName ?? undefined,
    transactionDate: t.transactionDate,
    description: t.description,
    amount: parseFloat(t.amount),
    type: t.type as "debit" | "credit",
    status: t.status as "unmatched" | "matched" | "reconciled",
    matchedExpenseId: t.matchedExpenseId ?? undefined,
    matchedBillId: t.matchedBillId ?? undefined,
    matchedProgramId: t.matchedProgramId ?? undefined,
    matchedProgramName: await programNameFor(t.matchedProgramId),
    notes: t.notes ?? undefined,
    importedAt: t.importedAt.toISOString(),
  };
}

router.get("/transactions", async (req, res): Promise<void> => {
  const parsed = ListTransactionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { status, accountId, page = 1 } = parsed.data;
  const pageSize = 50;

  const conditions = [];
  if (status) conditions.push(eq(transactionsTable.status, status));
  if (accountId) conditions.push(eq(transactionsTable.bankAccountId, accountId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [transactions, totalResult] = await Promise.all([
    db.select().from(transactionsTable).where(where).orderBy(desc(transactionsTable.transactionDate)).limit(pageSize).offset(offset),
    db.select({ cnt: count() }).from(transactionsTable).where(where),
  ]);

  const items = await Promise.all(transactions.map(formatTransaction));
  res.json(
    ListTransactionsResponse.parse({
      items,
      total: totalResult[0]?.cnt ?? 0,
      page,
    })
  );
});

router.post("/transactions", async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;
  const [transaction] = await db
    .insert(transactionsTable)
    .values({
      externalId: data.externalId,
      bankAccountId: data.bankAccountId,
      transactionDate: data.transactionDate,
      description: data.description,
      amount: String(data.amount),
      type: data.type,
      notes: data.notes,
      status: "unmatched",
    })
    .returning();

  if (!transaction) {
    res.status(500).json({ error: "Failed to create transaction" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "transaction_imported",
    description: `Transaction imported: ${transaction.description}`,
    actor: "System",
    amount: String(transaction.amount),
    referenceId: transaction.id,
    referenceType: "transaction",
  });

  res.status(201).json(GetTransactionResponse.parse(await formatTransaction(transaction)));
});

router.get("/transactions/reconciliation-summary", async (req, res): Promise<void> => {
  const parsed = GetReconciliationSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params, month is required (YYYY-MM)" });
    return;
  }
  const { month } = parsed.data;
  const [year, mon] = month.split("-");
  const startDate = `${year}-${mon}-01`;
  const endDate = new Date(parseInt(year!), parseInt(mon!), 0).toISOString().split("T")[0];

  const transactions = await db
    .select()
    .from(transactionsTable)
    .where(
      sql`${transactionsTable.transactionDate} >= ${startDate} and ${transactionsTable.transactionDate} <= ${endDate}`
    );

  const reconciled = transactions.filter((t) => t.status === "reconciled").length;
  const matched = transactions.filter((t) => t.status === "matched").length;
  const unmatched = transactions.filter((t) => t.status === "unmatched").length;
  const totalDebits = transactions.filter((t) => t.type === "debit").reduce((sum, t) => sum + parseFloat(t.amount), 0);
  const totalCredits = transactions.filter((t) => t.type === "credit").reduce((sum, t) => sum + parseFloat(t.amount), 0);

  res.json(
    GetReconciliationSummaryResponse.parse({
      month,
      totalTransactions: transactions.length,
      reconciled,
      matched,
      unmatched,
      totalDebits,
      totalCredits,
      netCashFlow: totalCredits - totalDebits,
    })
  );
});

// --- Conversion endpoints ---------------------------------------------------

const ConvertToExpenseBody = z.object({
  programId: z.number().int().optional(),
  paymentMethod: z
    .enum(["cash", "check", "credit_card", "debit_card", "bank_transfer", "other"])
    .optional(),
  submittedBy: z.string().optional(),
});

router.post("/transactions/:id/convert-to-expense", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ConvertToExpenseBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  if (tx.type !== "debit") {
    res.status(400).json({ error: "Only debit transactions can become expenses." });
    return;
  }
  if (tx.matchedExpenseId) {
    res.status(400).json({ error: "Transaction already linked to an expense." });
    return;
  }

  const submittedBy = body.data.submittedBy?.trim() || "Bank Import";
  const merchant = tx.description.split(" — ")[0]?.slice(0, 80) || tx.description.slice(0, 80);

  const [expense] = await db
    .insert(expensesTable)
    .values({
      submittedBy,
      expenseDate: tx.transactionDate,
      merchant,
      description: tx.description.slice(0, 500),
      amount: tx.amount,
      paymentMethod: body.data.paymentMethod ?? "credit_card",
      programId: body.data.programId,
      status: "draft",
    })
    .returning();

  if (!expense) {
    res.status(500).json({ error: "Failed to create expense" });
    return;
  }

  const [updated] = await db
    .update(transactionsTable)
    .set({ matchedExpenseId: expense.id, status: "matched" })
    .where(eq(transactionsTable.id, id))
    .returning();

  await db.insert(activityLogTable).values({
    type: "expense_created",
    description: `Expense draft created from bank transaction #${tx.id}`,
    actor: submittedBy,
    amount: tx.amount,
    referenceId: expense.id,
    referenceType: "expense",
  });

  res.json({
    expense: {
      id: expense.id,
      submittedBy: expense.submittedBy,
      submittedByEmail: expense.submittedByEmail ?? undefined,
      expenseDate: expense.expenseDate,
      merchant: expense.merchant,
      description: expense.description,
      amount: parseFloat(expense.amount),
      paymentMethod: expense.paymentMethod as
        | "cash"
        | "check"
        | "credit_card"
        | "debit_card"
        | "bank_transfer"
        | "other",
      programId: expense.programId ?? undefined,
      status: expense.status as
        | "draft"
        | "submitted"
        | "approved"
        | "rejected"
        | "reimbursed"
        | "needs_correction",
      receiptIds: expense.receiptIds ?? undefined,
      rejectionReason: expense.rejectionReason ?? undefined,
      createdAt: expense.createdAt.toISOString(),
      updatedAt: expense.updatedAt.toISOString(),
    },
    transaction: await formatTransaction(updated!),
  });
});

const ConvertToBillBody = z.object({
  vendorId: z.number().int(),
  programId: z.number().int().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post("/transactions/:id/convert-to-bill", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ConvertToBillBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "vendorId is required" });
    return;
  }
  const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  if (tx.type !== "debit") {
    res.status(400).json({ error: "Only debit transactions can become bills." });
    return;
  }
  if (tx.matchedBillId) {
    res.status(400).json({ error: "Transaction already linked to a bill." });
    return;
  }
  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, body.data.vendorId));
  if (!vendor) {
    res.status(400).json({ error: "Vendor not found" });
    return;
  }

  const [bill] = await db
    .insert(billsTable)
    .values({
      vendorId: body.data.vendorId,
      invoiceDate: tx.transactionDate,
      dueDate: body.data.dueDate ?? tx.transactionDate,
      amount: tx.amount,
      description: tx.description.slice(0, 500),
      programId: body.data.programId,
      status: "paid",
      paidDate: tx.transactionDate,
    })
    .returning();

  if (!bill) {
    res.status(500).json({ error: "Failed to create bill" });
    return;
  }

  const [updated] = await db
    .update(transactionsTable)
    .set({ matchedBillId: bill.id, status: "matched" })
    .where(eq(transactionsTable.id, id))
    .returning();

  await db.insert(activityLogTable).values({
    type: "bill_paid",
    description: `Bill recorded from bank transaction #${tx.id} (${vendor.name})`,
    actor: "Finance Staff",
    amount: tx.amount,
    referenceId: bill.id,
    referenceType: "bill",
  });

  res.json({
    bill: {
      id: bill.id,
      vendorId: bill.vendorId,
      invoiceNumber: bill.invoiceNumber ?? undefined,
      invoiceDate: bill.invoiceDate ?? undefined,
      dueDate: bill.dueDate,
      amount: parseFloat(bill.amount),
      description: bill.description ?? undefined,
      programId: bill.programId ?? undefined,
      status: bill.status as "draft" | "scheduled" | "paid" | "overdue" | "cancelled",
      approvedBy: bill.approvedBy ?? undefined,
      paidDate: bill.paidDate ?? undefined,
      receiptIds: bill.receiptIds ?? undefined,
      createdAt: bill.createdAt.toISOString(),
    },
    transaction: await formatTransaction(updated!),
  });
});

const LinkProgramBody = z.object({ programId: z.number().int() });

router.post("/transactions/:id/link-program", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = LinkProgramBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "programId is required" });
    return;
  }
  const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  const [program] = await db
    .select()
    .from(programsTable)
    .where(eq(programsTable.id, body.data.programId));
  if (!program) {
    res.status(400).json({ error: "Program not found" });
    return;
  }
  const [updated] = await db
    .update(transactionsTable)
    .set({ matchedProgramId: program.id, status: "matched" })
    .where(eq(transactionsTable.id, id))
    .returning();

  await db.insert(activityLogTable).values({
    type: "transaction_imported",
    description: `Transaction #${tx.id} linked to ${program.name}`,
    actor: "Finance Staff",
    amount: tx.amount,
    referenceId: tx.id,
    referenceType: "transaction",
  });

  res.json(await formatTransaction(updated!));
});

router.get("/transactions/:id", async (req, res): Promise<void> => {
  const parsed = GetTransactionParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [transaction] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, parsed.data.id));
  if (!transaction) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(GetTransactionResponse.parse(await formatTransaction(transaction)));
});

router.put("/transactions/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateTransactionParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateTransactionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = bodyParsed.data;
  const updates: Record<string, unknown> = {};
  if (data.status !== undefined) updates["status"] = data.status;
  if (data.matchedExpenseId !== undefined) updates["matchedExpenseId"] = data.matchedExpenseId;
  if (data.matchedBillId !== undefined) updates["matchedBillId"] = data.matchedBillId;
  if (data.notes !== undefined) updates["notes"] = data.notes;

  const [transaction] = await db
    .update(transactionsTable)
    .set(updates as Parameters<typeof db.update>[0] extends unknown ? never : unknown)
    .where(eq(transactionsTable.id, idParsed.data.id))
    .returning();

  if (!transaction) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (data.status === "reconciled") {
    await db.insert(activityLogTable).values({
      type: "reconciliation_completed",
      description: `Transaction reconciled: ${transaction.description}`,
      actor: "Finance Staff",
      amount: String(transaction.amount),
      referenceId: transaction.id,
      referenceType: "transaction",
    });
  }

  res.json(UpdateTransactionResponse.parse(await formatTransaction(transaction)));
});

export default router;
