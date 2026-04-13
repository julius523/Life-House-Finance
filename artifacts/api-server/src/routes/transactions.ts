import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { transactionsTable, activityLogTable } from "@workspace/db";
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

const router: IRouter = Router();

function formatTransaction(t: typeof transactionsTable.$inferSelect) {
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
  const pageSize = 20;

  const conditions = [];
  if (status) conditions.push(eq(transactionsTable.status, status));
  if (accountId) conditions.push(eq(transactionsTable.bankAccountId, accountId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [transactions, totalResult] = await Promise.all([
    db.select().from(transactionsTable).where(where).orderBy(desc(transactionsTable.transactionDate)).limit(pageSize).offset(offset),
    db.select({ cnt: count() }).from(transactionsTable).where(where),
  ]);

  res.json(
    ListTransactionsResponse.parse({
      items: transactions.map(formatTransaction),
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

  res.status(201).json(GetTransactionResponse.parse(formatTransaction(transaction)));
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
  res.json(GetTransactionResponse.parse(formatTransaction(transaction)));
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

  res.json(UpdateTransactionResponse.parse(formatTransaction(transaction)));
});

export default router;
