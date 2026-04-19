import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  expensesTable,
  billsTable,
  programsTable,
  vendorsTable,
  transactionsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  chartOfAccountsTable,
  activityLogTable,
} from "@workspace/db";
import { sql, and, gte, lte, eq, asc } from "drizzle-orm";
import { z } from "zod";
import { GetFinancialSummaryReportResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared ledger-summary helper (Task #63 — reconciliation hardening).
//
// Encapsulates the ledger-source P&L + Balance Sheet computation so both
// /reports/financial-summary and /reports/reconciliation tie to the SAME
// posted-JE source of truth instead of being parallel re-implementations.
// ---------------------------------------------------------------------------
type BSAccountRow = { accountId: number; code: string; name: string; balance: number };
type PLAccountRow = { accountId: number; code: string; name: string; amount: number };

interface LedgerSummary {
  // P&L
  totalIncome: number;
  totalExpenses: number;
  incomeByAccount: PLAccountRow[];
  expensesByAccount: PLAccountRow[];
  // Balance Sheet (as-of toDate; fromDate ignored for BS by design)
  cash: number;
  accountsReceivable: number;
  otherAssets: number;
  accountsPayable: number;
  otherLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  equity: number;
  cashAccounts: BSAccountRow[];
  accountsReceivableAccounts: BSAccountRow[];
  otherAssetAccounts: BSAccountRow[];
  accountsPayableAccounts: BSAccountRow[];
  otherLiabilityAccounts: BSAccountRow[];
}

async function computeLedgerSummary(
  fromDate: string | undefined,
  toDate: string | undefined,
): Promise<LedgerSummary> {
  // ---- P&L per-account aggregation over [fromDate, toDate] ----------------
  const plConds = [sql`${journalEntriesTable.status} in ('posted', 'reversed')`];
  if (fromDate) plConds.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate) plConds.push(lte(journalEntriesTable.entryDate, toDate));

  const plAccountRows = await db
    .select({
      accountId: chartOfAccountsTable.id,
      code: chartOfAccountsTable.code,
      name: chartOfAccountsTable.name,
      type: chartOfAccountsTable.type,
      debits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      credits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .innerJoin(
      chartOfAccountsTable,
      eq(journalEntryLinesTable.accountId, chartOfAccountsTable.id),
    )
    .where(and(...plConds))
    .groupBy(
      chartOfAccountsTable.id,
      chartOfAccountsTable.code,
      chartOfAccountsTable.name,
      chartOfAccountsTable.type,
    );

  let totalIncome = 0;
  let totalExpenses = 0;
  const incomeByAccount: PLAccountRow[] = [];
  const expensesByAccount: PLAccountRow[] = [];
  for (const a of plAccountRows) {
    const d = Number(a.debits) / 100;
    const c = Number(a.credits) / 100;
    if (a.type === "revenue") {
      const amount = c - d;
      totalIncome += amount;
      if (amount !== 0) {
        incomeByAccount.push({ accountId: a.accountId, code: a.code, name: a.name, amount });
      }
    } else if (a.type === "expense") {
      const amount = d - c;
      totalExpenses += amount;
      if (amount !== 0) {
        expensesByAccount.push({ accountId: a.accountId, code: a.code, name: a.name, amount });
      }
    }
  }
  incomeByAccount.sort((x, y) => x.code.localeCompare(y.code));
  expensesByAccount.sort((x, y) => x.code.localeCompare(y.code));

  // ---- Balance sheet per-account aggregation as-of toDate -----------------
  const bsConds = [sql`${journalEntriesTable.status} in ('posted', 'reversed')`];
  if (toDate) bsConds.push(lte(journalEntriesTable.entryDate, toDate));

  const bsAccountRows = await db
    .select({
      accountId: chartOfAccountsTable.id,
      code: chartOfAccountsTable.code,
      name: chartOfAccountsTable.name,
      type: chartOfAccountsTable.type,
      subtype: chartOfAccountsTable.subtype,
      debits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      credits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .innerJoin(
      chartOfAccountsTable,
      eq(journalEntryLinesTable.accountId, chartOfAccountsTable.id),
    )
    .where(and(...bsConds))
    .groupBy(
      chartOfAccountsTable.id,
      chartOfAccountsTable.code,
      chartOfAccountsTable.name,
      chartOfAccountsTable.type,
      chartOfAccountsTable.subtype,
    );

  let cash = 0;
  let accountsReceivable = 0;
  let otherAssets = 0;
  let accountsPayable = 0;
  let otherLiabilities = 0;
  let totalAssets = 0;
  let totalLiabilities = 0;
  let equity = 0;
  const cashAccounts: BSAccountRow[] = [];
  const accountsReceivableAccounts: BSAccountRow[] = [];
  const otherAssetAccounts: BSAccountRow[] = [];
  const accountsPayableAccounts: BSAccountRow[] = [];
  const otherLiabilityAccounts: BSAccountRow[] = [];

  for (const a of bsAccountRows) {
    const d = Number(a.debits) / 100;
    const c = Number(a.credits) / 100;
    const row: BSAccountRow = {
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      balance: 0,
    };
    if (a.type === "asset") {
      const net = d - c;
      row.balance = net;
      totalAssets += net;
      if (a.subtype === "cash") {
        cash += net;
        cashAccounts.push(row);
      } else if (a.subtype === "ar") {
        accountsReceivable += net;
        accountsReceivableAccounts.push(row);
      } else {
        otherAssets += net;
        otherAssetAccounts.push(row);
      }
    } else if (a.type === "contra_asset") {
      const net = d - c;
      row.balance = net;
      totalAssets += net;
      otherAssets += net;
      otherAssetAccounts.push(row);
    } else if (a.type === "liability") {
      const net = c - d;
      row.balance = net;
      totalLiabilities += net;
      if (a.subtype === "ap") {
        accountsPayable += net;
        accountsPayableAccounts.push(row);
      } else {
        otherLiabilities += net;
        otherLiabilityAccounts.push(row);
      }
    } else if (a.type === "contra_liability") {
      const net = c - d;
      row.balance = net;
      totalLiabilities += net;
      otherLiabilities += net;
      otherLiabilityAccounts.push(row);
    } else if (a.type === "equity") {
      equity += c - d;
    }
  }

  // Plug current-period net income into equity so totals tie out
  // (assets = liabilities + equity).
  equity += totalIncome - totalExpenses;
  if (totalAssets === 0 && totalLiabilities === 0) {
    equity = 0;
  }

  const sortRows = (rows: BSAccountRow[]) =>
    rows.sort((x, y) => x.code.localeCompare(y.code));
  sortRows(cashAccounts);
  sortRows(accountsReceivableAccounts);
  sortRows(otherAssetAccounts);
  sortRows(accountsPayableAccounts);
  sortRows(otherLiabilityAccounts);

  return {
    totalIncome,
    totalExpenses,
    incomeByAccount,
    expensesByAccount,
    cash,
    accountsReceivable,
    otherAssets,
    accountsPayable,
    otherLiabilities,
    totalAssets,
    totalLiabilities,
    equity,
    cashAccounts,
    accountsReceivableAccounts,
    otherAssetAccounts,
    accountsPayableAccounts,
    otherLiabilityAccounts,
  };
}

// Query params arrive as strings; coerce them to Date locally rather than
// relying on the generated z.date() schema (which would reject ISO strings).
// Accept ISO date strings (YYYY-MM-DD or full ISO timestamp) and normalize to
// the YYYY-MM-DD form used by drizzle's `date` columns.
const isoDateString = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid date" })
  .transform((v) => new Date(v).toISOString().slice(0, 10));

const QuerySchema = z
  .object({
    fromDate: isoDateString.optional(),
    toDate: isoDateString.optional(),
    // Step 9 — Trial Balance contract uses `from`/`to` aliases.
    from: isoDateString.optional(),
    to: isoDateString.optional(),
    /**
     * Step 9 — `source=ledger` recomputes the P&L and Balance Sheet sections
     * from posted journal entries (Chart of Accounts × journal_entry_lines)
     * instead of from operational tables. Default is `operational`.
     */
    source: z.enum(["operational", "ledger"]).optional(),
  })
  .transform((d) => ({
    ...d,
    fromDate: d.fromDate ?? d.from,
    toDate: d.toDate ?? d.to,
  }));

router.get("/reports/financial-summary", async (req, res): Promise<void> => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid date range", details: parsed.error.format() });
    return;
  }
  const { fromDate, toDate } = parsed.data;
  const source: "operational" | "ledger" = parsed.data.source ?? "operational";

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

  // ---- Profit & Loss --------------------------------------------------
  // Two sources are supported (Step 9):
  //   * operational (default): cash-basis from expenses/bills/transactions
  //   * ledger: aggregates posted journal_entry_lines by CoA type
  //
  // Variables produced by both branches:
  //   incomeByProgram, uncategorizedIncome, totalIncome,
  //   expensesByProgram, uncategorizedExpenses, totalExpenses
  let incomeByProgram: { programId: number; programName: string; amount: number }[] = [];
  let uncategorizedIncome = 0;
  let totalIncome = 0;
  let expensesByProgram: { programId: number; programName: string; amount: number }[] = [];
  let uncategorizedExpenses = 0;
  let totalExpenses = 0;
  // Task #61 — per-account breakdown for ledger-source P&L so the UI can
  // expand each row and drill down into the posted JE lines that built it
  // (via the existing /reports/account-activity endpoint). Empty in
  // operational mode because operational P&L is sourced from
  // expenses/bills/transactions, which have no posted JE backing.
  type PLAccount = { accountId: number; code: string; name: string; amount: number };
  let incomeByAccount: PLAccount[] = [];
  let expensesByAccount: PLAccount[] = [];

  // ---- Balance sheet variables (filled by either branch below) -------
  let cashOnHand = 0;
  let outstandingReceivables = 0;
  let unpaidBills = 0;
  let unreimbursedExpenses = 0;
  // Task 26 — explicit subtype breakdown for the ledger-source BS so the
  // card matches what users expect from a real GAAP Balance Sheet (instead
  // of dumping every asset into a single cashOnHand bucket).
  let cash = 0;
  let accountsReceivable = 0;
  let otherAssets = 0;
  let accountsPayable = 0;
  let otherLiabilities = 0;
  let totalAssets = 0;
  let totalLiabilities = 0;
  let equity = 0;

  // Task 30 — per-CoA-account rows that make up each Balance Sheet bucket so
  // the UI can expand a row inline and show the underlying accounts.
  type BSAccount = { accountId: number; code: string; name: string; balance: number };
  let cashAccounts: BSAccount[] = [];
  let accountsReceivableAccounts: BSAccount[] = [];
  let otherAssetAccounts: BSAccount[] = [];
  let accountsPayableAccounts: BSAccount[] = [];
  let otherLiabilityAccounts: BSAccount[] = [];

  if (source === "ledger") {
    // ----- Ledger-based P&L + Balance Sheet --------------------------------
    // Delegate to the shared helper so this endpoint and /reports/reconciliation
    // tie out to the SAME computation. See computeLedgerSummary() above.
    const ls = await computeLedgerSummary(fromDate, toDate);
    totalIncome = ls.totalIncome;
    uncategorizedIncome = ls.totalIncome;
    totalExpenses = ls.totalExpenses;
    uncategorizedExpenses = ls.totalExpenses;
    incomeByAccount = ls.incomeByAccount;
    expensesByAccount = ls.expensesByAccount;
    cash = ls.cash;
    accountsReceivable = ls.accountsReceivable;
    otherAssets = ls.otherAssets;
    accountsPayable = ls.accountsPayable;
    otherLiabilities = ls.otherLiabilities;
    totalAssets = ls.totalAssets;
    totalLiabilities = ls.totalLiabilities;
    equity = ls.equity;
    cashAccounts = ls.cashAccounts;
    accountsReceivableAccounts = ls.accountsReceivableAccounts;
    otherAssetAccounts = ls.otherAssetAccounts;
    accountsPayableAccounts = ls.accountsPayableAccounts;
    otherLiabilityAccounts = ls.otherLiabilityAccounts;
    cashOnHand = cash;
    outstandingReceivables = accountsReceivable;
    unpaidBills = accountsPayable;
    unreimbursedExpenses = otherLiabilities;
  } else {
    // ----- Operational P&L (legacy behavior) ------------------------------
  // Income = bank credits, attributed to a program when linked.
  const incomeRows = await db
    .select({
      programId: transactionsTable.matchedProgramId,
      amount: sql<string>`coalesce(sum(${transactionsTable.amount}), 0)::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        sql`${transactionsTable.type} = 'credit'`,
        ...(fromDate ? [gte(transactionsTable.transactionDate, fromDate)] : []),
        ...(toDate ? [lte(transactionsTable.transactionDate, toDate)] : []),
      ),
    )
    .groupBy(transactionsTable.matchedProgramId);

  incomeByProgram = incomeRows
    .filter((r) => r.programId !== null)
    .map((r) => {
      const program = programs.find((p) => p.id === r.programId);
      return {
        programId: r.programId!,
        programName: program?.name ?? `Program #${r.programId}`,
        amount: parseFloat(r.amount),
      };
    })
    .sort((a, b) => b.amount - a.amount);
  uncategorizedIncome = incomeRows
    .filter((r) => r.programId === null)
    .reduce((s, r) => s + parseFloat(r.amount), 0);
  totalIncome =
    incomeByProgram.reduce((s, r) => s + r.amount, 0) + uncategorizedIncome;

  // Expenses = approved/reimbursed expenses + paid bills (so the P&L matches
  // money actually committed in the period — drafts are excluded).
  const plExpenseConds = [
    sql`${expensesTable.status} in ('approved', 'reimbursed', 'submitted')`,
  ];
  if (fromDate) plExpenseConds.push(gte(expensesTable.expenseDate, fromDate));
  if (toDate) plExpenseConds.push(lte(expensesTable.expenseDate, toDate));
  const plExpenseRows = await db
    .select({
      programId: expensesTable.programId,
      amount: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
    })
    .from(expensesTable)
    .where(and(...plExpenseConds))
    .groupBy(expensesTable.programId);

  const plBillConds = [sql`${billsTable.status} in ('paid', 'scheduled')`];
  if (fromDate) plBillConds.push(gte(billsTable.dueDate, fromDate));
  if (toDate) plBillConds.push(lte(billsTable.dueDate, toDate));
  const plBillRows = await db
    .select({
      programId: billsTable.programId,
      amount: sql<string>`coalesce(sum(${billsTable.amount}), 0)::text`,
    })
    .from(billsTable)
    .where(and(...plBillConds))
    .groupBy(billsTable.programId);

  const expenseByProgramMap = new Map<number | null, number>();
  for (const r of plExpenseRows) {
    const k = r.programId;
    expenseByProgramMap.set(k, (expenseByProgramMap.get(k) ?? 0) + parseFloat(r.amount));
  }
  for (const r of plBillRows) {
    const k = r.programId;
    expenseByProgramMap.set(k, (expenseByProgramMap.get(k) ?? 0) + parseFloat(r.amount));
  }
  expensesByProgram = [...expenseByProgramMap.entries()]
    .filter(([k]) => k !== null)
    .map(([k, amount]) => {
      const program = programs.find((p) => p.id === k);
      return {
        programId: k as number,
        programName: program?.name ?? `Program #${k}`,
        amount,
      };
    })
    .sort((a, b) => b.amount - a.amount);
  uncategorizedExpenses = expenseByProgramMap.get(null) ?? 0;
  totalExpenses =
    expensesByProgram.reduce((s, r) => s + r.amount, 0) + uncategorizedExpenses;

  // ---- Balance sheet snapshot (as-of `toDate`, ignoring fromDate) ----
  const reconciledAgg = await db
    .select({
      credits: sql<string>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.type} = 'credit'), 0)::text`,
      debits: sql<string>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.type} = 'debit'), 0)::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        sql`${transactionsTable.status} = 'reconciled'`,
        ...(toDate ? [lte(transactionsTable.transactionDate, toDate)] : []),
      ),
    );
  cashOnHand =
    parseFloat(reconciledAgg[0]?.credits ?? "0") -
    parseFloat(reconciledAgg[0]?.debits ?? "0");

  const receivableAgg = await db
    .select({
      amount: sql<string>`coalesce(sum(${transactionsTable.amount}), 0)::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        sql`${transactionsTable.type} = 'credit'`,
        sql`${transactionsTable.status} in ('unmatched', 'matched')`,
        ...(toDate ? [lte(transactionsTable.transactionDate, toDate)] : []),
      ),
    );
  outstandingReceivables = parseFloat(receivableAgg[0]?.amount ?? "0");

  const unpaidBillAgg = await db
    .select({
      amount: sql<string>`coalesce(sum(${billsTable.amount}), 0)::text`,
    })
    .from(billsTable)
    .where(
      and(
        sql`${billsTable.status} in ('draft', 'scheduled', 'overdue')`,
        ...(toDate ? [lte(billsTable.dueDate, toDate)] : []),
      ),
    );
  unpaidBills = parseFloat(unpaidBillAgg[0]?.amount ?? "0");

  const unreimbursedAgg = await db
    .select({
      amount: sql<string>`coalesce(sum(${expensesTable.amount}), 0)::text`,
    })
    .from(expensesTable)
    .where(
      and(
        sql`${expensesTable.status} in ('approved', 'submitted')`,
        ...(toDate ? [lte(expensesTable.expenseDate, toDate)] : []),
      ),
    );
  unreimbursedExpenses = parseFloat(unreimbursedAgg[0]?.amount ?? "0");

  totalAssets = cashOnHand + outstandingReceivables;
  totalLiabilities = unpaidBills + unreimbursedExpenses;
  equity = totalAssets - totalLiabilities;
  // Operational source has no CoA subtype — mirror the legacy fields onto
  // the new breakdown so the contract stays uniform across both sources.
  cash = cashOnHand;
  accountsReceivable = outstandingReceivables;
  otherAssets = 0;
  accountsPayable = unpaidBills;
  otherLiabilities = unreimbursedExpenses;
  } // end operational branch

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
      profitAndLoss: {
        incomeByProgram,
        uncategorizedIncome,
        totalIncome,
        expensesByProgram,
        uncategorizedExpenses,
        totalExpenses,
        netIncome: totalIncome - totalExpenses,
        incomeByAccount,
        expensesByAccount,
      },
      balanceSheet: {
        cashOnHand,
        outstandingReceivables,
        unpaidBills,
        unreimbursedExpenses,
        cash,
        accountsReceivable,
        otherAssets,
        accountsPayable,
        otherLiabilities,
        totalAssets,
        totalLiabilities,
        equity,
        // Task 31 — split the single equity total into the two GAAP-style
        // components (opening net assets carried forward + current period
        // net income). Defining opening as `equity − currentPeriodNetIncome`
        // guarantees the three rows reconcile to assets − liabilities.
        currentPeriodNetIncome: totalIncome - totalExpenses,
        openingNetAssets: equity - (totalIncome - totalExpenses),
        cashAccounts,
        accountsReceivableAccounts,
        otherAssetAccounts,
        accountsPayableAccounts,
        otherLiabilityAccounts,
      },
    })
  );
});

