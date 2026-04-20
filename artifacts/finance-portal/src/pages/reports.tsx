import { useMemo, useState } from "react";
import {
  useGetFinancialSummaryReport,
  useGetTrialBalanceReport,
  useGetAccountActivityReport,
  getAccountActivityReport,
  useGetReconciliationReport,
  useListAccountingPeriods,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, BarChart3, Lock, AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { PeriodDraftsBanner } from "@/components/period-drafts-banner";
import { PanelErrorBoundary } from "@/components/error-boundary";
import { isValidYmd, isValidRange, safeFormatDate } from "@/lib/safe-date";
import {
  downloadCsv,
  csvMoney,
  csvPercent,
  csvSafeDateRange,
  csvFilenameSlug,
  type CsvCell,
} from "@/lib/csv-export";

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

/**
 * Task #63 — Reconciliation card. Renders programmatic tie-out checks proving
 * Trial Balance, P&L, and Balance Sheet (ledger source) all reconcile to the
 * same posted-JE source of truth. Hidden in operational mode (the checks only
 * make sense for ledger-source reports).
 */
function ReconciliationCard({
  fromDate,
  toDate,
  rangeOk,
}: {
  fromDate: string;
  toDate: string;
  rangeOk: boolean;
}) {
  const { data, isLoading, error } = useGetReconciliationReport(
    { fromDate, toDate },
    { query: { enabled: rangeOk } },
  );
  const errMsg = error ? errorMessage(error) : null;
  const fmtDelta = (cents: number) => {
    const dollars = cents / 100;
    const sign = dollars > 0 ? "+" : dollars < 0 ? "−" : "";
    return `${sign}${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(Math.abs(dollars))}`;
  };
  return (
    <Card data-testid="reconciliation-card" className="border-l-4 border-l-blue-500">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Reconciliation</CardTitle>
            <CardDescription>
              Programmatic tie-out: every check below proves a different report
              agrees with the posted-JE source of truth.
            </CardDescription>
          </div>
          {data && (
            <div
              data-testid="reconciliation-status"
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                data.allOk
                  ? "bg-emerald-100 text-emerald-800"
                  : data.errorCount > 0
                  ? "bg-red-100 text-red-800"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {data.allOk
                ? "All checks pass"
                : `${data.errorCount} error${data.errorCount === 1 ? "" : "s"}${
                    data.warningCount > 0 ? `, ${data.warningCount} warning${data.warningCount === 1 ? "" : "s"}` : ""
                  }`}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {errMsg ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Could not load reconciliation: {errMsg}
          </div>
        ) : isLoading || !data ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            <ul className="space-y-2 text-sm">
              {data.checks.map((c) => {
                const icon = c.ok ? "✓" : c.severity === "warning" ? "⚠" : "✗";
                const colorCls = c.ok
                  ? "text-emerald-700"
                  : c.severity === "warning"
                  ? "text-amber-700"
                  : "text-red-700";
                return (
                  <li
                    key={c.id}
                    data-testid={`reconciliation-check-${c.id}`}
                    className="flex items-start justify-between gap-3 rounded border border-border/60 px-3 py-2"
                    title={
                      c.ok
                        ? "Pass"
                        : `Expected ${fmtDelta(c.expectedCents)}, got ${fmtDelta(c.actualCents)} — drift ${fmtDelta(c.deltaCents)}`
                    }
                  >
                    <span className={`flex items-baseline gap-2 ${colorCls}`}>
                      <span aria-hidden className="font-bold">
                        {icon}
                      </span>
                      <span className="text-foreground">{c.label}</span>
                    </span>
                    {!c.ok && (
                      <span className={`font-mono text-xs ${colorCls}`}>
                        Δ {fmtDelta(c.deltaCents)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <PerEntryIntegritySection
              perEntry={data.perEntry}
              fmtDelta={fmtDelta}
            />
            <IndependentNetIncomeSection
              check={data.independentNetIncomeCheck}
              fmtDelta={fmtDelta}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

const PER_ENTRY_CHECK_LABELS: Record<string, string> = {
  je_unbalanced: "Debits ≠ credits",
  je_missing_account: "Missing account mapping",
  je_zero_lines: "No lines",
  je_invalid_line_amount: "Non-positive line amount",
  je_archived_account: "Archived account referenced",
  je_non_postable_account: "Non-postable account referenced",
};

/**
 * Map a per-entry integrity check code to the closest stable failure code
 * exposed by /accounting/remediation. Used to deep-link from the
 * reconciliation row straight into the pre-filtered remediation queue.
 * Returns null when no remediation surface exists for the check (e.g.
 * je_zero_lines — operator must recreate the entry, not repoint a line).
 */
function remediationLinkForCheck(
  checkCode: string,
  entryId: number,
): string | null {
  const map: Record<string, string> = {
    je_unbalanced: "unbalanced_entry",
    je_missing_account: "missing_account",
    je_invalid_line_amount: "invalid_line_amount",
    je_archived_account: "archived_account",
    je_non_postable_account: "non_postable_account",
  };
  const code = map[checkCode];
  if (!code) return null;
  const sp = new URLSearchParams({
    code,
    entryId: String(entryId),
    status: "posted",
  });
  return `/accounting/remediation?${sp.toString()}`;
}

/**
 * Per-entry integrity subsection of the Reconciliation card. Surfaces the
 * specific posted/reversed JEs that fail any per-entry check (balanced,
 * mapped, non-empty, positive line amounts) so finance can drill straight
 * into the offending entry. Defensive: if the API response somehow lacks
 * the perEntry block, the section renders nothing rather than crashing.
 */
function PerEntryIntegritySection({
  perEntry,
  fmtDelta,
}: {
  perEntry:
    | {
        totalEntriesChecked: number;
        failingEntryCount: number;
        failingEntries: Array<{
          journalEntryId: number;
          entryNumber: string;
          entryDate: string;
          checkCode: string;
          status: string;
          deltaCents: number | null;
          shortMessage: string;
        }>;
      }
    | undefined;
  fmtDelta: (cents: number) => string;
}) {
  const VISIBLE_CAP = 25;
  const [showAll, setShowAll] = useState(false);
  if (!perEntry) return null;
  const ok = perEntry.failingEntries.length === 0;
  const visible = showAll
    ? perEntry.failingEntries
    : perEntry.failingEntries.slice(0, VISIBLE_CAP);
  const hidden = perEntry.failingEntries.length - visible.length;

  return (
    <div
      data-testid="reconciliation-per-entry"
      className="mt-6 border-t border-border/60 pt-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Per-entry integrity</h3>
          <p className="text-xs text-muted-foreground">
            Each posted/reversed JE in this window checked individually for
            balance, account mapping, line presence, and amount shape.
          </p>
        </div>
        <span
          data-testid="reconciliation-per-entry-status"
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
            ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
          }`}
        >
          {ok
            ? `All ${perEntry.totalEntriesChecked} entries pass`
            : `${perEntry.failingEntryCount} of ${perEntry.totalEntriesChecked} failing`}
        </span>
      </div>
      {ok ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          ✓ All journal entries balanced and mapped.
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Entry</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Check</th>
                  <th className="px-3 py-2 text-left font-medium">Detail</th>
                  <th className="px-3 py-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((f, i) => (
                  <tr
                    key={`${f.journalEntryId}-${f.checkCode}-${i}`}
                    data-testid={`reconciliation-per-entry-row-${f.journalEntryId}-${f.checkCode}`}
                    className="border-t border-border/60"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      <a
                        href={`/accounting/journal-entries/${f.journalEntryId}`}
                        className="text-blue-700 underline-offset-2 hover:underline"
                      >
                        {f.entryNumber}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-xs">{f.entryDate}</td>
                    <td className="px-3 py-2 text-xs">
                      <div>
                        {PER_ENTRY_CHECK_LABELS[f.checkCode] ?? f.checkCode}
                      </div>
                      {(() => {
                        const href = remediationLinkForCheck(
                          f.checkCode,
                          f.journalEntryId,
                        );
                        return href ? (
                          <Link
                            href={href}
                            className="text-[11px] text-blue-700 hover:underline"
                            data-testid={`reconciliation-per-entry-remediate-${f.journalEntryId}-${f.checkCode}`}
                          >
                            Remediate →
                          </Link>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.shortMessage}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-red-700">
                      {f.deltaCents !== null ? fmtDelta(f.deltaCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 text-xs font-medium text-blue-700 underline-offset-2 hover:underline"
              data-testid="reconciliation-per-entry-show-more"
            >
              Show {hidden} more
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Independent net-income / equity-movement validation subsection of the
 * Reconciliation card. Surfaces a structurally-independent cross-check
 * between P&L net income and equity-account movement. Returns warning when
 * the chart of accounts cannot support a true independent derivation
 * (e.g. no Retained Earnings / period-close mechanism). Defensive: renders
 * nothing if the API response somehow lacks the field.
 */
function IndependentNetIncomeSection({
  check,
  fmtDelta,
}: {
  check:
    | {
        checkCode: string;
        status: "pass" | "fail" | "warning";
        shortMessage: string;
        pnlNetIncomeCents: number;
        equityMovementNetIncomeCents: number;
        deltaCents: number;
        includedEquityAccounts: Array<{ id: number; code: string; name: string }>;
        excludedEquityAccounts: Array<{
          id: number;
          code: string;
          name: string;
          exclusionReason: string;
        }>;
        limitationNote: string | null;
      }
    | undefined;
  fmtDelta: (cents: number) => string;
}) {
  const [showAccounts, setShowAccounts] = useState(false);
  if (!check) return null;
  const badgeCls =
    check.status === "pass"
      ? "bg-emerald-100 text-emerald-800"
      : check.status === "fail"
      ? "bg-red-100 text-red-800"
      : "bg-amber-100 text-amber-800";
  const badgeLabel =
    check.status === "pass"
      ? "Pass"
      : check.status === "fail"
      ? "Fail"
      : "Warning";
  return (
    <div
      data-testid="reconciliation-independent-ni"
      className="mt-6 border-t border-border/60 pt-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            Independent net-income check
          </h3>
          <p className="text-xs text-muted-foreground">
            P&amp;L net income computed directly from revenue/expense lines,
            cross-checked against equity-account movement — without going
            through the shared ledger-summary helper.
          </p>
        </div>
        <span
          data-testid="reconciliation-independent-ni-status"
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${badgeCls}`}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-md border border-border/60 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            P&amp;L net income
          </div>
          <div
            data-testid="reconciliation-independent-ni-pnl"
            className="font-mono text-base"
          >
            {fmtDelta(check.pnlNetIncomeCents)}
          </div>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Equity movement
          </div>
          <div
            data-testid="reconciliation-independent-ni-equity"
            className="font-mono text-base"
          >
            {fmtDelta(check.equityMovementNetIncomeCents)}
          </div>
        </div>
        <div
          className={`rounded-md border px-3 py-2 ${
            check.status === "fail"
              ? "border-red-300 bg-red-50"
              : "border-border/60"
          }`}
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Delta
          </div>
          <div
            data-testid="reconciliation-independent-ni-delta"
            className={`font-mono text-base ${
              check.deltaCents !== 0 && check.status === "fail"
                ? "text-red-700"
                : ""
            }`}
          >
            {fmtDelta(check.deltaCents)}
          </div>
        </div>
      </div>
      <div
        className={`rounded-md border px-3 py-2 text-sm ${
          check.status === "pass"
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : check.status === "fail"
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        <div className="font-medium">{check.shortMessage}</div>
        {check.limitationNote && (
          <p
            data-testid="reconciliation-independent-ni-limitation"
            className="mt-1 text-xs leading-relaxed"
          >
            <span className="font-semibold">Limitation:</span>{" "}
            {check.limitationNote}
          </p>
        )}
      </div>
      {(check.includedEquityAccounts.length > 0 ||
        check.excludedEquityAccounts.length > 0) && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowAccounts((v) => !v)}
            className="text-xs font-medium text-blue-700 underline-offset-2 hover:underline"
            data-testid="reconciliation-independent-ni-accounts-toggle"
            aria-expanded={showAccounts}
          >
            {showAccounts ? "Hide" : "Show"} equity accounts (
            {check.includedEquityAccounts.length} included
            {check.excludedEquityAccounts.length > 0
              ? `, ${check.excludedEquityAccounts.length} excluded`
              : ""}
            )
          </button>
          {showAccounts && (
            <div className="mt-2 space-y-3 text-xs">
              {check.includedEquityAccounts.length > 0 && (
                <div>
                  <div className="mb-1 font-semibold text-muted-foreground">
                    Included
                  </div>
                  <ul className="space-y-1">
                    {check.includedEquityAccounts.map((a) => (
                      <li
                        key={`inc-${a.id}`}
                        className="flex gap-2 font-mono"
                        data-testid={`reconciliation-independent-ni-included-${a.id}`}
                      >
                        <span className="text-muted-foreground">{a.code}</span>
                        <span>{a.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {check.excludedEquityAccounts.length > 0 && (
                <div>
                  <div className="mb-1 font-semibold text-muted-foreground">
                    Excluded
                  </div>
                  <ul className="space-y-1">
                    {check.excludedEquityAccounts.map((a) => (
                      <li
                        key={`exc-${a.id}`}
                        className="flex gap-2 font-mono"
                        data-testid={`reconciliation-independent-ni-excluded-${a.id}`}
                      >
                        <span className="text-muted-foreground">{a.code}</span>
                        <span>{a.name}</span>
                        <span className="text-muted-foreground">
                          — {a.exclusionReason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Convert a react-query error to a user-friendly string. */
function errorMessage(err: unknown): string | null {
  if (!err) return null;
  // Heuristics for orval's HTTP error shape: { message, status, response }.
  const anyErr = err as {
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = anyErr?.status ?? anyErr?.response?.status;
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission to view this report.";
  return String(anyErr?.message ?? err);
}

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

  // Task #60 — gate every downstream computation/query on a fully valid
  // YYYY-MM-DD range. While the user is mid-edit a date input emits ""
  // or partial strings; firing report queries against those produces
  // either a 400 or — historically — a white-screen via date-fns
  // throwing on Invalid Date.
  const validRange = isValidRange(fromDate, toDate);
  const inverted =
    isValidYmd(fromDate) && isValidYmd(toDate) && fromDate > toDate;

  // Task #48 — show a banner when the report range overlaps any closed
  // accounting period so reviewers know those numbers are locked.
  const { data: periodsData } = useListAccountingPeriods();
  const closedOverlaps = useMemo(() => {
    if (!validRange) return [];
    const all = (periodsData as
      | {
          periods?: Array<{
            id: number;
            label: string;
            periodStart: string;
            periodEnd: string;
            status: "open" | "closed";
          }>;
        }
      | undefined)?.periods ?? [];
    return all.filter(
      (p) =>
        p.status === "closed" &&
        p.periodStart <= toDate &&
        p.periodEnd >= fromDate,
    );
  }, [periodsData, fromDate, toDate, validRange]);

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
  const {
    data: opData,
    isLoading: opLoading,
    error: opErrorObj,
  } = useGetFinancialSummaryReport(
    { fromDate, toDate },
    { query: { enabled: validRange } },
  );
  const {
    data: ledgerData,
    isLoading: ledgerLoading,
    error: ledgerErrorObj,
  } = useGetFinancialSummaryReport(
    { fromDate, toDate, source: "ledger" },
    { query: { enabled: validRange && source === "ledger" } },
  );
  const opError = errorMessage(opErrorObj);
  const ledgerError = errorMessage(ledgerErrorObj);
  const data = source === "ledger" ? ledgerData ?? opData : opData;
  const isLoading =
    source === "ledger"
      ? ledgerLoading && !ledgerData && !ledgerError
      : opLoading;

  const {
    data: tb,
    isLoading: tbLoading,
    error: tbErrorObj,
  } = useGetTrialBalanceReport(
    { fromDate, toDate },
    { query: { enabled: validRange } },
  );
  const tbError = errorMessage(tbErrorObj);
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
    const rows: CsvCell[][] = [
      [
        "code",
        "name",
        "type",
        "subtype",
        "normal_balance",
        "debits",
        "credits",
        "balance",
      ],
    ];
    for (const r of tb.rows) {
      rows.push([
        r.code,
        r.name,
        r.type ?? "",
        r.subtype ?? "",
        r.normalBalance ?? "",
        r.debits,
        r.credits,
        r.balance,
      ]);
    }
    rows.push([
      "TOTALS",
      "",
      "",
      "",
      "",
      tb.totals.debits,
      tb.totals.credits,
      "",
    ]);
    downloadCsv(
      `trial-balance_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadProfitAndLossCsv = () => {
    if (!data) return;
    const pl = data.profitAndLoss;
    const rows: CsvCell[][] = [
      ["section", "code", "name", "amount"],
    ];
    const incomeAccounts = source === "ledger" ? pl.incomeByAccount ?? [] : [];
    const expenseAccounts =
      source === "ledger" ? pl.expensesByAccount ?? [] : [];
    if (incomeAccounts.length > 0) {
      for (const a of incomeAccounts) {
        rows.push(["Income", a.code, a.name, csvMoney(a.amount)]);
      }
    } else {
      for (const r of pl.incomeByProgram) {
        rows.push(["Income", "", r.programName, csvMoney(r.amount)]);
      }
      if (pl.uncategorizedIncome) {
        rows.push([
          "Income",
          "",
          "Unallocated deposits",
          csvMoney(pl.uncategorizedIncome),
        ]);
      }
    }
    rows.push(["Income", "", "TOTAL INCOME", csvMoney(pl.totalIncome)]);
    if (expenseAccounts.length > 0) {
      for (const a of expenseAccounts) {
        rows.push(["Expense", a.code, a.name, csvMoney(a.amount)]);
      }
    } else {
      for (const r of pl.expensesByProgram) {
        rows.push(["Expense", "", r.programName, csvMoney(r.amount)]);
      }
      if (pl.uncategorizedExpenses) {
        rows.push([
          "Expense",
          "",
          "Unallocated",
          csvMoney(pl.uncategorizedExpenses),
        ]);
      }
    }
    rows.push(["Expense", "", "TOTAL EXPENSES", csvMoney(pl.totalExpenses)]);
    rows.push(["Net", "", "NET INCOME", csvMoney(pl.netIncome)]);
    downloadCsv(
      `profit-and-loss_${source}_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadBalanceSheetCsv = () => {
    if (!data) return;
    const bs = data.balanceSheet;
    const rows: CsvCell[][] = [
      ["section", "code", "name", "amount"],
    ];
    if (source === "ledger") {
      for (const a of bs.cashAccounts ?? []) {
        rows.push(["Assets:Cash", a.code, a.name, csvMoney(a.balance)]);
      }
      rows.push(["Assets:Cash", "", "Cash subtotal", csvMoney(bs.cash)]);
      for (const a of bs.accountsReceivableAccounts ?? []) {
        rows.push([
          "Assets:Receivable",
          a.code,
          a.name,
          csvMoney(a.balance),
        ]);
      }
      rows.push([
        "Assets:Receivable",
        "",
        "Accounts receivable subtotal",
        csvMoney(bs.accountsReceivable),
      ]);
      for (const a of bs.otherAssetAccounts ?? []) {
        rows.push(["Assets:Other", a.code, a.name, csvMoney(a.balance)]);
      }
      rows.push([
        "Assets:Other",
        "",
        "Other assets subtotal",
        csvMoney(bs.otherAssets),
      ]);
    } else {
      rows.push(["Assets", "", "Cash on hand", csvMoney(bs.cashOnHand)]);
      rows.push([
        "Assets",
        "",
        "Outstanding receivables",
        csvMoney(bs.outstandingReceivables),
      ]);
    }
    rows.push(["Assets", "", "TOTAL ASSETS", csvMoney(bs.totalAssets)]);
    if (source === "ledger") {
      for (const a of bs.accountsPayableAccounts ?? []) {
        rows.push([
          "Liabilities:Payable",
          a.code,
          a.name,
          csvMoney(a.balance),
        ]);
      }
      rows.push([
        "Liabilities:Payable",
        "",
        "Accounts payable subtotal",
        csvMoney(bs.accountsPayable),
      ]);
      for (const a of bs.otherLiabilityAccounts ?? []) {
        rows.push([
          "Liabilities:Other",
          a.code,
          a.name,
          csvMoney(a.balance),
        ]);
      }
      rows.push([
        "Liabilities:Other",
        "",
        "Other liabilities subtotal",
        csvMoney(bs.otherLiabilities),
      ]);
    } else {
      rows.push(["Liabilities", "", "Unpaid bills", csvMoney(bs.unpaidBills)]);
      rows.push([
        "Liabilities",
        "",
        "Unreimbursed expenses",
        csvMoney(bs.unreimbursedExpenses),
      ]);
    }
    rows.push([
      "Liabilities",
      "",
      "TOTAL LIABILITIES",
      csvMoney(bs.totalLiabilities),
    ]);
    rows.push([
      "Equity",
      "",
      "Opening net assets",
      csvMoney(bs.openingNetAssets),
    ]);
    rows.push([
      "Equity",
      "",
      "Current period net income",
      csvMoney(bs.currentPeriodNetIncome),
    ]);
    rows.push([
      "Equity",
      "",
      "TOTAL EQUITY (Assets − Liabilities)",
      csvMoney(bs.equity),
    ]);
    downloadCsv(
      `balance-sheet_${source}_as-of_${toDate}.csv`,
      rows,
    );
  };

  // Task #73 — bulk per-account drill-down CSV. Reviewers wanted one file with
  // every account's posted JE activity instead of expanding rows one at a time.
  // Only meaningful in `source === "ledger"` (operational mode has no account
  // breakdowns to drill into). Each account becomes a section in the CSV with
  // the same columns as the per-account export, preceded by an ACCOUNT header
  // row identifying the code/name/group.
  const [bulkDownloading, setBulkDownloading] = useState<
    null | "pl" | "balance" | "trial-balance"
  >(null);
  const ACTIVITY_HEADER: CsvCell[] = [
    "entry_date",
    "entry_no",
    "entry_memo",
    "line_memo",
    "program",
    "fund",
    "debit",
    "credit",
  ];
  type BulkAccount = {
    accountId: number;
    code: string;
    name: string;
    group: string;
  };
  const fetchAndAppendActivity = async (
    rows: CsvCell[][],
    accounts: BulkAccount[],
    params: { from?: string; to: string },
  ) => {
    // Sequential to keep ordering stable and avoid hammering the API; chart of
    // accounts is small (tens of accounts), so latency is acceptable.
    for (const acct of accounts) {
      rows.push([
        "ACCOUNT",
        acct.code,
        acct.name,
        `group=${acct.group}`,
      ]);
      rows.push(ACTIVITY_HEADER);
      let activity;
      try {
        activity = await getAccountActivityReport({
          accountId: acct.accountId,
          ...(params.from ? { from: params.from } : {}),
          to: params.to,
        });
      } catch (e) {
        rows.push(["ERROR", "", "", String((e as Error)?.message ?? e)]);
        rows.push([]);
        continue;
      }
      for (const l of activity.lines) {
        rows.push([
          l.entryDate,
          l.entryNo,
          l.entryMemo ?? "",
          l.lineMemo ?? "",
          l.program ?? "",
          l.fund ?? "",
          csvMoney(l.debit),
          csvMoney(l.credit),
        ]);
      }
      rows.push([
        "TOTALS",
        "",
        "",
        "",
        "",
        "",
        csvMoney(activity.totals.debits),
        csvMoney(activity.totals.credits),
      ]);
      rows.push([]);
    }
  };
  const collectPlAccounts = (): BulkAccount[] => {
    if (!data) return [];
    const pl = data.profitAndLoss;
    const out: BulkAccount[] = [];
    for (const a of pl.incomeByAccount ?? []) {
      out.push({ accountId: a.accountId, code: a.code, name: a.name, group: "Income" });
    }
    for (const a of pl.expensesByAccount ?? []) {
      out.push({ accountId: a.accountId, code: a.code, name: a.name, group: "Expense" });
    }
    return out;
  };
  const collectBsAccounts = (): BulkAccount[] => {
    if (!data) return [];
    const bs = data.balanceSheet;
    const out: BulkAccount[] = [];
    const push = (
      group: string,
      list:
        | Array<{ accountId: number; code: string; name: string }>
        | undefined,
    ) => {
      for (const a of list ?? []) {
        out.push({ accountId: a.accountId, code: a.code, name: a.name, group });
      }
    };
    push("Assets:Cash", bs.cashAccounts);
    push("Assets:Receivable", bs.accountsReceivableAccounts);
    push("Assets:Other", bs.otherAssetAccounts);
    push("Liabilities:Payable", bs.accountsPayableAccounts);
    push("Liabilities:Other", bs.otherLiabilityAccounts);
    return out;
  };
  const downloadAllPlActivityCsv = async () => {
    if (!data || bulkDownloading) return;
    const accounts = collectPlAccounts();
    if (accounts.length === 0) return;
    setBulkDownloading("pl");
    try {
      const rows: CsvCell[][] = [
        ["report", "Profit & Loss — all account activity"],
        ["range", csvSafeDateRange(fromDate, toDate)],
        ["generated", new Date().toISOString()],
        [],
      ];
      await fetchAndAppendActivity(rows, accounts, {
        from: fromDate,
        to: toDate,
      });
      downloadCsv(
        `profit-and-loss_all-activity_${csvSafeDateRange(fromDate, toDate)}.csv`,
        rows,
      );
    } finally {
      setBulkDownloading(null);
    }
  };
  const collectTrialBalanceAccounts = (): {
    mapped: BulkAccount[];
    unmapped: { code: string; name: string; debits: string; credits: string }[];
  } => {
    if (!tb) return { mapped: [], unmapped: [] };
    const mapped: BulkAccount[] = [];
    const unmapped: {
      code: string;
      name: string;
      debits: string;
      credits: string;
    }[] = [];
    for (const r of tb.rows) {
      if (r.accountId == null) {
        // Lines whose ledger account doesn't map to a current Chart-of-Accounts
        // row (legacy "(unmapped)" bucket on the Trial Balance). The
        // /reports/account-activity endpoint requires a numeric accountId so
        // we can't fetch their per-line activity, but we still surface them
        // as a section in the bulk CSV with the TB-level totals so the
        // workbook represents every row visible in the Trial Balance.
        unmapped.push({
          code: r.code,
          name: r.name,
          debits: r.debits,
          credits: r.credits,
        });
      } else {
        mapped.push({
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          group: r.type ?? "Unclassified",
        });
      }
    }
    return { mapped, unmapped };
  };
  const downloadAllTrialBalanceActivityCsv = async () => {
    if (!tb || bulkDownloading) return;
    const { mapped, unmapped } = collectTrialBalanceAccounts();
    if (mapped.length === 0 && unmapped.length === 0) return;
    setBulkDownloading("trial-balance");
    try {
      const rows: CsvCell[][] = [
        ["report", "Trial Balance — all account activity"],
        ["range", csvSafeDateRange(fromDate, toDate)],
        ["generated", new Date().toISOString()],
        [],
      ];
      await fetchAndAppendActivity(rows, mapped, {
        from: fromDate,
        to: toDate,
      });
      // Append unmapped rows as sections with TB-level totals so the workbook
      // covers every row in the Trial Balance, with a marker explaining why
      // no per-line activity is listed.
      for (const u of unmapped) {
        rows.push(["ACCOUNT", u.code, u.name, "group=unmapped"]);
        rows.push(ACTIVITY_HEADER);
        rows.push([
          "NOTE",
          "",
          "",
          "Per-line activity unavailable: ledger account is not linked to a Chart of Accounts row.",
          "",
          "",
          "",
          "",
        ]);
        rows.push([
          "TOTALS (from Trial Balance)",
          "",
          "",
          "",
          "",
          "",
          u.debits,
          u.credits,
        ]);
        rows.push([]);
      }
      downloadCsv(
        `trial-balance_all-activity_${csvSafeDateRange(fromDate, toDate)}.csv`,
        rows,
      );
    } finally {
      setBulkDownloading(null);
    }
  };
  const downloadAllBsActivityCsv = async () => {
    if (!data || bulkDownloading) return;
    const accounts = collectBsAccounts();
    if (accounts.length === 0) return;
    setBulkDownloading("balance");
    try {
      const rows: CsvCell[][] = [
        ["report", "Balance Sheet — all account activity"],
        ["as_of", toDate],
        ["generated", new Date().toISOString()],
        [],
      ];
      // Balance sheet drilldowns are cumulative-through-toDate (no `from`),
      // matching the per-row drilldown behavior in AccountDrillDownRow so the
      // listed lines net to the displayed balance.
      await fetchAndAppendActivity(rows, accounts, { to: toDate });
      downloadCsv(
        `balance-sheet_all-activity_as-of_${toDate}.csv`,
        rows,
      );
    } finally {
      setBulkDownloading(null);
    }
  };

  const downloadStatusCsv = (
    kind: "expenses" | "bills",
    rowsIn: { status: string; count: number; amount: number }[],
  ) => {
    const rows: CsvCell[][] = [["status", "count", "amount"]];
    for (const r of rowsIn) {
      rows.push([titleCase(r.status), r.count, csvMoney(r.amount)]);
    }
    downloadCsv(
      `${kind}-by-status_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadSpendByProgramCsv = () => {
    if (!data) return;
    const rows: CsvCell[][] = [
      ["program", "expenses", "bills", "total", "budget", "percent_used"],
    ];
    for (const r of data.spendByProgram) {
      rows.push([
        r.programName,
        csvMoney(r.expenseAmount),
        csvMoney(r.billAmount),
        csvMoney(r.totalAmount),
        r.budgetAmount ? csvMoney(r.budgetAmount) : "",
        csvPercent(r.percentUsed),
      ]);
    }
    downloadCsv(
      `spend-by-program_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadMissingReceiptsCsv = () => {
    if (!data) return;
    const rows: CsvCell[][] = [
      [
        "expense_id",
        "merchant",
        "submitted_by",
        "expense_date",
        "days_open",
        "amount",
      ],
    ];
    for (const r of data.missingReceipts) {
      rows.push([
        r.expenseId,
        r.merchant,
        r.submittedBy,
        r.expenseDate,
        r.daysSinceSubmission,
        csvMoney(r.amount),
      ]);
    }
    downloadCsv(
      `missing-receipts_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadTopVendorsCsv = () => {
    if (!data) return;
    const rows: CsvCell[][] = [
      ["vendor", "bills", "expenses", "total"],
    ];
    for (const v of data.topVendors) {
      rows.push([
        v.vendorName,
        csvMoney(v.billAmount),
        csvMoney(v.expenseAmount),
        csvMoney(v.totalAmount),
      ]);
    }
    downloadCsv(
      `top-vendors_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };

  const downloadBankReconciliationCsv = () => {
    if (!data) return;
    const b = data.bankReconciliation;
    const rows: CsvCell[][] = [
      ["metric", "value"],
      ["Total transactions", b.totalTransactions],
      ["Reconciled", b.reconciled],
      ["Matched", b.matched],
      ["Unmatched", b.unmatched],
      ["Total credits (in)", csvMoney(b.totalCredits)],
      ["Total debits (out)", csvMoney(b.totalDebits)],
      ["Net cash flow", csvMoney(b.netCashFlow)],
    ];
    downloadCsv(
      `bank-reconciliation_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
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
          {closedOverlaps.length > 0 && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
              data-testid="banner-closed-period-overlap"
            >
              <Lock className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
              <div>
                <div className="font-medium">
                  This range overlaps closed periods
                </div>
                <div className="text-muted-foreground">
                  Numbers in{" "}
                  {closedOverlaps
                    .map((p) => p.label)
                    .join(", ")}{" "}
                  are locked. Corrections must be made via reversing entries
                  in an open period.
                </div>
              </div>
            </div>
          )}
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
          Period: {safeFormatDate(fromDate, "MMM d, yyyy")} —{" "}
          {safeFormatDate(toDate, "MMM d, yyyy")}
        </p>
        {data?.generatedAt && (
          <p className="text-xs text-muted-foreground">
            Generated {safeFormatDate(data.generatedAt, "PPpp")}
          </p>
        )}
      </div>

      {!validRange && (
        <div
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          data-testid="banner-invalid-range"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
          <div>
            <div className="font-medium">
              Enter a valid date range to view reports
            </div>
            <div className="text-muted-foreground">
              {inverted
                ? "The “From” date must be on or before the “To” date."
                : "Use the date pickers above to select a complete From and To date."}
            </div>
          </div>
        </div>
      )}

      {source === "ledger" && ledgerError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Could not load General Ledger data: {ledgerError}. Falling back to operational figures.
        </div>
      )}
      {validRange && !data && opError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="banner-summary-error"
        >
          Could not load financial summary: {opError}
        </div>
      )}
      {!validRange ? null : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : !data ? null : (
        <>
          {source === "ledger" && validRange && (
            <PanelErrorBoundary label="Reconciliation">
              <ReconciliationCard
                fromDate={fromDate}
                toDate={toDate}
                rangeOk={validRange}
              />
            </PanelErrorBoundary>
          )}

          {selected.summary && (
          <PanelErrorBoundary label="Summary">
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
          </PanelErrorBoundary>
          )}

          {selected.pl && (
          <PanelErrorBoundary label="Profit & Loss">
          <Card className="print-page-break">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">
                    Profit &amp; Loss Statement
                  </CardTitle>
                  <CardDescription>
                    Cash-basis income vs. committed spend for the selected period.
                    {source === "ledger"
                      ? " Click a row to see the posted journal entries behind it."
                      : " Switch to the Ledger source above to drill into the posted journal entries behind each row."}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {source === "ledger" &&
                    ((data?.profitAndLoss.incomeByAccount?.length ?? 0) +
                      (data?.profitAndLoss.expensesByAccount?.length ?? 0) >
                      0) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={downloadAllPlActivityCsv}
                        disabled={bulkDownloading !== null}
                        className="no-print"
                        data-testid="export-csv-pl-all-activity"
                      >
                        {bulkDownloading === "pl"
                          ? "Preparing…"
                          : "Download all activity (CSV)"}
                      </Button>
                    )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={downloadProfitAndLossCsv}
                    className="no-print"
                    data-testid="export-csv-pl"
                  >
                    Export CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <PLSection
                  title="Income"
                  titleClassName="text-success"
                  totalLabel="Total income"
                  totalClassName="text-success"
                  totalBorderClassName="border-success/30"
                  emptyText="No income recorded in this period."
                  programRows={data.profitAndLoss.incomeByProgram}
                  uncategorized={data.profitAndLoss.uncategorizedIncome}
                  uncategorizedLabel="Unallocated deposits"
                  total={data.profitAndLoss.totalIncome}
                  accounts={
                    source === "ledger"
                      ? data.profitAndLoss.incomeByAccount ?? []
                      : []
                  }
                  fromDate={fromDate}
                  toDate={toDate}
                  parentSlug="pl-income"
                />

                <PLSection
                  title="Expenses"
                  totalLabel="Total expenses"
                  totalBorderClassName="border-foreground/20"
                  emptyText="No expenses recorded in this period."
                  programRows={data.profitAndLoss.expensesByProgram}
                  uncategorized={data.profitAndLoss.uncategorizedExpenses}
                  uncategorizedLabel="Unallocated"
                  total={data.profitAndLoss.totalExpenses}
                  accounts={
                    source === "ledger"
                      ? data.profitAndLoss.expensesByAccount ?? []
                      : []
                  }
                  fromDate={fromDate}
                  toDate={toDate}
                  parentSlug="pl-expense"
                />

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
          </PanelErrorBoundary>
          )}

          {selected.balance && (
          <PanelErrorBoundary label="Balance Sheet">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Balance Sheet</CardTitle>
                  <CardDescription>
                    Snapshot as of {safeFormatDate(toDate, "MMM d, yyyy")}.
                    {source === "ledger" &&
                      " Click a row to see the underlying accounts."}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {source === "ledger" &&
                    ((data?.balanceSheet.cashAccounts?.length ?? 0) +
                      (data?.balanceSheet.accountsReceivableAccounts?.length ??
                        0) +
                      (data?.balanceSheet.otherAssetAccounts?.length ?? 0) +
                      (data?.balanceSheet.accountsPayableAccounts?.length ??
                        0) +
                      (data?.balanceSheet.otherLiabilityAccounts?.length ??
                        0) >
                      0) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={downloadAllBsActivityCsv}
                        disabled={bulkDownloading !== null}
                        className="no-print"
                        data-testid="export-csv-bs-all-activity"
                      >
                        {bulkDownloading === "balance"
                          ? "Preparing…"
                          : "Download all activity (CSV)"}
                      </Button>
                    )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={downloadBalanceSheetCsv}
                    className="no-print"
                    data-testid="export-csv-balance-sheet"
                  >
                    Export CSV
                  </Button>
                </div>
              </div>
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
          </PanelErrorBoundary>
          )}

          {selected.trialBalance && <div className="print-page-break" />}

          {selected.trialBalance && (
            <div className="no-print">
              <PeriodDraftsBanner
                fromDate={fromDate}
                toDate={toDate}
                periodLabel={`${safeFormatDate(fromDate, "MMM d, yyyy")} – ${safeFormatDate(toDate, "MMM d, yyyy")}`}
              />
            </div>
          )}

          {selected.trialBalance && (
            <PanelErrorBoundary label="Trial Balance">
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
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={downloadAllTrialBalanceActivityCsv}
                      disabled={
                        !tb ||
                        tbLoading ||
                        tb.rows.length === 0 ||
                        bulkDownloading !== null
                      }
                      className="no-print"
                      data-testid="export-csv-tb-all-activity"
                      title={
                        !tb || tbLoading
                          ? "Loading Trial Balance…"
                          : tb.rows.length === 0
                            ? "No Trial Balance activity to export"
                            : undefined
                      }
                    >
                      {bulkDownloading === "trial-balance"
                        ? "Preparing…"
                        : "Download all activity (CSV)"}
                    </Button>
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
                </div>
              </CardHeader>
              <CardContent>
                {tbError && (
                  <div className="text-sm text-destructive mb-3">
                    Could not load trial balance: {tbError}
                  </div>
                )}
                {tbLoading ? (
                  <Skeleton className="h-32" />
                ) : !tb ? null : (
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
            </PanelErrorBoundary>
          )}

          {selected.byStatus && <div className="print-page-break" />}

          {selected.byStatus && (
          <PanelErrorBoundary label="Expenses & Bills by Status">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" /> Expense Claims by Status
                  </CardTitle>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadStatusCsv("expenses", data.expenseTotalsByStatus)
                    }
                    className="no-print"
                    data-testid="export-csv-expenses-by-status"
                  >
                    Export CSV
                  </Button>
                </div>
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
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" /> Vendor Bills by Status
                  </CardTitle>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadStatusCsv("bills", data.billTotalsByStatus)
                    }
                    className="no-print"
                    data-testid="export-csv-bills-by-status"
                  >
                    Export CSV
                  </Button>
                </div>
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
          </PanelErrorBoundary>
          )}

          {selected.spendByProgram && (
          <PanelErrorBoundary label="Spend by Program">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Spend by Program / Grant</CardTitle>
                  <CardDescription>
                    Combined expense + bill spend, with budget utilisation when defined.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={downloadSpendByProgramCsv}
                  className="no-print"
                  data-testid="export-csv-spend-by-program"
                >
                  Export CSV
                </Button>
              </div>
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
          </PanelErrorBoundary>
          )}

          {selected.missingReceipts && (
          <PanelErrorBoundary label="Missing Receipts">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
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
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={downloadMissingReceiptsCsv}
                  disabled={data.missingReceipts.length === 0}
                  className="no-print"
                  data-testid="export-csv-missing-receipts"
                >
                  Export CSV
                </Button>
              </div>
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
          </PanelErrorBoundary>
          )}

          {(selected.topVendors || selected.bank) && (
          <PanelErrorBoundary label="Top Vendors & Bank Reconciliation">
          <div className="grid gap-6 md:grid-cols-2">
            {selected.topVendors && (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">Top Vendors</CardTitle>
                    <CardDescription>By total spend in this period.</CardDescription>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={downloadTopVendorsCsv}
                    disabled={data.topVendors.length === 0}
                    className="no-print"
                    data-testid="export-csv-top-vendors"
                  >
                    Export CSV
                  </Button>
                </div>
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
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="text-base">Bank Reconciliation</CardTitle>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={downloadBankReconciliationCsv}
                    className="no-print"
                    data-testid="export-csv-bank-reconciliation"
                  >
                    Export CSV
                  </Button>
                </div>
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
          </PanelErrorBoundary>
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

// Task #61 — P&L section with optional per-account drilldown.
// In ledger source, `accounts` is populated and rows expand inline to show
// the posted journal-entry lines that built the row. In operational source,
// `accounts` is empty and we fall back to the legacy program rows
// (operational P&L is sourced from expenses/bills/transactions, which have
// no posted JE backing — drilldown would be a lie).
function PLSection({
  title,
  titleClassName,
  totalLabel,
  totalClassName,
  totalBorderClassName,
  emptyText,
  programRows,
  uncategorized,
  uncategorizedLabel,
  total,
  accounts,
  fromDate,
  toDate,
  parentSlug,
}: {
  title: string;
  titleClassName?: string;
  totalLabel: string;
  totalClassName?: string;
  totalBorderClassName: string;
  emptyText: string;
  programRows: { programName: string; amount: number }[];
  uncategorized: number;
  uncategorizedLabel: string;
  total: number;
  accounts: { accountId: number; code: string; name: string; amount: number }[];
  fromDate: string;
  toDate: string;
  parentSlug: string;
}) {
  const useAccountRows = accounts.length > 0;
  const accountSum = accounts.reduce((s, a) => s + a.amount, 0);
  const reconcileMismatch =
    useAccountRows && Math.abs(accountSum - total) > 0.005;
  return (
    <div data-testid={`pl-section-${parentSlug}`}>
      <div className={`font-semibold mb-2 ${titleClassName ?? ""}`}>{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {useAccountRows ? (
            accounts.map((a) => (
              <PLAccountDrillDownRow
                key={a.accountId}
                account={a}
                fromDate={fromDate}
                toDate={toDate}
                parentSlug={parentSlug}
              />
            ))
          ) : (
            <>
              {programRows.length === 0 && uncategorized === 0 && (
                <tr>
                  <td className="py-2 text-muted-foreground" colSpan={2}>
                    {emptyText}
                  </td>
                </tr>
              )}
              {programRows.map((row) => (
                <tr key={row.programName} className="border-b last:border-0">
                  <td className="py-2">{row.programName}</td>
                  <td className="py-2 text-right font-medium">
                    {fmtMoney(row.amount)}
                  </td>
                </tr>
              ))}
              {uncategorized > 0 && (
                <tr className="border-b last:border-0">
                  <td className="py-2 italic text-muted-foreground">
                    {uncategorizedLabel}
                  </td>
                  <td className="py-2 text-right font-medium">
                    {fmtMoney(uncategorized)}
                  </td>
                </tr>
              )}
            </>
          )}
          <tr className={`border-t-2 ${totalBorderClassName}`}>
            <td className="py-2 font-bold">{totalLabel}</td>
            <td
              className={`py-2 text-right font-bold ${totalClassName ?? ""}`}
            >
              {fmtMoney(total)}
            </td>
          </tr>
        </tbody>
      </table>
      {reconcileMismatch && (
        <div
          className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
          data-testid={`pl-reconcile-mismatch-${parentSlug}`}
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-warning shrink-0" />
          <div>
            Per-account total ({fmtMoney(accountSum)}) does not match the
            displayed {totalLabel.toLowerCase()} ({fmtMoney(total)}). The
            drill-down view may be incomplete.
          </div>
        </div>
      )}
    </div>
  );
}

function PLAccountDrillDownRow({
  account,
  fromDate,
  toDate,
  parentSlug,
}: {
  account: { accountId: number; code: string; name: string; amount: number };
  fromDate: string;
  toDate: string;
  parentSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const rangeOk = isValidRange(fromDate, toDate);
  const { data, isLoading, error } = useGetAccountActivityReport(
    { accountId: account.accountId, from: fromDate, to: toDate },
    { query: { enabled: open && rangeOk } },
  );
  const errMsg = error ? errorMessage(error) : null;
  const downloadActivityCsv = () => {
    if (!data) return;
    const rows: CsvCell[][] = [
      [
        "entry_date",
        "entry_no",
        "entry_memo",
        "line_memo",
        "program",
        "fund",
        "debit",
        "credit",
      ],
    ];
    for (const l of data.lines) {
      rows.push([
        l.entryDate,
        l.entryNo,
        l.entryMemo ?? "",
        l.lineMemo ?? "",
        l.program ?? "",
        l.fund ?? "",
        csvMoney(l.debit),
        csvMoney(l.credit),
      ]);
    }
    rows.push([
      "TOTALS",
      "",
      "",
      "",
      "",
      "",
      csvMoney(data.totals.debits),
      csvMoney(data.totals.credits),
    ]);
    downloadCsv(
      `account-${account.code}-${csvFilenameSlug(account.name)}_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };
  return (
    <>
      <tr
        className="border-b last:border-0"
        data-testid={`pl-row-${parentSlug}-${account.accountId}`}
      >
        <td className="py-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center gap-2 text-left hover:text-foreground"
            aria-expanded={open}
            data-testid={`pl-row-toggle-${parentSlug}-${account.accountId}`}
          >
            <span className="text-xs text-muted-foreground tabular-nums w-3 inline-block">
              {open ? "▾" : "▸"}
            </span>
            <span className="font-mono text-muted-foreground mr-2">
              {account.code}
            </span>
            <span className="underline-offset-2 hover:underline">
              {account.name}
            </span>
          </button>
        </td>
        <td className="py-2 text-right font-medium tabular-nums">
          {fmtMoney(account.amount)}
        </td>
      </tr>
      {open && (
        <tr
          className="border-b last:border-0"
          data-testid={`pl-row-activity-${parentSlug}-${account.accountId}`}
        >
          <td colSpan={2} className="bg-muted/20 px-3 py-2">
            {isLoading && (
              <div className="py-1 text-xs text-muted-foreground">
                Loading journal-entry activity…
              </div>
            )}
            {errMsg && (
              <div className="py-1 text-xs text-destructive">
                Could not load activity: {errMsg}
              </div>
            )}
            {data && data.lines.length === 0 && (
              <div className="py-1 text-xs text-muted-foreground italic">
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
                        {l.debit > 0 ? fmtMoney(l.debit) : ""}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {l.credit > 0 ? fmtMoney(l.credit) : ""}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2">
                    <td className="py-1 pr-2 font-semibold" colSpan={2}>
                      <div className="flex items-center gap-2">
                        <span>Totals</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={downloadActivityCsv}
                          className="h-6 px-2 text-xs no-print"
                          data-testid={`export-csv-pl-activity-${account.accountId}`}
                        >
                          Download CSV
                        </Button>
                      </div>
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums font-semibold">
                      {fmtMoney(data.totals.debits)}
                    </td>
                    <td className="py-1 text-right tabular-nums font-semibold">
                      {fmtMoney(data.totals.credits)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
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
  const rangeOk = isValidRange(fromDate, toDate);
  // Tie-out: Balance Sheet row balances are cumulative-through-toDate, so the
  // drilldown must request the full history (no `from`) for the listed lines'
  // net to equal the displayed balance. P&L drilldowns are period-only and
  // pass both bounds.
  const { data, isLoading, error } = useGetAccountActivityReport(
    { accountId: account.accountId, to: toDate },
    { query: { enabled: open && rangeOk } },
  );
  const errMsg = error ? errorMessage(error) : null;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(n);
  const downloadActivityCsv = () => {
    if (!data) return;
    const rows: CsvCell[][] = [
      [
        "entry_date",
        "entry_no",
        "entry_memo",
        "line_memo",
        "program",
        "fund",
        "debit",
        "credit",
      ],
    ];
    for (const l of data.lines) {
      rows.push([
        l.entryDate,
        l.entryNo,
        l.entryMemo ?? "",
        l.lineMemo ?? "",
        l.program ?? "",
        l.fund ?? "",
        csvMoney(l.debit),
        csvMoney(l.credit),
      ]);
    }
    rows.push([
      "TOTALS",
      "",
      "",
      "",
      "",
      "",
      csvMoney(data.totals.debits),
      csvMoney(data.totals.credits),
    ]);
    downloadCsv(
      `account-${account.code}-${csvFilenameSlug(account.name)}_${csvSafeDateRange(fromDate, toDate)}.csv`,
      rows,
    );
  };
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
                    <div className="flex items-center gap-2">
                      <span>Totals</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={downloadActivityCsv}
                        className="h-6 px-2 text-xs no-print"
                        data-testid={`export-csv-bs-activity-${account.accountId}`}
                      >
                        Download CSV
                      </Button>
                    </div>
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
