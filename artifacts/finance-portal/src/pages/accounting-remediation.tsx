/**
 * Accounting → Remediation queue.
 *
 * Operator-facing surface for every line-level integrity failure detected
 * by the reconciliation report. Two surfaces, one page:
 *
 *   - Draft rows are mutable in place. Click "Fix account" to repoint
 *     a single line to a valid chart-of-accounts entry; the action is
 *     audited server-side.
 *
 *   - Posted rows are locked (DB triggers from Task #67 also enforce this).
 *     Operators must use a corrective action (reverse + replace, or
 *     adjusting entry) — wired into the "Corrective action" button when
 *     that endpoint ships.
 *
 * Filters are URL-state-driven so deep links from the reconciliation
 * report (`/accounting/remediation?code=missing_account&entryId=123`)
 * land the operator on a pre-filtered queue.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRemediationQueue,
  useGetRemediationCounts,
  useRemediateDraftLineAccount,
  useRemediatePostedJournalEntry,
  useListChartOfAccounts,
  useGetJournalEntry,
  useGetExpense,
  useGetBill,
  getListRemediationQueueQueryKey,
  getGetRemediationCountsQueryKey,
  getGetReconciliationReportQueryKey,
  getGetReconciliationSummaryQueryKey,
  getListJournalEntriesQueryKey,
  getGetJournalEntryQueryKey,
  type RemediatePostedEntryRequest,
  type RemediationRow as RemediationQueueRow,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ChevronDown, Lock } from "lucide-react";

type FailureCode =
  | "missing_account"
  | "archived_account"
  | "non_postable_account"
  | "invalid_line_amount"
  | "unbalanced_entry";

const ALL_CODES: { value: FailureCode; label: string }[] = [
  { value: "missing_account", label: "Missing account" },
  { value: "archived_account", label: "Archived account" },
  { value: "non_postable_account", label: "Non-postable account" },
  { value: "invalid_line_amount", label: "Invalid amount" },
  { value: "unbalanced_entry", label: "Unbalanced entry" },
];

function fmtCents(c: number): string {
  return (c / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Read filter state from the current URL query string. Wouter strips the
 * search string from `useLocation`, so we read it directly off
 * `window.location` and stay reactive via a small effect that listens to
 * popstate + a manual setter.
 */