// ---------------------------------------------------------------------------
// Task 38 — GET /reports/account-activity?accountId=&from=&to=
//
// Drill-down for the Reports page Balance Sheet: returns posted journal-entry
// lines that contributed to a single CoA account's balance over the requested
// date range. Includes both `posted` and `reversed` originals so the rendered
// list matches what the Balance Sheet was computed from (reversal pairs net
// to zero in both views).
// ---------------------------------------------------------------------------
const AccountActivityQuery = z.object({
  accountId: z.coerce.number().int().positive(),
  fromDate: isoDateString.optional(),
  toDate: isoDateString.optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
}).transform((d) => ({
  accountId: d.accountId,
  fromDate: d.fromDate ?? d.from,
  toDate: d.toDate ?? d.to,
}));

router.get("/reports/account-activity", async (req, res): Promise<void> => {
  const parsed = AccountActivityQuery.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.format() });
    return;
  }
  const { accountId, fromDate, toDate } = parsed.data;

  const [account] = await db
    .select()
    .from(chartOfAccountsTable)
    .where(eq(chartOfAccountsTable.id, accountId));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const conds = [
    eq(journalEntryLinesTable.accountId, accountId),
    sql`${journalEntriesTable.status} in ('posted', 'reversed')`,
  ];
  if (fromDate) conds.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate) conds.push(lte(journalEntriesTable.entryDate, toDate));

  const rows = await db
    .select({
      lineId: journalEntryLinesTable.id,
      journalEntryId: journalEntryLinesTable.journalEntryId,
      type: journalEntryLinesTable.type,
      amountCents: journalEntryLinesTable.amountCents,
      lineMemo: journalEntryLinesTable.memo,
      program: journalEntryLinesTable.program,
      fund: journalEntryLinesTable.fund,
      entryNo: journalEntriesTable.entryNo,
      entryDate: journalEntriesTable.entryDate,
      entryMemo: journalEntriesTable.memo,
      entryStatus: journalEntriesTable.status,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .where(and(...conds))
    .orderBy(
      sql`${journalEntriesTable.entryDate} desc, ${journalEntryLinesTable.id} desc`,
    );

  let debitsCents = 0;
  let creditsCents = 0;
  const lines = rows.map((r) => {
    const amount = Number(r.amountCents);
    const debit = r.type === "debit" ? amount : 0;
    const credit = r.type === "credit" ? amount : 0;
    debitsCents += debit;
    creditsCents += credit;
    return {
      lineId: r.lineId,
      journalEntryId: r.journalEntryId,
      entryNo: r.entryNo,
      entryDate: r.entryDate,
      entryMemo: r.entryMemo,
      entryStatus: r.entryStatus,
      lineMemo: r.lineMemo,
      program: r.program,
      fund: r.fund,
      debit: debit / 100,
      credit: credit / 100,
    };
  });

  // Signed balance follows the account's normal-balance convention so the
  // total here matches the balance shown on the Balance Sheet card.
  const balanceCents =
    account.normalBalance === "credit"
      ? creditsCents - debitsCents
      : debitsCents - creditsCents;

  res.json({
    account,
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    lines,
    totals: {
      debits: debitsCents / 100,
      credits: creditsCents / 100,
      balance: balanceCents / 100,
    },
  });
});

