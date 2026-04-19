import { useMemo, useState } from "react";
import {
  useGetFinancialSummaryReport,
  useGetTrialBalanceReport,
  useGetAccountActivityReport,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, BarChart3 } from "lucide-react";
import { format } from "date-fns";
import { Checkbox } from "@/components/ui/checkbox";
import { PeriodDraftsBanner } from "@/components/period-drafts-banner";

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

type SectionKey =
  | "summary"
  | "pl"
  | "balance"
  | "trialBalance"
  | "byStatus"
  | "spendByProgram"
  | "missingReceipts"
  | "topVendors"
  | "bank";

export default function ReportsPage() {
  const today = new Date().toISOString().split("T")[0]!;
  const monthAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90)
    .toISOString()
    .split("T")[0]!;
  const [fromDate, setFromDate] = useState<string>(monthAgo);
  const [toDate, setToDate] = useState<string>(today);

  const iso = (d: Date) => d.toISOString().split("T")[0]!;
  const setRange = (from: Date, to: Date) => {
    setFromDate(iso(from));
    setToDate(iso(to));
  };
  const now = new Date();
  const presets: { label: string; apply: () => void }[] = [
    {
      label: "This month",
      apply: () =>
        setRange(new Date(now.getFullYear(), now.getMonth(), 1), now),
    },
    {
      label: "Last month",
      apply: () =>
        setRange(
          new Date(now.getFullYear(), now.getMonth() - 1, 1),
          new Date(now.getFullYear(), now.getMonth(), 0),
        ),
    },
    {
      label: "This quarter",
      apply: () => {
        const q = Math.floor(now.getMonth() / 3);
        setRange(new Date(now.getFullYear(), q * 3, 1), now);
      },
    },
    {
      label: "Last quarter",
      apply: () => {
        const q = Math.floor(now.getMonth() / 3) - 1;
        const y = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
        const qq = (q + 4) % 4;
        setRange(
          new Date(y, qq * 3, 1),
          new Date(y, qq * 3 + 3, 0),
        );
      },
    },
    {
      label: "Year to date",
      apply: () => setRange(new Date(now.getFullYear(), 0, 1), now),
    },
    {
      label: "Last year",
      apply: () =>
        setRange(
          new Date(now.getFullYear() - 1, 0, 1),
          new Date(now.getFullYear() - 1, 11, 31),
        ),
    },
    {
      label: "Last 30 days",
      apply: () =>
        setRange(new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), now),
    },
    {
      label: "Last 90 days",
      apply: () =>
        setRange(new Date(Date.now() - 1000 * 60 * 60 * 24 * 90), now),
    },
    {
      label: "All time",
      apply: () => setRange(new Date(2000, 0, 1), now),
    },
  ];

  const SECTIONS: { key: SectionKey; label: string }[] = [
    { key: "summary", label: "Top summary stats" },
    { key: "pl", label: "Profit & Loss" },
    { key: "balance", label: "Balance Sheet" },
    { key: "trialBalance", label: "Trial Balance (GL)" },
    { key: "byStatus", label: "Expenses & Bills by Status" },
    { key: "spendByProgram", label: "Spend by Program / Grant" },
    { key: "missingReceipts", label: "Missing receipts" },
    { key: "topVendors", label: "Top Vendors" },
    { key: "bank", label: "Bank Reconciliation" },
  ];
  const [selected, setSelected] = useState<Record<SectionKey, boolean>>({
    summary: true,
    pl: true,
    balance: true,
    trialBalance: true,
    byStatus: true,
    spendByProgram: true,
    missingReceipts: true,
    topVendors: true,
    bank: true,
  });
  const toggle = (k: SectionKey) =>
    setSelected((p) => ({ ...p, [k]: !p[k] }));

  // Step 9 — operational vs ledger source toggle for P&L / Balance Sheet.
  const [source, setSource] = useState<"operational" | "ledger">("operational");
  const { data: opData, isLoading: opLoading } = useGetFinancialSummaryReport({
    fromDate,
    toDate,
  });
  const {
    data: ledgerData,
    isLoading: ledgerLoading,
    error: ledgerErrorObj,
  } = useGetFinancialSummaryReport(
    { fromDate, toDate, source: "ledger" },
    { query: { enabled: source === "ledger" } },
  );
  const ledgerError = ledgerErrorObj
    ? String((ledgerErrorObj as Error)?.message ?? ledgerErrorObj)
    : null;
  const data = source === "ledger" ? ledgerData ?? opData : opData;
  const isLoading =
    source === "ledger"
      ? ledgerLoading && !ledgerData && !ledgerError
      : opLoading;

  const {
    data: tb,
    isLoading: tbLoading,
    error: tbErrorObj,
  } = useGetTrialBalanceReport({ fromDate, toDate });
  const tbError = tbErrorObj
    ? String((tbErrorObj as Error)?.message ?? tbErrorObj)
    : null;
  type TbSortKey = "code" | "name" | "type" | "debits" | "credits" | "balance";
  const [tbSort, setTbSort] = useState<{ key: TbSortKey; dir: "asc" | "desc" }>({
    key: "code",
    dir: "asc",
  });
  const toggleTbSort = (key: TbSortKey) => {
    setTbSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "code" || key === "name" || key === "type" ? "asc" : "desc" },
    );
  };
  const sortedTbRows = useMemo(() => {
    if (!tb) return [];
    const rows = [...tb.rows];
    const dir = tbSort.dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const k = tbSort.key;
      if (k === "debits" || k === "credits" || k === "balance") {
        return (parseFloat(a[k]) - parseFloat(b[k])) * dir;
      }
      const av = (a[k] ?? "") as string;
      const bv = (b[k] ?? "") as string;
      return av.localeCompare(bv) * dir;
    });
    return rows;
  }, [tb, tbSort]);
  const downloadTrialBalanceCsv = () => {
    if (!tb) return;
    const header = [
      "code",
      "name",
      "type",
      "subtype",
      "normal_balance",
      "debits",
      "credits",
      "balance",
    ];
    const escape = (v: string | number | null) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const r of tb.rows) {
      lines.push(
        [
          r.code,
          r.name,
          r.type ?? "",
          r.subtype ?? "",
          r.normalBalance ?? "",
          r.debits,
          r.credits,
          r.balance,
        ]
          .map(escape)
          .join(","),
      );
    }
    lines.push(
      ["TOTALS", "", "", "", "", tb.totals.debits, tb.totals.credits, ""]
        .map(escape)
        .join(","),
    );
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trial-balance_${fromDate}_to_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <CardTitle className="text-base">Date range &amp; sections to include</CardTitle>
          <CardDescription>
            Pick the sections you want in the printed report. Unchecked sections are hidden when printing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
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
          <div>
            <div className="text-sm font-medium mb-2">Quick ranges</div>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={p.apply}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">
              P&amp;L / Balance Sheet source
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={source === "operational" ? "default" : "outline"}
                onClick={() => setSource("operational")}
              >
                Operational (cash basis)
              </Button>
              <Button
                type="button"
                size="sm"
                variant={source === "ledger" ? "default" : "outline"}
                onClick={() => setSource("ledger")}
              >
                General Ledger (posted JEs)
              </Button>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Operational sums approved/paid expenses, bills, and bank credits.
              Ledger aggregates posted journal-entry lines by Chart-of-Accounts type.
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">Sections</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {SECTIONS.map((s) => (
                <label key={s.key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={selected[s.key]} onCheckedChange={() => toggle(s.key)} />
                  {s.label}
                </label>
              ))}
            </div>
            <div className="flex gap-2 mt-3 text-xs">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  setSelected(Object.fromEntries(SECTIONS.map((s) => [s.key, true])) as Record<SectionKey, boolean>)
                }
              >
                Select all
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  setSelected(Object.fromEntries(SECTIONS.map((s) => [s.key, false])) as Record<SectionKey, boolean>)
                }
              >
                Clear
              </button>
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

      {source === "ledger" && ledgerError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Could not load General Ledger data: {ledgerError}. Falling back to operational figures.
        </div>
      )}
      {isLoading || !data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <>
          {selected.summary && (
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
          )}

          {selected.pl && (
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
                  <div className="font-bold text-base">Net income (P&amp;L)</div>
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
          )}

          {selected.balance && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Balance Sheet</CardTitle>
              <CardDescription>
                Snapshot as of {format(new Date(toDate), "MMM d, yyyy")}.
                {source === "ledger" &&
                  " Click a row to see the underlying accounts."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="font-semibold mb-2">Assets</div>
                  <dl className="text-sm divide-y">
                    {source === "ledger" ? (
                      <>
                        <ExpandableRow
                          k="Cash"
                          v={fmtMoney(data.balanceSheet.cash)}
                          accounts={data.balanceSheet.cashAccounts}
                          fromDate={fromDate}
                          toDate={toDate}
                        />
                        <ExpandableRow
                          k="Accounts receivable"
                          v={fmtMoney(data.balanceSheet.accountsReceivable)}
                          accounts={data.balanceSheet.accountsReceivableAccounts}
                          fromDate={fromDate}
                          toDate={toDate}
                        />
                        <ExpandableRow
                          k="Other assets"
                          v={fmtMoney(data.balanceSheet.otherAssets)}
                          accounts={data.balanceSheet.otherAssetAccounts}
                          fromDate={fromDate}
                          toDate={toDate}
                        />
                      </>
                    ) : (
                      <>
                        <Row
                          k="Cash on hand"
                          v={fmtMoney(data.balanceSheet.cashOnHand)}
                        />
                        <Row
                          k="Outstanding receivables"
                          v={fmtMoney(data.balanceSheet.outstandingReceivables)}
                        />
                      </>
                    )}
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
                    {source === "ledger" ? (
                      <>
                        <ExpandableRow
                          k="Accounts payable"
                          v={fmtMoney(data.balanceSheet.accountsPayable)}
                          accounts={data.balanceSheet.accountsPayableAccounts}
                          fromDate={fromDate}
                          toDate={toDate}
                        />
                        <ExpandableRow
                          k="Other liabilities"
                          v={fmtMoney(data.balanceSheet.otherLiabilities)}
                          accounts={data.balanceSheet.otherLiabilityAccounts}
                          fromDate={fromDate}
                          toDate={toDate}
                        />
                      </>
                    ) : (
                      <>
                        <Row
                          k="Unpaid bills"
                          v={fmtMoney(data.balanceSheet.unpaidBills)}
                        />
                        <Row
                          k="Unreimbursed expenses"
                          v={fmtMoney(data.balanceSheet.unreimbursedExpenses)}
                        />
                      </>
                    )}
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
              <div className="mt-6 border-t-2 pt-3">
                <div className="font-semibold mb-2">Equity</div>
                <dl className="text-sm divide-y">
                  <Row
                    k="Opening net assets"
                    v={fmtMoney(data.balanceSheet.openingNetAssets)}
                  />
                  <Row
                    k="Current period net income"
                    v={fmtMoney(data.balanceSheet.currentPeriodNetIncome)}
                    accent={
                      data.balanceSheet.currentPeriodNetIncome >= 0
                        ? "ok"
                        : "warn"
                    }
                  />
                  <div className="flex items-center justify-between py-2 border-t-2">
                    <div className="font-bold text-base">
                      Total equity (Assets − Liabilities)
                    </div>
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
                </dl>
              </div>
            </CardContent>
          </Card>
          )}

          {selected.trialBalance && <div className="print-page-break" />}

          {selected.trialBalance && (
            <div className="no-print">
              <PeriodDraftsBanner
                fromDate={fromDate}
                toDate={toDate}
                periodLabel={`${format(new Date(fromDate), "MMM d, yyyy")} – ${format(new Date(toDate), "MMM d, yyyy")}`}
              />
            </div>
          )}

          {selected.trialBalance && (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">
                      Trial Balance (General Ledger)
                    </CardTitle>
                    <CardDescription>
                      Sourced from posted journal entries (status='posted'),
                      grouped by Chart of Accounts code. Debit-normal accounts
                      net debits − credits; credit-normal accounts net credits − debits.
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={downloadTrialBalanceCsv}
                    disabled={!tb || tbLoading}
                    className="no-print"
                  >
                    Export CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {tbError && (
                  <div className="text-sm text-destructive mb-3">
                    Could not load trial balance: {tbError}
                  </div>
                )}
                {tbLoading || !tb ? (
                  <Skeleton className="h-32" />
                ) : (
                  <>
                    <div
                      className={`mb-3 text-sm rounded-md px-3 py-2 ${
                        tb.totals.balanced
                          ? "bg-success/10 text-success"
                          : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {tb.totals.balanced
                        ? `Balanced — debits ${fmtMoney(parseFloat(tb.totals.debits))} = credits ${fmtMoney(parseFloat(tb.totals.credits))}.`
                        : `OUT OF BALANCE — debits ${fmtMoney(parseFloat(tb.totals.debits))} vs credits ${fmtMoney(parseFloat(tb.totals.credits))} (Δ ${fmtMoney(tb.totals.differenceCents / 100)}).`}
                    </div>
                    {tb.rows.length === 0 ? (
                      <div className="text-sm text-muted-foreground py-4">
                        No posted journal entry activity in this date range.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-testid="trial-balance-table">
                          <thead>
                            <tr className="text-left border-b">
                              {([
                                ["code", "Code"],
                                ["name", "Account"],
                                ["type", "Type"],
                                ["debits", "Debits", "right"],
                                ["credits", "Credits", "right"],
                                ["balance", "Balance", "right"],
                              ] as const).map(([key, label, align]) => {
                                const active = tbSort.key === key;
                                const dir = active ? tbSort.dir : null;
                                return (
                                  <th
                                    key={key}
                                    className={`py-2 pr-3 cursor-pointer select-none ${align === "right" ? "text-right" : ""}`}
                                    onClick={() => toggleTbSort(key)}
                                    data-testid={`tb-sort-${key}`}
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      {label}
                                      <span className="text-xs text-muted-foreground">
                                        {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}
                                      </span>
                                    </span>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {sortedTbRows.map((r) => (
                              <tr
                                key={`${r.accountId ?? "x"}-${r.code}`}
                                className="border-b last:border-0"
                              >
                                <td className="py-1.5 pr-3 font-mono text-xs">
                                  {r.code}
                                </td>
                                <td className="py-1.5 pr-3">{r.name}</td>
                                <td className="py-1.5 pr-3 text-muted-foreground">
                                  {r.type ? titleCase(r.type) : "—"}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                  {parseFloat(r.debits) > 0
                                    ? fmtMoney(parseFloat(r.debits))
                                    : ""}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                  {parseFloat(r.credits) > 0
                                    ? fmtMoney(parseFloat(r.credits))
                                    : ""}
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums font-medium">
                                  {fmtMoney(parseFloat(r.balance))}
                                </td>
                              </tr>
                            ))}
                            <tr className="border-t-2 font-semibold">
                              <td colSpan={3} className="py-2 pr-3">
                                Totals
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums">
                                {fmtMoney(parseFloat(tb.totals.debits))}
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums">
                                {fmtMoney(parseFloat(tb.totals.credits))}
                              </td>
                              <td className="py-2 pr-3" />
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {selected.byStatus && <div className="print-page-break" />}

          {selected.byStatus && (
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
          )}

          {selected.spendByProgram && (
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
          )}

          {selected.missingReceipts && (
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
          )}

          {(selected.topVendors || selected.bank) && (
          <div className="grid gap-6 md:grid-cols-2">
            {selected.topVendors && (
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
            )}

            {selected.bank && (
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
            )}
          </div>
          )}
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

function ExpandableRow({
  k,
  v,
  accounts,
  fromDate,
  toDate,
}: {
  k: string;
  v: string;
  accounts: { accountId: number; code: string; name: string; balance: number }[];
  fromDate: string;
  toDate: string;
}) {
  const [open, setOpen] = useState(false);
  const hasAccounts = accounts.length > 0;
  const slug = k.replace(/\s+/g, "-").toLowerCase();
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => hasAccounts && setOpen((o) => !o)}
        disabled={!hasAccounts}
        className={`flex w-full items-center justify-between py-1 text-left ${
          hasAccounts
            ? "cursor-pointer hover:text-foreground"
            : "cursor-default"
        }`}
        data-testid={`bs-row-${slug}`}
        aria-expanded={open}
      >
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          {hasAccounts && (
            <span className="text-xs text-muted-foreground tabular-nums w-3 inline-block">
              {open ? "▾" : "▸"}
            </span>
          )}
          {!hasAccounts && <span className="w-3 inline-block" />}
          {k}
        </span>
        <span className="font-semibold">{v}</span>
      </button>
      {open && hasAccounts && (
        <ul
          className="mt-1 mb-1 ml-5 border-l pl-3 text-xs space-y-1"
          data-testid={`bs-row-${slug}-accounts`}
        >
          {accounts.map((a) => (
            <AccountDrillDownRow
              key={a.accountId}
              account={a}
              fromDate={fromDate}
              toDate={toDate}
              parentSlug={slug}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountDrillDownRow({
  account,
  fromDate,
  toDate,
  parentSlug,
}: {
  account: { accountId: number; code: string; name: string; balance: number };
  fromDate: string;
  toDate: string;
  parentSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useGetAccountActivityReport(
    { accountId: account.accountId, from: fromDate, to: toDate },
    { query: { enabled: open } },
  );
  const errMsg = error
    ? String((error as Error)?.message ?? error)
    : null;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(n);
  return (
    <li data-testid={`bs-account-${parentSlug}-${account.accountId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 text-left hover:text-foreground"
        aria-expanded={open}
        data-testid={`bs-account-toggle-${account.accountId}`}
      >
        <span className="truncate inline-flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground tabular-nums w-3 inline-block">
            {open ? "▾" : "▸"}
          </span>
          <span className="font-mono text-muted-foreground mr-2">
            {account.code}
          </span>
          <span className="underline-offset-2 hover:underline">
            {account.name}
          </span>
        </span>
        <span className="tabular-nums font-medium">{fmt(account.balance)}</span>
      </button>
      {open && (
        <div
          className="mt-1 mb-2 ml-5 border-l pl-3"
          data-testid={`bs-account-activity-${account.accountId}`}
        >
          {isLoading && (
            <div className="py-1 text-muted-foreground">Loading activity…</div>
          )}
          {errMsg && (
            <div className="py-1 text-destructive">
              Could not load activity: {errMsg}
            </div>
          )}
          {data && data.lines.length === 0 && (
            <div className="py-1 text-muted-foreground italic">
              No posted journal-entry lines in this period.
            </div>
          )}
          {data && data.lines.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-2 font-normal">Date</th>
                  <th className="py-1 pr-2 font-normal">Entry</th>
                  <th className="py-1 pr-2 text-right font-normal">Debit</th>
                  <th className="py-1 text-right font-normal">Credit</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.lineId} className="border-b last:border-0">
                    <td className="py-1 pr-2 tabular-nums whitespace-nowrap">
                      {l.entryDate}
                    </td>
                    <td className="py-1 pr-2">
                      <Link
                        href={`/accounting/journal-entries/${l.journalEntryId}`}
                        className="text-primary hover:underline font-mono"
                      >
                        {l.entryNo}
                      </Link>
                      {(l.lineMemo ?? l.entryMemo) && (
                        <span className="text-muted-foreground ml-2">
                          {l.lineMemo ?? l.entryMemo}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {l.debit > 0 ? fmt(l.debit) : ""}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {l.credit > 0 ? fmt(l.credit) : ""}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2">
                  <td className="py-1 pr-2 font-semibold" colSpan={2}>
                    Totals
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums font-semibold">
                    {fmt(data.totals.debits)}
                  </td>
                  <td className="py-1 text-right tabular-nums font-semibold">
                    {fmt(data.totals.credits)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}
