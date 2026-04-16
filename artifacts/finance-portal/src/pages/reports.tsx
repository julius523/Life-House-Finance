import { useState } from "react";
import { useGetFinancialSummaryReport } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, BarChart3 } from "lucide-react";
import { format } from "date-fns";

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);

const fmtPct = (n?: number) =>
  n === undefined ? "—" : `${n.toFixed(1)}%`;

const titleCase = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function ReportsPage() {
  const today = new Date().toISOString().split("T")[0]!;
  const monthAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90)
    .toISOString()
    .split("T")[0]!;
  const [fromDate, setFromDate] = useState<string>(monthAgo);
  const [toDate, setToDate] = useState<string>(today);

  const { data, isLoading } = useGetFinancialSummaryReport({
    fromDate,
    toDate,
  });

  const handlePrint = () => window.print();

  return (
    <div className="space-y-6 print:space-y-4">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .print-page-break { break-before: page; }
          aside, nav, [data-sidebar] { display: none !important; }
          main { padding: 0 !important; }
        }
      `}</style>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground mt-1">
            Generate a printable financial summary across any date range.
          </p>
        </div>
        <Button
          onClick={handlePrint}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Printer className="mr-2 h-4 w-4" /> Print Report
        </Button>
      </div>

      <Card className="no-print">
        <CardHeader>
          <CardTitle className="text-base">Date range</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="hidden print:block space-y-1 mb-4">
        <h1 className="text-2xl font-bold">Life House Reentry — Financial Summary</h1>
        <p className="text-sm text-muted-foreground">
          Period: {format(new Date(fromDate), "MMM d, yyyy")} —{" "}
          {format(new Date(toDate), "MMM d, yyyy")}
        </p>
        {data?.generatedAt && (
          <p className="text-xs text-muted-foreground">
            Generated {format(new Date(data.generatedAt), "PPpp")}
          </p>
        )}
      </div>

      {isLoading || !data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryStat
              label="Total income (P&L)"
              value={fmtMoney(data.profitAndLoss.totalIncome)}
              accent="ok"
            />
            <SummaryStat
              label="Total expenses (P&L)"
              value={fmtMoney(data.profitAndLoss.totalExpenses)}
            />
            <SummaryStat
              label="Net income"
              value={fmtMoney(data.profitAndLoss.netIncome)}
              accent={data.profitAndLoss.netIncome >= 0 ? "ok" : "warn"}
            />
            <SummaryStat
              label="Cash on hand"
              value={fmtMoney(data.balanceSheet.cashOnHand)}
              accent={data.balanceSheet.cashOnHand >= 0 ? "ok" : "warn"}
            />
          </div>

          <Card className="print-page-break">
            <CardHeader>
              <CardTitle className="text-base">
                Profit &amp; Loss Statement
              </CardTitle>
              <CardDescription>
                Cash-basis income vs. committed spend for the selected period.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div>
                  <div className="font-semibold text-success mb-2">Income</div>
                  <table className="w-full text-sm">
                    <tbody>
                      {data.profitAndLoss.incomeByProgram.length === 0 &&
                        data.profitAndLoss.uncategorizedIncome === 0 && (
                          <tr>
                            <td className="py-2 text-muted-foreground">
                              No income recorded in this period.
                            </td>
                          </tr>
                        )}
                      {data.profitAndLoss.incomeByProgram.map((row) => (
                        <tr key={row.programName} className="border-b last:border-0">
                          <td className="py-2">{row.programName}</td>
                          <td className="py-2 text-right font-medium">
                            {fmtMoney(row.amount)}
                          </td>
                        </tr>
                      ))}
                      {data.profitAndLoss.uncategorizedIncome > 0 && (
                        <tr className="border-b last:border-0">
                          <td className="py-2 italic text-muted-foreground">
                            Unallocated deposits
                          </td>
                          <td className="py-2 text-right font-medium">
                            {fmtMoney(data.profitAndLoss.uncategorizedIncome)}
                          </td>
                        </tr>
                      )}
                      <tr className="border-t-2 border-success/30">
                        <td className="py-2 font-bold">Total income</td>
                        <td className="py-2 text-right font-bold text-success">
                          {fmtMoney(data.profitAndLoss.totalIncome)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <div className="font-semibold mb-2">Expenses</div>
                  <table className="w-full text-sm">
                    <tbody>
                      {data.profitAndLoss.expensesByProgram.length === 0 &&
                        data.profitAndLoss.uncategorizedExpenses === 0 && (
                          <tr>
                            <td className="py-2 text-muted-foreground">
                              No expenses recorded in this period.
                            </td>
                          </tr>
                        )}
                      {data.profitAndLoss.expensesByProgram.map((row) => (
                        <tr key={row.programName} className="border-b last:border-0">
                          <td className="py-2">{row.programName}</td>
                          <td className="py-2 text-right font-medium">
                            {fmtMoney(row.amount)}
                          </td>
                        </tr>
                      ))}
                      {data.profitAndLoss.uncategorizedExpenses > 0 && (
                        <tr className="border-b last:border-0">
                          <td className="py-2 italic text-muted-foreground">
                            Unallocated
                          </td>
                          <td className="py-2 text-right font-medium">
                            {fmtMoney(data.profitAndLoss.uncategorizedExpenses)}
                          </td>
                        </tr>
                      )}
                      <tr className="border-t-2 border-foreground/20">
                        <td className="py-2 font-bold">Total expenses</td>
                        <td className="py-2 text-right font-bold">
                          {fmtMoney(data.profitAndLoss.totalExpenses)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between border-t-2 pt-3">
                  <div className="font-bold text-base">Net income</div>
                  <div
                    className={`font-bold text-lg ${
                      data.profitAndLoss.netIncome >= 0
                        ? "text-success"
                        : "text-destructive"
                    }`}
                  >
                    {fmtMoney(data.profitAndLoss.netIncome)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Balance Sheet</CardTitle>
              <CardDescription>
                Snapshot as of {format(new Date(toDate), "MMM d, yyyy")}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="font-semibold mb-2">Assets</div>
                  <dl className="text-sm divide-y">
                    <Row k="Cash on hand" v={fmtMoney(data.balanceSheet.cashOnHand)} />
                    <Row
                      k="Outstanding receivables"
                      v={fmtMoney(data.balanceSheet.outstandingReceivables)}
                    />
                    <Row
                      k="Total assets"
                      v={fmtMoney(data.balanceSheet.totalAssets)}
                      accent="ok"
                    />
                  </dl>
                </div>
                <div>
                  <div className="font-semibold mb-2">Liabilities</div>
                  <dl className="text-sm divide-y">
                    <Row k="Unpaid bills" v={fmtMoney(data.balanceSheet.unpaidBills)} />
                    <Row
                      k="Unreimbursed expenses"
                      v={fmtMoney(data.balanceSheet.unreimbursedExpenses)}
                    />
                    <Row
                      k="Total liabilities"
                      v={fmtMoney(data.balanceSheet.totalLiabilities)}
                      accent={
                        data.balanceSheet.totalLiabilities > 0 ? "warn" : undefined
                      }
                    />
                  </dl>
                </div>
              </div>
              <div className="mt-6 flex items-center justify-between border-t-2 pt-3">
                <div className="font-bold text-base">Equity (Assets − Liabilities)</div>
                <div
                  className={`font-bold text-lg ${
                    data.balanceSheet.equity >= 0
                      ? "text-success"
                      : "text-destructive"
                  }`}
                >
                  {fmtMoney(data.balanceSheet.equity)}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="print-page-break" />

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" /> Expense Claims by Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2">Status</th>
                      <th className="py-2 text-right">Count</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.expenseTotalsByStatus.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-4 text-muted-foreground text-center">
                          No expenses in this period.
                        </td>
                      </tr>
                    )}
                    {data.expenseTotalsByStatus.map((row) => (
                      <tr key={row.status} className="border-b last:border-0">
                        <td className="py-2">{titleCase(row.status)}</td>
                        <td className="py-2 text-right">{row.count}</td>
                        <td className="py-2 text-right font-medium">
                          {fmtMoney(row.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" /> Vendor Bills by Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2">Status</th>
                      <th className="py-2 text-right">Count</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.billTotalsByStatus.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-4 text-muted-foreground text-center">
                          No bills in this period.
                        </td>
                      </tr>
                    )}
                    {data.billTotalsByStatus.map((row) => (
                      <tr key={row.status} className="border-b last:border-0">
                        <td className="py-2">{titleCase(row.status)}</td>
                        <td className="py-2 text-right">{row.count}</td>
                        <td className="py-2 text-right font-medium">
                          {fmtMoney(row.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Spend by Program / Grant</CardTitle>
              <CardDescription>
                Combined expense + bill spend, with budget utilisation when defined.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2">Program</th>
                    <th className="py-2 text-right">Expenses</th>
                    <th className="py-2 text-right">Bills</th>
                    <th className="py-2 text-right">Total</th>
                    <th className="py-2 text-right">Budget</th>
                    <th className="py-2 text-right">% Used</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spendByProgram.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-4 text-muted-foreground text-center">
                        No program spend in this period.
                      </td>
                    </tr>
                  )}
                  {data.spendByProgram.map((row) => (
                    <tr key={row.programName} className="border-b last:border-0">
                      <td className="py-2 font-medium">{row.programName}</td>
                      <td className="py-2 text-right">{fmtMoney(row.expenseAmount)}</td>
                      <td className="py-2 text-right">{fmtMoney(row.billAmount)}</td>
                      <td className="py-2 text-right font-semibold">
                        {fmtMoney(row.totalAmount)}
                      </td>
                      <td className="py-2 text-right">
                        {row.budgetAmount ? fmtMoney(row.budgetAmount) : "—"}
                      </td>
                      <td className="py-2 text-right">{fmtPct(row.percentUsed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Expenses Missing Receipts</CardTitle>
              <CardDescription>
                {data.missingReceipts.length === 0
                  ? "All submitted expenses have receipts attached."
                  : `${data.missingReceipts.length} expense${
                      data.missingReceipts.length === 1 ? "" : "s"
                    } awaiting documentation (totals ${fmtMoney(
                      data.missingReceiptAmount,
                    )}).`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2">Expense</th>
                    <th className="py-2">Submitted by</th>
                    <th className="py-2">Date</th>
                    <th className="py-2 text-right">Days open</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.missingReceipts.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-4 text-muted-foreground text-center"
                      >
                        Nothing to follow up on.
                      </td>
                    </tr>
                  )}
                  {data.missingReceipts.map((row) => (
                    <tr key={row.expenseId} className="border-b last:border-0">
                      <td className="py-2 font-medium">
                        #{row.expenseId} · {row.merchant}
                      </td>
                      <td className="py-2">{row.submittedBy}</td>
                      <td className="py-2">{row.expenseDate}</td>
                      <td className="py-2 text-right">
                        {row.daysSinceSubmission}
                      </td>
                      <td className="py-2 text-right font-semibold">
                        {fmtMoney(row.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top Vendors</CardTitle>
                <CardDescription>By total spend in this period.</CardDescription>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2">Vendor</th>
                      <th className="py-2 text-right">Bills</th>
                      <th className="py-2 text-right">Expenses</th>
                      <th className="py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topVendors.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-4 text-muted-foreground text-center">
                          No vendor activity.
                        </td>
                      </tr>
                    )}
                    {data.topVendors.map((v) => (
                      <tr key={v.vendorName} className="border-b last:border-0">
                        <td className="py-2 font-medium">{v.vendorName}</td>
                        <td className="py-2 text-right">{fmtMoney(v.billAmount)}</td>
                        <td className="py-2 text-right">{fmtMoney(v.expenseAmount)}</td>
                        <td className="py-2 text-right font-semibold">
                          {fmtMoney(v.totalAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Bank Reconciliation</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="text-sm divide-y">
                  <Row k="Total transactions" v={String(data.bankReconciliation.totalTransactions)} />
                  <Row k="Reconciled" v={String(data.bankReconciliation.reconciled)} />
                  <Row k="Matched" v={String(data.bankReconciliation.matched)} />
                  <Row
                    k="Unmatched"
                    v={String(data.bankReconciliation.unmatched)}
                    accent={data.bankReconciliation.unmatched > 0 ? "warn" : undefined}
                  />
                  <Row k="Total credits (in)" v={fmtMoney(data.bankReconciliation.totalCredits)} />
                  <Row k="Total debits (out)" v={fmtMoney(data.bankReconciliation.totalDebits)} />
                  <Row
                    k="Net cash flow"
                    v={fmtMoney(data.bankReconciliation.netCashFlow)}
                    accent={data.bankReconciliation.netCashFlow >= 0 ? "ok" : "warn"}
                  />
                </dl>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "ok" | "warn";
}) {
  const cls =
    accent === "ok"
      ? "text-success"
      : accent === "warn"
        ? "text-warning"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className={`text-2xl font-bold mt-1 ${cls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Row({
  k,
  v,
  accent,
}: {
  k: string;
  v: string;
  accent?: "ok" | "warn";
}) {
  const cls =
    accent === "ok"
      ? "text-success"
      : accent === "warn"
        ? "text-warning"
        : undefined;
  return (
    <div className="flex items-center justify-between py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`font-semibold ${cls ?? ""}`}>{v}</dd>
    </div>
  );
}