// ---------------------------------------------------------------------------
// Step 9 — GET /reports/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns one row per Chart of Accounts code with the sum of debit and credit
// activity over the requested date range, plus a net "balance" expressed
// according to the account's normal_balance (debit-normal accounts net as
// debits − credits; credit-normal accounts net as credits − debits).
//
// The endpoint also returns whether total debits = total credits to the cent
// — this should always hold for a valid double-entry ledger; if it does not,
// the report shows the imbalance so the operator can investigate.
//
// Includes journal_entries with status IN ('posted','reversed'). When a JE is
// reversed in this codebase the original row is flipped to status='reversed'
// and an inverse JE is created with status='posted'. Including both ensures
// reversed pairs net to zero in the Trial Balance instead of leaving the
// inverse hanging as a one-sided debit/credit.
// ---------------------------------------------------------------------------
router.get("/reports/trial-balance", async (req, res): Promise<void> => {
  // Step 9 — Trial Balance is admin/approver only.
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "approver") {
    res.status(403).json({ error: "Trial Balance is restricted to admins and approvers." });
    return;
  }
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid date range", details: parsed.error.format() });
    return;
  }
  const { fromDate, toDate } = parsed.data;

  const conds = [
    sql`${journalEntriesTable.status} in ('posted', 'reversed')`,
  ];
  if (fromDate) conds.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate) conds.push(lte(journalEntriesTable.entryDate, toDate));

  const totals = await db
    .select({
      accountId: journalEntryLinesTable.accountId,
      legacyAccount: journalEntryLinesTable.account,
      debitsCents: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      creditsCents: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .where(and(...conds))
    .groupBy(journalEntryLinesTable.accountId, journalEntryLinesTable.account);

  const accountRows = await db
    .select({
      id: chartOfAccountsTable.id,
      code: chartOfAccountsTable.code,
      name: chartOfAccountsTable.name,
      type: chartOfAccountsTable.type,
      subtype: chartOfAccountsTable.subtype,
      normalBalance: chartOfAccountsTable.normalBalance,
      isActive: chartOfAccountsTable.isActive,
    })
    .from(chartOfAccountsTable)
    .orderBy(asc(chartOfAccountsTable.code));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  // Aggregate by account. Lines with NULL accountId (should be zero post-S2)
  // are still surfaced under a synthetic "(unmapped)" bucket so they cannot
  // hide ledger imbalance.
  type Bucket = {
    accountId: number | null;
    code: string;
    name: string;
    type: string | null;
    subtype: string | null;
    normalBalance: "debit" | "credit" | null;
    isActive: boolean;
    debitsCents: number;
    creditsCents: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const t of totals) {
    let key: string;
    let base: Omit<Bucket, "debitsCents" | "creditsCents">;
    if (t.accountId !== null) {
      const a = accountById.get(t.accountId);
      key = `id:${t.accountId}`;
      base = {
        accountId: t.accountId,
        code: a?.code ?? `#${t.accountId}`,
        name: a?.name ?? t.legacyAccount,
        type: a?.type ?? null,
        subtype: a?.subtype ?? null,
        normalBalance: (a?.normalBalance as "debit" | "credit" | null) ?? null,
        isActive: a?.isActive ?? true,
      };
    } else {
      key = `legacy:${t.legacyAccount}`;
      base = {
        accountId: null,
        code: "(unmapped)",
        name: t.legacyAccount,
        type: null,
        subtype: null,
        normalBalance: null,
        isActive: true,
      };
    }
    const existing = buckets.get(key);
    if (existing) {
      existing.debitsCents += Number(t.debitsCents);
      existing.creditsCents += Number(t.creditsCents);
    } else {
      buckets.set(key, {
        ...base,
        debitsCents: Number(t.debitsCents),
        creditsCents: Number(t.creditsCents),
      });
    }
  }

  const rows = Array.from(buckets.values())
    .filter((b) => b.debitsCents > 0 || b.creditsCents > 0)
    .map((b) => {
      // Net balance is positive on the side that matches normal_balance.
      const netCents =
        b.normalBalance === "credit"
          ? b.creditsCents - b.debitsCents
          : b.debitsCents - b.creditsCents;
      return {
        accountId: b.accountId,
        code: b.code,
        name: b.name,
        type: b.type,
        subtype: b.subtype,
        normalBalance: b.normalBalance,
        isActive: b.isActive,
        debits: (b.debitsCents / 100).toFixed(2),
        credits: (b.creditsCents / 100).toFixed(2),
        balance: (netCents / 100).toFixed(2),
        balanceSide: netCents >= 0 ? b.normalBalance ?? "debit" : (b.normalBalance === "credit" ? "debit" : "credit"),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebitsCents = rows.reduce(
    (s, r) => s + Math.round(parseFloat(r.debits) * 100),
    0,
  );
  const totalCreditsCents = rows.reduce(
    (s, r) => s + Math.round(parseFloat(r.credits) * 100),
    0,
  );

  // Step 9 — audit-log every Trial Balance generation so reviewers can see
  // who pulled which date range. Failures here must not break the report.
  try {
    const u = req.authUser;
    const actor =
      u && (u.firstName || u.lastName)
        ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim()
        : (u?.email ?? "system");
    await db.insert(activityLogTable).values({
      type: "report.trial_balance",
      description: `Generated Trial Balance for ${fromDate ?? "(beginning)"} → ${toDate ?? "(today)"} — ${rows.length} accounts, ${totalDebitsCents === totalCreditsCents ? "balanced" : `IMBALANCED by ${(totalDebitsCents - totalCreditsCents) / 100}`}`,
      actor,
      referenceType: "trial_balance",
    });
  } catch (err) {
    req.log?.warn({ err }, "failed to audit-log trial balance");
  }

  res.json({
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    rows,
    totals: {
      debits: (totalDebitsCents / 100).toFixed(2),
      credits: (totalCreditsCents / 100).toFixed(2),
      balanced: totalDebitsCents === totalCreditsCents,
      differenceCents: totalDebitsCents - totalCreditsCents,
    },
  });
});

// ---------------------------------------------------------------------------
// Task #63 — GET /reports/reconciliation?from=&to=
//
// Programmatic tie-out checks proving that the Trial Balance, P&L, and Balance
// Sheet (ledger source) all reconcile to the same posted-JE source of truth.
// Admin/approver only (same gate as Trial Balance).
//
// Each check has the shape:
//   { id, label, expectedCents, actualCents, deltaCents, ok, severity }
// where ok = (deltaCents === 0). Caller renders ✓/✗ per row.
// ---------------------------------------------------------------------------
type ReconciliationCheck = {
  id: string;
  label: string;
  expectedCents: number;
  actualCents: number;
  deltaCents: number;
  ok: boolean;
  severity: "error" | "warning";
};

const toCents = (dollars: number) => Math.round(dollars * 100);

router.get("/reports/reconciliation", async (req, res): Promise<void> => {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "approver") {
    res
      .status(403)
      .json({ error: "Reconciliation report is restricted to admins and approvers." });
    return;
  }
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid date range", details: parsed.error.format() });
    return;
  }
  const { fromDate, toDate } = parsed.data;

  // ---- Independent Trial Balance aggregation over [fromDate, toDate] -------
  // Uses the same WHERE shape as /reports/trial-balance and includes lines
  // whose accountId is NULL so unmapped activity cannot hide imbalance.
  const tbConds = [sql`${journalEntriesTable.status} in ('posted', 'reversed')`];
  if (fromDate) tbConds.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate) tbConds.push(lte(journalEntriesTable.entryDate, toDate));

  const tbRows = await db
    .select({
      accountId: journalEntryLinesTable.accountId,
      type: chartOfAccountsTable.type,
      debits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'debit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
      credits: sql<number>`coalesce(sum(case when ${journalEntryLinesTable.type} = 'credit' then ${journalEntryLinesTable.amountCents} else 0 end), 0)::int`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .leftJoin(
      chartOfAccountsTable,
      eq(journalEntryLinesTable.accountId, chartOfAccountsTable.id),
    )
    .groupBy(journalEntryLinesTable.accountId, chartOfAccountsTable.type)
    .where(and(...tbConds));

  let tbDebitsCents = 0;
  let tbCreditsCents = 0;
  let tbRevenueNetCents = 0; // credits - debits
  let tbExpenseNetCents = 0; // debits - credits
  for (const r of tbRows) {
    const d = Number(r.debits);
    const c = Number(r.credits);
    tbDebitsCents += d;
    tbCreditsCents += c;
    if (r.type === "revenue") tbRevenueNetCents += c - d;
    else if (r.type === "expense") tbExpenseNetCents += d - c;
  }

  // ---- Ledger summary (P&L + BS) via the shared helper ---------------------
  const ls = await computeLedgerSummary(fromDate, toDate);
  const totalIncomeCents = toCents(ls.totalIncome);
  const totalExpensesCents = toCents(ls.totalExpenses);
  const netIncomeCents = totalIncomeCents - totalExpensesCents;
  const totalAssetsCents = toCents(ls.totalAssets);
  const totalLiabilitiesCents = toCents(ls.totalLiabilities);
  const equityCents = toCents(ls.equity);

  const sumAccountAmountsCents = (rows: { amount: number }[]) =>
    toCents(rows.reduce((s, r) => s + r.amount, 0));
  const sumBalanceCents = (rows: { balance: number }[]) =>
    toCents(rows.reduce((s, r) => s + r.balance, 0));

  const checks: ReconciliationCheck[] = [];
  const push = (
    id: string,
    label: string,
    expectedCents: number,
    actualCents: number,
    severity: "error" | "warning" = "error",
  ) => {
    const deltaCents = actualCents - expectedCents;
    checks.push({
      id,
      label,
      expectedCents,
      actualCents,
      deltaCents,
      ok: deltaCents === 0,
      severity,
    });
  };

  // C1 — fundamental ledger integrity.
  push("trial_balance_balanced", "Trial Balance: debits = credits", tbDebitsCents, tbCreditsCents);

  // C2 / C3 — per-account aggregation rolls up to financial-summary totals.
  push(
    "pl_income_account_sum_matches",
    "P&L: Σ income-by-account = Total Income",
    totalIncomeCents,
    sumAccountAmountsCents(ls.incomeByAccount),
  );
  push(
    "pl_expense_account_sum_matches",
    "P&L: Σ expense-by-account = Total Expenses",
    totalExpensesCents,
    sumAccountAmountsCents(ls.expensesByAccount),
  );

  // C4 / C5 — Trial Balance derived totals match P&L totals.
  push(
    "pl_income_matches_tb_revenue",
    "P&L Total Income = Σ TB revenue accounts (credits − debits)",
    totalIncomeCents,
    tbRevenueNetCents,
  );
  push(
    "pl_expense_matches_tb_expense",
    "P&L Total Expenses = Σ TB expense accounts (debits − credits)",
    totalExpensesCents,
    tbExpenseNetCents,
  );

  // C6 — accounting identity. Will fail iff TB is unbalanced.
  push(
    "bs_equity_equals_assets_minus_liabilities",
    "Balance Sheet: Equity = Assets − Liabilities",
    totalAssetsCents - totalLiabilitiesCents,
    equityCents,
  );

  // (Removed tautological "bs_net_income_matches_pl": both sides derive from
  // the same totalIncome - totalExpenses expression, so the check could never
  // detect drift. The accounting identity check above already covers the BS
  // / P&L tie-out via Assets − Liabilities = Equity, where Equity is plugged
  // with current-period net income.)

  // C8–C12 — per-subtype account rows sum to the displayed subtotal.
  push(
    "bs_cash_subtotal_matches",
    "BS: Σ cash accounts = Cash subtotal",
    toCents(ls.cash),
    sumBalanceCents(ls.cashAccounts),
  );
  push(
    "bs_ar_subtotal_matches",
    "BS: Σ A/R accounts = A/R subtotal",
    toCents(ls.accountsReceivable),
    sumBalanceCents(ls.accountsReceivableAccounts),
  );
  push(
    "bs_other_assets_subtotal_matches",
    "BS: Σ other-asset accounts = Other-Assets subtotal",
    toCents(ls.otherAssets),
    sumBalanceCents(ls.otherAssetAccounts),
  );
  push(
    "bs_ap_subtotal_matches",
    "BS: Σ A/P accounts = A/P subtotal",
    toCents(ls.accountsPayable),
    sumBalanceCents(ls.accountsPayableAccounts),
  );
  push(
    "bs_other_liabilities_subtotal_matches",
    "BS: Σ other-liability accounts = Other-Liabilities subtotal",
    toCents(ls.otherLiabilities),
    sumBalanceCents(ls.otherLiabilityAccounts),
  );

  const allOk = checks.every((c) => c.ok);
  const errorCount = checks.filter((c) => !c.ok && c.severity === "error").length;
  const warningCount = checks.filter((c) => !c.ok && c.severity === "warning").length;

  res.json({
    generatedAt: new Date().toISOString(),
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    allOk,
    errorCount,
    warningCount,
    checks,
  });
});

export default router;
