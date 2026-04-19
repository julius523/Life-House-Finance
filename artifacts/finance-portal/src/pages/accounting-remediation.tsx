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
import {
  useListRemediationQueue,
  useGetRemediationCounts,
  useRemediateDraftLineAccount,
  useListChartOfAccounts,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  const [fixTarget, setFixTarget] = useState<{
    draftId: number;
    lineId: number;
    rowId: string;
  } | null>(null);

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
                          <span
                            className="text-xs text-muted-foreground"
                            title="Posted entries cannot be edited in place; use a corrective action."
                          >
                            Locked
                          </span>
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
            queue.refetch();
            counts.refetch();
          }}
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
