import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  expensesTable,
  billsTable,
  programsTable,
  vendorsTable,
  transactionsTable,
} from "@workspace/db";
import { sql, and, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { GetFinancialSummaryReportResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Query params arrive as strings; coerce them to Date locally rather than
// relying on the generated z.date() schema (which would reject ISO strings).
// Accept ISO date strings (YYYY-MM-DD or full ISO timestamp) and normalize to
// the YYYY-MM-DD form used by drizzle's `date` columns.
const isoDateString = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid date" })
  .transform((v) => new Date(v).toISOString().slice(0, 10));

const QuerySchema = z.object({
  fromDate: isoDateString.optional(),
  toDate: isoDateString.optional(),
});

router.get("/reports/financial-summary", async (req, res): Promise<void> => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid date range", details: parsed.error.format() });
    return;
  }
  const { fromDate, toDate } = parsed.data;

  const expenseConds = [];
  if (fromDate) expenseConds.push(gte(expensesTable.expenseDate, fromDate));
  if (toDate) expenseConds.push(lte(expensesTable.expenseDate, toDate));
  const expenseWhere = expenseConds.length > 0 ? and(...expenseConds) : undefined;

  const billConds = [];
  if (fromDate) billConds.push(gte(billsTable.dueDate, fromDate));
  if (toDate) billConds.push(lte(billsTable.dueDate, toDate));
  const billWhere = billConds.length > 0 ? and(...billConds) : undefined;

  const expenseTotals = await db
    .select({
      status: expensesTable.status,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
    })
    .from(expensesTable)
    .where(expenseWhere)
    .groupBy(expensesTable.status);

  const billTotals = await db
    .select({
      status: billsTable.status,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${billsTable.amount}), 0)::text`,
    })
    .from(billsTable)
    .where(billWhere)
    .groupBy(billsTable.status);

  // Spend by program: combine expenses + bills.
  const programs = await db.select().from(programsTable);

  const expByProgram = await db
    .select({
      programId: expensesTable.programId,
      amount: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
    })
    .from(expensesTable)
    .where(expenseWhere)
    .groupBy(expensesTable.programId);

  const billByProgram = await db
    .select({
      programId: billsTable.programId,
      amount: sql<string>`coalesce(sum(${billsTable.amount}), 0)::text`,
    })
    .from(billsTable)
    .where(billWhere)
    .groupBy(billsTable.programId);

  const spendByProgram = programs
    .map((p) => {
      const e = expByProgram.find((x) => x.programId === p.id);
      const b = billByProgram.find((x) => x.programId === p.id);
      const expenseAmount = e ? parseFloat(e.amount) : 0;
      const billAmount = b ? parseFloat(b.amount) : 0;
      const total = expenseAmount + billAmount;
      const budget = p.budgetAmount ? parseFloat(p.budgetAmount) : undefined;
      return {
        programId: p.id,
        programName: p.name,
        budgetAmount: budget,
        expenseAmount,
        billAmount,
        totalAmount: total,
        percentUsed: budget && budget > 0 ? (total / budget) * 100 : undefined,
      };
    })
    .sort((a, b) => b.totalAmount - a.totalAmount);

  // Top vendors by total spend (bills + linked expenses by merchant fuzzy match
  // is overkill; use bills.vendorId for accuracy, plus expense merchants name match).
  const vendorBillTotals = await db
    .select({
      vendorId: billsTable.vendorId,
      amount: sql<string>`coalesce(sum(${billsTable.amount}), 0)::text`,
    })
    .from(billsTable)
    .where(billWhere)
    .groupBy(billsTable.vendorId);

  const vendors = await db.select().from(vendorsTable);

  const expensesByMerchant = await db
    .select({
      merchant: expensesTable.merchant,
      amount: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
    })
    .from(expensesTable)
    .where(expenseWhere)
    .groupBy(expensesTable.merchant);

  const merchantMap = new Map(
    expensesByMerchant.map((e) => [e.merchant.toLowerCase(), parseFloat(e.amount)])
  );

  const vendorTotals = vendors
    .map((v) => {
      const billRow = vendorBillTotals.find((x) => x.vendorId === v.id);
      const billAmount = billRow ? parseFloat(billRow.amount) : 0;
      const expenseAmount = merchantMap.get(v.name.toLowerCase()) ?? 0;
      return {
        vendorId: v.id,
        vendorName: v.name,
        billAmount,
        expenseAmount,
        totalAmount: billAmount + expenseAmount,
      };
    })
    .filter((v) => v.totalAmount > 0)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10);

  // Missing receipts: itemized list, scoped to the same date range as the
  // rest of the report so totals stay consistent with the active filter.
  const missingConds = [
    sql`(${expensesTable.receiptIds} is null or array_length(${expensesTable.receiptIds}, 1) is null)`,
    sql`${expensesTable.status} in ('submitted', 'approved', 'needs_correction')`,
  ];
  if (fromDate) missingConds.push(gte(expensesTable.expenseDate, fromDate));
  if (toDate) missingConds.push(lte(expensesTable.expenseDate, toDate));

  const missingItems = await db
    .select({
      expenseId: expensesTable.id,
      submittedBy: expensesTable.submittedBy,
      merchant: expensesTable.merchant,
      amount: expensesTable.amount,
      expenseDate: expensesTable.expenseDate,
      createdAt: expensesTable.createdAt,
    })
    .from(expensesTable)
    .where(and(...missingConds));

  const now = Date.now();
  const missingReceipts = missingItems.map((row) => ({
    expenseId: row.expenseId,
    submittedBy: row.submittedBy,
    merchant: row.merchant,
    amount: parseFloat(row.amount as unknown as string),
    expenseDate: row.expenseDate,
    daysSinceSubmission: row.createdAt
      ? Math.max(0, Math.floor((now - new Date(row.createdAt).getTime()) / 86_400_000))
      : 0,
  }));
  const missingRow = {
    count: missingReceipts.length,
    amount: missingReceipts.reduce((s, r) => s + r.amount, 0),
  };

  // Bank reconciliation totals (no date filter — match the existing summary endpoint).
  const txConds = [];
  if (fromDate) txConds.push(gte(transactionsTable.transactionDate, fromDate));
  if (toDate) txConds.push(lte(transactionsTable.transactionDate, toDate));
  const txWhere = txConds.length > 0 ? and(...txConds) : undefined;

  const txAgg = await db
    .select({
      total: sql<number>`count(*)::int`,
      unmatched: sql<number>`count(*) filter (where ${transactionsTable.status} = 'unmatched')::int`,
      matched: sql<number>`count(*) filter (where ${transactionsTable.status} = 'matched')::int`,
      reconciled: sql<number>`count(*) filter (where ${transactionsTable.status} = 'reconciled')::int`,
      debits: sql<string>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.type} = 'debit'), 0)::text`,
      credits: sql<string>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.type} = 'credit'), 0)::text`,
    })
    .from(transactionsTable)
    .where(txWhere);

  const tx = txAgg[0] ?? {
    total: 0,
    unmatched: 0,
    matched: 0,
    reconciled: 0,
    debits: "0",
    credits: "0",
  };

  const totalDebits = parseFloat(tx.debits);
  const totalCredits = parseFloat(tx.credits);

  res.json(
    GetFinancialSummaryReportResponse.parse({
      generatedAt: new Date().toISOString(),
      fromDate,
      toDate,
      expenseTotalsByStatus: expenseTotals.map((r) => ({
        status: r.status,
        count: r.count,
        amount: parseFloat(r.amount),
      })),
      billTotalsByStatus: billTotals.map((r) => ({
        status: r.status,
        count: r.count,
        amount: parseFloat(r.amount),
      })),
      spendByProgram,
      topVendors: vendorTotals,
      missingReceiptCount: missingRow.count,
      missingReceiptAmount: missingRow.amount,
      missingReceipts,
      bankReconciliation: {
        totalTransactions: tx.total,
        unmatched: tx.unmatched,
        matched: tx.matched,
        reconciled: tx.reconciled,
        totalDebits,
        totalCredits,
        netCashFlow: totalCredits - totalDebits,
      },
    })
  );
});

export default router;
