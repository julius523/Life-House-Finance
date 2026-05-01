import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { expensesTable, billsTable, transactionsTable, vendorsTable, programsTable, activityLogTable } from "@workspace/db";
import { sql, eq, and, gte, lte, count } from "drizzle-orm";
import { requireRole } from "../lib/auth";
import {
  GetDashboardSummaryResponse,
  GetRecentActivityResponse,
  GetRecentActivityQueryParams,
  GetSpendingByProgramResponse,
  GetPendingApprovalsCountResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Task #107 — every endpoint in this router exposes org-wide finance
// data: cash balance, monthly burn rate, totals across all submitters,
// activity log entries that reveal who paid whom, and budget vs.
// actual spend per program. None of that should be visible to a
// submitter. The frontend already routes submitters to a separate
// `SubmitterDashboard` that does not call any of these endpoints, so
// gating the entire router to admin/approver matches the UX and
// closes the residual broken-access-control surface.
router.use(requireRole("admin", "approver"));

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const [pendingExpenses] = await db
    .select({ total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)` })
    .from(expensesTable)
    .where(eq(expensesTable.status, "submitted"));

  const [monthExpenses] = await db
    .select({ total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)` })
    .from(expensesTable)
    .where(
      and(
        gte(expensesTable.expenseDate, startOfMonth.toISOString().split("T")[0]),
        lte(expensesTable.expenseDate, endOfMonth.toISOString().split("T")[0])
      )
    );

  const [overdueBills] = await db
    .select({ total: sql<string>`coalesce(sum(${billsTable.amount}), 0)` })
    .from(billsTable)
    .where(eq(billsTable.status, "overdue"));

  const [dueBills] = await db
    .select({ total: sql<string>`coalesce(sum(${billsTable.amount}), 0)` })
    .from(billsTable)
    .where(
      and(
        eq(billsTable.status, "approved"),
        gte(billsTable.dueDate, startOfMonth.toISOString().split("T")[0]),
        lte(billsTable.dueDate, endOfMonth.toISOString().split("T")[0])
      )
    );

  const [unmatchedTx] = await db
    .select({ cnt: count() })
    .from(transactionsTable)
    .where(eq(transactionsTable.status, "unmatched"));

  const [pendingExpenseCount] = await db
    .select({ cnt: count() })
    .from(expensesTable)
    .where(eq(expensesTable.status, "submitted"));

  const [pendingBillCount] = await db
    .select({ cnt: count() })
    .from(billsTable)
    .where(eq(billsTable.status, "submitted"));

  const [vendorCount] = await db.select({ cnt: count() }).from(vendorsTable).where(eq(vendorsTable.isActive, true));
  const [programCount] = await db.select({ cnt: count() }).from(programsTable).where(eq(programsTable.isActive, true));

  const [creditSum] = await db
    .select({ total: sql<string>`coalesce(sum(${transactionsTable.amount}), 0)` })
    .from(transactionsTable)
    .where(eq(transactionsTable.type, "credit"));

  const [debitSum] = await db
    .select({ total: sql<string>`coalesce(sum(${transactionsTable.amount}), 0)` })
    .from(transactionsTable)
    .where(eq(transactionsTable.type, "debit"));

  const cashBalance = parseFloat(creditSum?.total ?? "0") - parseFloat(debitSum?.total ?? "0");
  const monthlyBurnRate = parseFloat(monthExpenses?.total ?? "0");

  const summary = {
    totalExpensesPending: parseFloat(pendingExpenses?.total ?? "0"),
    totalExpensesThisMonth: monthlyBurnRate,
    totalBillsOverdue: parseFloat(overdueBills?.total ?? "0"),
    totalBillsDueThisMonth: parseFloat(dueBills?.total ?? "0"),
    unmatchedTransactions: unmatchedTx?.cnt ?? 0,
    pendingApprovalsCount: (pendingExpenseCount?.cnt ?? 0) + (pendingBillCount?.cnt ?? 0),
    totalVendors: vendorCount?.cnt ?? 0,
    totalPrograms: programCount?.cnt ?? 0,
    cashBalance,
    monthlyBurnRate,
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

router.get("/dashboard/recent-activity", async (req, res): Promise<void> => {
  const parsed = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 10) : 10;

  const items = await db
    .select()
    .from(activityLogTable)
    .orderBy(sql`${activityLogTable.createdAt} desc`)
    .limit(limit);

  res.json(
    GetRecentActivityResponse.parse(
      items.map((item) => ({
        id: item.id,
        type: item.type,
        description: item.description,
        actor: item.actor,
        amount: item.amount ? parseFloat(item.amount) : undefined,
        createdAt: item.createdAt.toISOString(),
        referenceId: item.referenceId ?? undefined,
        referenceType: item.referenceType ?? undefined,
      }))
    )
  );
});

router.get("/dashboard/spending-by-program", async (_req, res): Promise<void> => {
  const programs = await db.select().from(programsTable).where(eq(programsTable.isActive, true));

  const results = await Promise.all(
    programs.map(async (prog) => {
      const [expenseSum] = await db
        .select({ total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)` })
        .from(expensesTable)
        .where(eq(expensesTable.programId, prog.id));

      const [billSum] = await db
        .select({ total: sql<string>`coalesce(sum(${billsTable.amount}), 0)` })
        .from(billsTable)
        .where(eq(billsTable.programId, prog.id));

      const totalAmount =
        parseFloat(expenseSum?.total ?? "0") + parseFloat(billSum?.total ?? "0");
      const budgetAmount = prog.budgetAmount ? parseFloat(prog.budgetAmount) : undefined;
      const percentUsed = budgetAmount && budgetAmount > 0 ? (totalAmount / budgetAmount) * 100 : undefined;

      return {
        programId: prog.id,
        programName: prog.name,
        programType: prog.type,
        totalAmount,
        budgetAmount,
        percentUsed,
      };
    })
  );

  res.json(GetSpendingByProgramResponse.parse(results));
});

router.get("/dashboard/pending-approvals-count", async (_req, res): Promise<void> => {
  const [expCnt] = await db
    .select({ cnt: count() })
    .from(expensesTable)
    .where(eq(expensesTable.status, "submitted"));

  const [billCnt] = await db
    .select({ cnt: count() })
    .from(billsTable)
    .where(eq(billsTable.status, "submitted"));

  const expenses = expCnt?.cnt ?? 0;
  const bills = billCnt?.cnt ?? 0;

  res.json(GetPendingApprovalsCountResponse.parse({ expenses, bills, total: expenses + bills }));
});

export default router;