function useUrlFilters() {
  const [, navigate] = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onPop = () => setTick((t) => t + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const params = useMemo(() => {
    return new URLSearchParams(window.location.search);
    // tick re-runs the memo on popstate / setFilters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  function setFilters(next: Record<string, string | undefined>) {
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    const path = window.location.pathname;
    const base = path.replace(import.meta.env.BASE_URL.replace(/\/$/, ""), "");
    navigate(qs ? `${base}?${qs}` : base, { replace: false });
    setTick((t) => t + 1);
  }
  return {
    code: (params.get("code") as FailureCode | null) ?? undefined,
    entryId: params.get("entryId") ?? undefined,
    sourceType:
      (params.get("sourceType") as "expense" | "bill" | null) ?? undefined,
    status: (params.get("status") as "draft" | "posted" | null) ?? undefined,
    setFilters,
  };
}

function StatusBadge({ code }: { code: FailureCode }) {
  const tone =
    code === "unbalanced_entry" || code === "invalid_line_amount"
      ? "bg-red-100 text-red-800"
      : "bg-amber-100 text-amber-800";
  const label =
    ALL_CODES.find((c) => c.value === code)?.label ?? code;
  return (
    <span
      data-testid={`remediation-code-${code}`}
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}

export default function AccountingRemediationPage() {
  const filters = useUrlFilters();
  const { code, entryId, sourceType, status, setFilters } = filters;

  const queueParams = {
    ...(code ? { code } : {}),
    ...(entryId ? { entryId: Number(entryId) } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(status ? { status } : {}),
    limit: 200,
  };
  const queue = useListRemediationQueue(queueParams, {
    query: { refetchInterval: 60_000 },
  });
  const counts = useGetRemediationCounts({
    query: { refetchInterval: 60_000 },
  });
  const coa = useListChartOfAccounts(undefined, {
    query: { staleTime: 5 * 60_000 },
  });

  const postableAccounts = useMemo(() => {
    const accounts =
      (coa.data as { accounts?: Array<Record<string, unknown>> } | undefined)
        ?.accounts ?? [];
    return accounts.filter(
      (a) => a.isActive === true && a.allowManualPosting === true,
    ) as Array<{ id: number; code: string; name: string; type: string }>;
  }, [coa.data]);

  const queryClient = useQueryClient();
  const [fixTarget, setFixTarget] = useState<{
    draftId: number;
    lineId: number;
    rowId: string;
  } | null>(null);
  const [postedTarget, setPostedTarget] = useState<{
    row: RemediationQueueRow;
    action: "reverse_and_replace" | "adjusting_entry";
  } | null>(null);

  /**
   * Refresh every surface that can show stale data after a successful
   * remediation: the queue and counts (this page), the reconciliation
   * report (where users may have deep-linked from), and the journal
   * entries list + the affected entry detail (to reflect a fresh
   * reversal/replacement). Missing any one of these has burned us
   * before — the row keeps showing as "broken" until manual refresh.
   */
  const invalidateAfterRemediation = (entryId?: number) => {
    queryClient.invalidateQueries({
      queryKey: getListRemediationQueueQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetRemediationCountsQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetReconciliationReportQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetReconciliationSummaryQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getListJournalEntriesQueryKey(),
    });
    if (entryId) {
      queryClient.invalidateQueries({
        queryKey: getGetJournalEntryQueryKey(entryId),
      });
    }
  };

  const total = queue.data?.total ?? 0;
  const rows = queue.data?.rows ?? [];

  return (
    <div className="space-y-6 p-6" data-testid="page-accounting-remediation">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Accounting remediation
        </h1>
        <p className="text-sm text-muted-foreground">
          Every line-level integrity failure surfaced by reconciliation,
          ready for an operator to act on. Draft lines can be repointed in
          place; posted entries require a corrective action.
        </p>
      </div>

      {/* Counts strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CountCard
          label="Total"
          value={counts.data?.total ?? 0}
          active={!code}
          onClick={() => setFilters({ code: undefined })}
          testId="remediation-count-total"
        />
        {ALL_CODES.map((c) => (
          <CountCard
            key={c.value}
            label={c.label}
            value={counts.data?.byCode[c.value] ?? 0}
            active={code === c.value}
            onClick={() =>
              setFilters({ code: code === c.value ? undefined : c.value })
            }
            testId={`remediation-count-${c.value}`}
          />
        ))}
      </div>

      {/* Filter row */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="filter-status" className="text-xs">
                Status
              </Label>
              <Select
                value={status ?? "all"}
                onValueChange={(v) =>
                  setFilters({ status: v === "all" ? undefined : v })
                }
              >
                <SelectTrigger
                  id="filter-status"
                  className="w-[140px]"
                  data-testid="remediation-filter-status"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="posted">Posted</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="filter-source" className="text-xs">
                Source
              </Label>
              <Select
                value={sourceType ?? "all"}
                onValueChange={(v) =>
                  setFilters({ sourceType: v === "all" ? undefined : v })
                }
              >
                <SelectTrigger
                  id="filter-source"
                  className="w-[140px]"
                  data-testid="remediation-filter-source"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="expense">Expense</SelectItem>
                  <SelectItem value="bill">Bill</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="filter-entry" className="text-xs">
                Entry id
              </Label>
              <Input
                id="filter-entry"
                type="number"
                value={entryId ?? ""}
                onChange={(e) =>
                  setFilters({
                    entryId: e.target.value || undefined,
                  })
                }
                placeholder="e.g. 57"
                className="w-[140px]"
                data-testid="remediation-filter-entry"
              />
            </div>
            {(code || entryId || sourceType || status) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setFilters({
                    code: undefined,
                    entryId: undefined,
                    sourceType: undefined,
                    status: undefined,
                  })
                }
                data-testid="remediation-filters-clear"
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Queue table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Queue ({total.toLocaleString()})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {queue.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : queue.isError ? (
            <p className="text-sm text-red-700">
              Failed to load remediation queue.
            </p>
          ) : rows.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="remediation-empty"
            >
              No remediation items match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>JE / Draft</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Failure</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-testid={`remediation-row-${r.id}`}>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === "posted" ? "secondary" : "outline"
                          }
                        >
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.status === "posted" ? (
                          <Link
                            href={`/accounting/journal-entries/${r.entryId}`}
                            className="text-blue-700 hover:underline"
                          >
                            {r.jeNumber ?? `#${r.entryId}`}
                          </Link>
                        ) : (
                          <Link
                            href={`/accounting/journal-entry-drafts/${r.entryId}`}
                            className="text-blue-700 hover:underline"
                          >
                            draft #{r.entryId}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.entryDate ?? "—"}
                      </TableCell>
                      <TableCell
                        className="max-w-[260px] truncate text-xs"
                        title={r.memo ?? ""}
                      >
                        {r.memo ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.failureCode === "unbalanced_entry"
                          ? "—"
                          : `#${r.lineId}`}
                        {r.lineDescription ? (
                          <div
                            className="text-muted-foreground"
                            title={r.lineDescription}
                          >
                            {r.lineDescription.length > 40
                              ? `${r.lineDescription.slice(0, 40)}…`
                              : r.lineDescription}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {r.debitCents ? fmtCents(r.debitCents) : ""}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {r.creditCents ? fmtCents(r.creditCents) : ""}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.currentAccount ? (
                          <span className="font-mono">
                            {r.currentAccount.code} {r.currentAccount.name}
                          </span>
                        ) : r.accountText ? (
                          <span
                            className="font-mono text-amber-700"
                            title="Free-text account, no CoA reference"
                          >
                            “{r.accountText}”
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.sourceType && r.sourceRecordLink ? (
                          <Link
                            href={r.sourceRecordLink}
                            className="text-blue-700 hover:underline"
                          >
                            {r.sourceType} #{r.sourceRecordId}
                          </Link>
                        ) : r.sourceType ? (
                          <span>
                            {r.sourceType} #{r.sourceRecordId ?? "?"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          <StatusBadge code={r.failureCode} />
                        </div>
                        <div
                          className="mt-1 max-w-[260px] text-xs text-muted-foreground"
                          title={r.shortMessage}
                        >
                          {r.shortMessage}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {r.mutability === "mutable" &&
                        (r.failureCode === "missing_account" ||
                          r.failureCode === "archived_account" ||
                          r.failureCode === "non_postable_account") ? (
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() =>
                              setFixTarget({
                                draftId: r.entryId,
                                lineId: r.lineId,
                                rowId: r.id,
                              })
                            }
                            data-testid={`remediation-fix-${r.id}`}
                          >
                            Fix account
                          </Button>
                        ) : r.mutability === "locked" ? (
                          // Posted entries are immutable in place. Operators
                          // pick a corrective path (reverse + replace, or
                          // adjusting entry); both go through the hardened
                          // posting service via /accounting/journal-entries/
                          // :id/remediate. We never expose a direct-edit path.
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid={`remediation-corrective-trigger-${r.id}`}
                              >
                                Corrective action
                                <ChevronDown className="ml-1 h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() =>
                                  setPostedTarget({
                                    row: r,
                                    action: "reverse_and_replace",
                                  })
                                }
                                data-testid={`remediation-corrective-reverse-${r.id}`}
                              >
                                Reverse and replace
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setPostedTarget({
                                    row: r,
                                    action: "adjusting_entry",
                                  })
                                }
                                data-testid={`remediation-corrective-adjust-${r.id}`}
                              >
                                Create adjusting entry
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {fixTarget && (
        <FixDraftLineDialog
          draftId={fixTarget.draftId}
          lineId={fixTarget.lineId}
          accounts={postableAccounts}
          onClose={() => setFixTarget(null)}
          onFixed={() => {
            setFixTarget(null);
            invalidateAfterRemediation();
          }}
        />
      )}
      {postedTarget && (
        <PostedRemediationDialog
          row={postedTarget.row}
          action={postedTarget.action}
          accounts={postableAccounts}
          onClose={() => setPostedTarget(null)}
          onDone={(entryId, newId) => {
            const target = postedTarget;
            setPostedTarget(null);
            invalidateAfterRemediation(entryId ?? target.row.entryId);
            // Also invalidate the newly created replacement / adjusting JE
            // detail cache so any open detail view picks it up immediately.
            if (newId) invalidateAfterRemediation(newId);
          }}
          onInvalidate={(entryId) =>
            invalidateAfterRemediation(entryId ?? postedTarget.row.entryId)
          }
        />
      )}
    </div>
  );
}

function CountCard({
  label,
  value,
  active,
  onClick,
  testId,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-blue-500 bg-blue-50"
          : "border-border/60 hover:bg-muted/30"
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xl font-semibold">{value.toLocaleString()}</div>
    </button>
  );
}

function FixDraftLineDialog({
  draftId,
  lineId,
  accounts,
  onClose,
  onFixed,
}: {
  draftId: number;
  lineId: number;
  accounts: Array<{ id: number; code: string; name: string; type: string }>;
  onClose: () => void;
  onFixed: () => void;
}) {
  const { toast } = useToast();
  const [accountId, setAccountId] = useState<string>("");
  const [note, setNote] = useState("");
  const mutation = useRemediateDraftLineAccount();
  const submitting = mutation.isPending;
  const canSubmit = !!accountId && note.trim().length > 0 && !submitting;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="remediation-fix-dialog">
        <DialogHeader>
          <DialogTitle>Fix draft line account</DialogTitle>
          <DialogDescription>
            Repoint draft #{draftId}, line #{lineId} to a valid
            chart-of-accounts entry. The change is recorded on the activity
            log with your note.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="fix-account">Target account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger
                id="fix-account"
                data-testid="remediation-fix-account"
              >
                <SelectValue placeholder="Choose an active, postable account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.length === 0 ? (
                  <SelectItem value="" disabled>
                    No postable accounts available
                  </SelectItem>
                ) : (
                  accounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      <span className="font-mono mr-2">{a.code}</span>
                      {a.name}{" "}
                      <span className="text-muted-foreground">({a.type})</span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="fix-note">Note (required)</Label>
            <Input
              id="fix-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why does this line belong on the new account?"
              data-testid="remediation-fix-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            data-testid="remediation-fix-submit"
            onClick={async () => {
              try {
                await mutation.mutateAsync({
                  draftId,
                  lineId,
                  data: { accountId: Number(accountId), note: note.trim() },
                });
                toast({ title: "Account updated" });
                onFixed();
              } catch (err) {
                const message =
                  (err as { message?: string })?.message ??
                  "Failed to update account.";
                toast({
                  title: "Could not update account",
                  description: message,
                  variant: "destructive",
                });
              }
            }}
          >
            {submitting ? "Saving…" : "Save fix"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Posted-entry corrective dialog                                      */
/* ------------------------------------------------------------------ */

type PostedAction = "reverse_and_replace" | "adjusting_entry";

type EditableLine = {
  type: "debit" | "credit";
  amount: string; // dollars, kept as string so the input is fully controlled
  account_code: string;
  memo: string;
};

function emptyLine(type: "debit" | "credit" = "debit"): EditableLine {
  return { type, amount: "", account_code: "", memo: "" };
}

/**
 * Parse a dollar string (e.g. "12.34", " 9 ", "") into a positive number,
 * or null when invalid / empty / non-positive. Used both for live-balance
 * computation and for submit-blocking validation, so it must agree with
 * the server-side z.number().positive() rule.
 */
function parseDollars(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function todayIsoDate(): string {
  // Use the operator's local date so the form default matches what they
  // see on every other dated form in the app. The backend just stores
  // it; periods are validated against this date.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function PostedRemediationDialog({
  row,
  action,
  accounts,
  onClose,
  onDone,
  onInvalidate,
}: {
  row: RemediationQueueRow;
  action: PostedAction;
  accounts: Array<{ id: number; code: string; name: string; type: string }>;
  onClose: () => void;
  onDone: (entryId?: number, newId?: number) => void;
  onInvalidate: (entryId?: number) => void;
}) {
  const { toast } = useToast();
  const mutation = useRemediatePostedJournalEntry();
  // Pull the original posted JE so the operator can see what they're
  // about to reverse / adjust against. This is cosmetic context — the
  // backend already has the original — but skipping it leads to "wait,
  // which entry was that?" support tickets.
  const originalQuery = useGetJournalEntry(row.entryId, {
    query: { staleTime: 30_000 },
  });
  const original = (
    originalQuery.data as { journalEntry?: Record<string, unknown> } | undefined
  )?.journalEntry;

  // Pull the upstream expense / bill summary so the operator can see what
  // source record produced this JE without a second tab. We lean on the
  // generated useGetExpense / useGetBill hooks (same hooks the expense /
  // bill detail pages use) rather than inventing a third source-lookup
  // path. The query stays disabled when the row has no source link, so
  // manual-only JEs don't pay for a needless round-trip.
  const sourceExpenseQuery = useGetExpense(row.sourceRecordId ?? 0, {
    query: {
      enabled:
        row.sourceType === "expense" &&
        typeof row.sourceRecordId === "number" &&
        row.sourceRecordId > 0,
      staleTime: 30_000,
    },
  });
  const sourceBillQuery = useGetBill(row.sourceRecordId ?? 0, {
    query: {
      enabled:
        row.sourceType === "bill" &&
        typeof row.sourceRecordId === "number" &&
        row.sourceRecordId > 0,
      staleTime: 30_000,
    },
  });
  // Both useGetExpense and useGetBill return the entity directly (Expense /
  // Bill), not wrapped under an `{ expense }` / `{ bill }` envelope — see
  // lib/api-client-react/src/generated/api.ts (getExpense returns
  // Promise<Expense>). Reading from the wrong shape silently disables the
  // inline summary, which is exactly what we're trying to surface here.
  const sourceExpense = sourceExpenseQuery.data as
    | { merchant?: string; amount?: number; expenseDate?: string; description?: string }
    | undefined;
  const sourceBill = sourceBillQuery.data as
    | { vendorName?: string; amount?: number; invoiceNumber?: string; dueDate?: string; description?: string }
    | undefined;
  const originalLines = (original?.lines as
    | Array<{
        lineNo: number;
        type: "debit" | "credit";
        amountCents: number;
        account: string;
        accountId?: number | null;
        memo?: string | null;
      }>
    | undefined) ?? [];

  const [note, setNote] = useState("");
  const [memo, setMemo] = useState(
    action === "reverse_and_replace"
      ? `Replacement for ${row.jeNumber ?? `JE #${row.entryId}`}`
      : `Adjustment for ${row.jeNumber ?? `JE #${row.entryId}`}`,
  );
  const [entryDate, setEntryDate] = useState(todayIsoDate());
  const [lines, setLines] = useState<EditableLine[]>(() => [
    emptyLine("debit"),
    emptyLine("credit"),
  ]);

  // ---- Live balance --------------------------------------------------------
  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let allValid = true;
    for (const ln of lines) {
      const amt = parseDollars(ln.amount);
      if (amt === null || !ln.account_code.trim()) {
        allValid = false;
        continue;
      }
      if (ln.type === "debit") debit += amt;
      else credit += amt;
    }
    return {
      debit,
      credit,
      balanced: debit > 0 && Math.abs(debit - credit) < 0.005,
      allLinesValid: allValid,
    };
  }, [lines]);

  const noteOk = note.trim().length >= 5;
  const memoOk = memo.trim().length >= 1;
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(entryDate);
  const enoughLines = lines.length >= 2;
  const canSubmit =
    !mutation.isPending &&
    noteOk &&
    memoOk &&
    dateOk &&
    enoughLines &&
    totals.allLinesValid &&
    totals.balanced;

  const isReverseReplace = action === "reverse_and_replace";

  // ---- Submit --------------------------------------------------------------
  const submit = async () => {
    // Belt and braces: re-check on submit so a fast double-click can't
    // race past the disabled state if React schedules oddly.
    if (!canSubmit) return;
    const body: RemediatePostedEntryRequest = {
      action,
      note: note.trim(),
      payload: {
        entryDate,
        memo: memo.trim(),
        lines: lines.map((ln) => ({
          type: ln.type,
          amount: parseDollars(ln.amount) as number,
          account_code: ln.account_code.trim(),
          memo: ln.memo.trim() ? ln.memo.trim() : null,
        })),
      },
    };
    try {
      const result = await mutation.mutateAsync({
        entryId: row.entryId,
        data: body,
      });
      const newId =
        (result as { replacementId?: number; adjustingEntryId?: number })
          .replacementId ??
        (result as { adjustingEntryId?: number }).adjustingEntryId;
      toast({
        title: isReverseReplace
          ? "Reversal posted; replacement created"
          : "Adjusting entry posted",
        description: newId ? `New journal entry #${newId}` : undefined,
      });
      onDone(row.entryId, newId);
    } catch (err) {
      // Error mapping is intentionally explicit (no "Something went wrong"
      // catch-all): finance teams need to know exactly which guard rejected
      // them so they can fix the payload, contact an approver, or unlock
      // the period. The generated client throws ApiError with the parsed
      // JSON body on `err.data` (see lib/api-client-react/src/custom-fetch.ts).
      type RemediationError = Error & {
        status?: number;
        data?: {
          code?: string;
          message?: string;
          reason?: string;
          replacementError?: string;
          reversalId?: number;
        };
      };
      const e = err as RemediationError;
      const status = e.status;
      const code = e.data?.code;
      const reason = e.data?.reason;
      let title = "Could not apply corrective action";
      let description: string | undefined =
        e.data?.message ?? e.message ?? undefined;

      // The adjusting-entry path wraps every postingService failure in
      // ADJUSTING_POST_FAILED with a `reason` discriminator. Without
      // unpacking that here, period_locked / forbidden silently fall back
      // to the generic toast and the operator can't tell why the submit
      // bounced. The reverse-and-replace path uses dedicated codes
      // (REPLACEMENT_POST_FAILED, PERIOD_LOCKED) and is handled below.
      if (
        status === 403 ||
        code === "FORBIDDEN" ||
        (code === "ADJUSTING_POST_FAILED" && reason === "forbidden")
      ) {
        title = "Not allowed";
        description =
          "Your role can't apply corrective actions to posted journal entries.";
      } else if (
        code === "PERIOD_LOCKED" ||
        (code === "ADJUSTING_POST_FAILED" && reason === "period_locked")
      ) {
        title = "Period is locked";
        description =
          "The accounting period containing this entry is closed. Reopen it before applying corrections.";
      } else if (code === "REPLACEMENT_POST_FAILED") {
        title = "Reversal posted, but replacement failed";
        description = `The original entry was reversed (#${
          e.data?.reversalId ?? "?"
        }), but the new replacement could not be posted (${
          e.data?.replacementError ?? "unknown reason"
        }). Fix the replacement payload and retry — do NOT reverse again.`;
        // The reversal succeeded, so the queue + report are stale; refresh
        // caches WITHOUT closing the dialog so the operator can correct the
        // payload and retry the replacement in-place. Closing here would
        // strand them after a partial success.
        onInvalidate(row.entryId);
      } else if (status === 400 || code === "INVALID_BODY") {
        title = "Invalid corrective payload";
      }
      toast({ title, description, variant: "destructive" });
    }
  };

  // ---- Render --------------------------------------------------------------
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-3xl"
        data-testid="remediation-posted-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {isReverseReplace
              ? "Reverse and replace journal entry"
              : "Create adjusting entry"}
          </DialogTitle>
          <DialogDescription>
            {isReverseReplace
              ? "Posts a reversal of the original entry, then a fresh replacement built from the lines below. The original is never edited in place."
              : "Posts a balanced adjusting entry that references the original. The original entry remains unchanged."}
          </DialogDescription>
        </DialogHeader>

        {/* Failing entry summary */}
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {row.jeNumber ?? `JE #${row.entryId}`} —{" "}
            <span className="font-mono text-xs">{row.failureCode}</span>
          </AlertTitle>
          <AlertDescription className="space-y-1">
            <div className="text-xs">
              <span className="text-muted-foreground">Date:</span>{" "}
              {row.entryDate ?? "—"} •{" "}
              <span className="text-muted-foreground">Memo:</span>{" "}
              {row.memo ?? "—"}
            </div>
            <div className="text-xs">{row.shortMessage}</div>
            {row.sourceRecordLink ? (
              <div
                className="text-xs"
                data-testid="remediation-posted-source-chip"
              >
                <span className="text-muted-foreground">Source:</span>{" "}
                <Link
                  href={row.sourceRecordLink}
                  className="text-blue-700 hover:underline"
                >
                  {row.sourceType} #{row.sourceRecordId}
                </Link>
                {row.sourceType === "expense" && sourceExpense ? (
                  <span className="ml-2 text-muted-foreground">
                    {sourceExpense.merchant ?? "(unknown merchant)"} •{" "}
                    {typeof sourceExpense.amount === "number"
                      ? `$${sourceExpense.amount.toFixed(2)}`
                      : "—"}
                    {sourceExpense.expenseDate
                      ? ` • ${sourceExpense.expenseDate}`
                      : ""}
                    {sourceExpense.description
                      ? ` — ${sourceExpense.description}`
                      : ""}
                  </span>
                ) : null}
                {row.sourceType === "bill" && sourceBill ? (
                  <span className="ml-2 text-muted-foreground">
                    {sourceBill.vendorName ?? "(unknown vendor)"} •{" "}
                    {typeof sourceBill.amount === "number"
                      ? `$${sourceBill.amount.toFixed(2)}`
                      : "—"}
                    {sourceBill.invoiceNumber
                      ? ` • Invoice ${sourceBill.invoiceNumber}`
                      : ""}
                    {sourceBill.dueDate ? ` • due ${sourceBill.dueDate}` : ""}
                    {sourceBill.description
                      ? ` — ${sourceBill.description}`
                      : ""}
                  </span>
                ) : null}
              </div>
            ) : (
              <div
                className="text-xs text-muted-foreground"
                data-testid="remediation-posted-source-chip"
              >
                Source: manual entry (no upstream expense or bill).
              </div>
            )}
            {row.periodLocked ? (
              <div
                className="mt-1 inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900"
                data-testid="remediation-posted-period-locked-badge"
              >
                <Lock className="h-3 w-3" />
                Period locked{row.periodLabel ? ` — ${row.periodLabel}` : ""}.
                Reopen the period before submitting; this corrective action
                will be rejected otherwise.
              </div>
            ) : row.periodLabel ? (
              <div className="text-xs text-muted-foreground">
                Period: {row.periodLabel} (open).
              </div>
            ) : null}
            {originalLines.length > 0 ? (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50/40 p-2 text-xs">
                <div className="mb-1 font-semibold text-amber-900">
                  Original lines
                </div>
                <table className="w-full">
                  <tbody>
                    {originalLines.map((ol) => (
                      <tr key={ol.lineNo}>
                        <td className="py-0.5 pr-2 text-muted-foreground">
                          #{ol.lineNo}
                        </td>
                        <td className="py-0.5 pr-2 capitalize">{ol.type}</td>
                        <td className="py-0.5 pr-2 font-mono">
                          {fmtCents(ol.amountCents)}
                        </td>
                        <td className="py-0.5 pr-2 font-mono">{ol.account}</td>
                        <td className="py-0.5 text-muted-foreground">
                          {ol.memo ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {isReverseReplace ? (
              <div className="mt-2 text-xs font-semibold text-amber-900">
                ⚠ The original entry will be reversed (not mutated). The
                reversal stands on its own; if the replacement post fails,
                you'll get a clear error and can retry the replacement
                separately.
              </div>
            ) : (
              <div className="mt-2 text-xs font-semibold text-amber-900">
                ⚠ The original entry will remain in the books unchanged. This
                adjustment posts on top of it.
              </div>
            )}
          </AlertDescription>
        </Alert>

        {/* Form */}
        <div className="space-y-3">
          <div>
            <Label htmlFor="posted-note">
              Note / justification (required, 5+ chars)
            </Label>
            <Textarea
              id="posted-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this corrective action needed?"
              data-testid="remediation-posted-note"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="posted-date">Entry date</Label>
              <Input
                id="posted-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                data-testid="remediation-posted-date"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="posted-memo">Memo</Label>
              <Input
                id="posted-memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                data-testid="remediation-posted-memo"
              />
            </div>
          </div>

          <LinesEditor
            lines={lines}
            setLines={setLines}
            accounts={accounts}
          />

          <div
            className={`rounded-md border p-2 text-xs ${
              totals.balanced
                ? "border-green-300 bg-green-50 text-green-900"
                : "border-amber-300 bg-amber-50 text-amber-900"
            }`}
            data-testid="remediation-posted-balance"
          >
            Debits ${totals.debit.toFixed(2)} • Credits ${totals.credit.toFixed(2)} —{" "}
            {totals.balanced
              ? "balanced ✓"
              : totals.allLinesValid
                ? `out of balance by $${Math.abs(
                    totals.debit - totals.credit,
                  ).toFixed(2)}`
                : "fill in account + positive amount on every line"}
          </div>
        </div>

        {/* Explicit "this will create…" preview so the operator knows
            exactly what hits the books before they click submit. */}
        <div
          className="rounded-md border border-blue-200 bg-blue-50/40 p-2 text-xs text-blue-900"
          data-testid="remediation-posted-action-preview"
        >
          <span className="font-semibold">This will:</span>{" "}
          {isReverseReplace ? (
            <>
              post a reversal of{" "}
              <span className="font-mono">
                {row.jeNumber ?? `JE #${row.entryId}`}
              </span>{" "}
              and create a brand-new replacement journal entry from the
              lines above.
            </>
          ) : (
            <>
              post a new adjusting journal entry that references{" "}
              <span className="font-mono">
                {row.jeNumber ?? `JE #${row.entryId}`}
              </span>{" "}
              from the lines above. The original stays in the books.
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            data-testid="remediation-posted-submit"
          >
            {mutation.isPending
              ? "Submitting…"
              : isReverseReplace
                ? "Reverse and create replacement entry"
                : "Create adjusting entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinesEditor({
  lines,
  setLines,
  accounts,
}: {
  lines: EditableLine[];
  setLines: React.Dispatch<React.SetStateAction<EditableLine[]>>;
  accounts: Array<{ id: number; code: string; name: string; type: string }>;
}) {
  const update = (i: number, patch: Partial<EditableLine>) => {
    setLines((prev) => prev.map((ln, idx) => (idx === i ? { ...ln, ...patch } : ln)));
  };
  const remove = (i: number) => {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Label>Lines (must balance, ≥ 2)</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLines((prev) => [...prev, emptyLine("debit")])}
            data-testid="remediation-posted-add-debit"
          >
            + Debit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLines((prev) => [...prev, emptyLine("credit")])}
            data-testid="remediation-posted-add-credit"
          >
            + Credit
          </Button>
        </div>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[110px]">Type</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="w-[120px] text-right">Amount</TableHead>
              <TableHead>Memo</TableHead>
              <TableHead className="w-[40px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((ln, i) => (
              <TableRow key={i} data-testid={`remediation-posted-line-${i}`}>
                <TableCell>
                  <Select
                    value={ln.type}
                    onValueChange={(v) =>
                      update(i, { type: v as "debit" | "credit" })
                    }
                  >
                    <SelectTrigger
                      data-testid={`remediation-posted-line-${i}-type`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debit">Debit</SelectItem>
                      <SelectItem value="credit">Credit</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Select
                    value={ln.account_code}
                    onValueChange={(v) => update(i, { account_code: v })}
                  >
                    <SelectTrigger
                      data-testid={`remediation-posted-line-${i}-account`}
                    >
                      <SelectValue placeholder="Pick account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.length === 0 ? (
                        <SelectItem value="" disabled>
                          No postable accounts
                        </SelectItem>
                      ) : (
                        accounts.map((a) => (
                          <SelectItem key={a.id} value={a.code}>
                            <span className="font-mono mr-2">{a.code}</span>
                            {a.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    inputMode="decimal"
                    value={ln.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    placeholder="0.00"
                    className="text-right"
                    data-testid={`remediation-posted-line-${i}-amount`}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    value={ln.memo}
                    onChange={(e) => update(i, { memo: e.target.value })}
                    placeholder="optional"
                    data-testid={`remediation-posted-line-${i}-memo`}
                  />
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(i)}
                    disabled={lines.length <= 2}
                    aria-label={`Remove line ${i + 1}`}
                    data-testid={`remediation-posted-line-${i}-remove`}
                  >
                    ×
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
