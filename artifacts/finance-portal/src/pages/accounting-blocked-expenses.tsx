import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListBlockedExpenses,
  useRetryBlockedExpenses,
  useMarkExpenseAccountingNotApplicable,
  useRegenerateAccountingDraftForExpense,
  useListBlockedBills,
  useRetryBlockedBills,
  getListBlockedExpensesQueryKey,
  getGetBlockedExpensesCountQueryKey,
  getListBlockedBillsQueryKey,
  getGetBlockedBillsCountQueryKey,
  type BlockedExpenseRow,
  type BlockedBillRow,
} from "@workspace/api-client-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { apiJson } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty } from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { AlertTriangle, MoreHorizontal, RefreshCw, Settings } from "lucide-react";

// Mirror the backend enum so missing entries fall through to a humanized
// version of the snake_case code instead of crashing the page.
const REASON_LABEL: Record<string, string> = {
  missing_category: "No category set on expense",
  missing_mapping: "Category has no GL account mapping",
  archived_account: "Mapped account is archived",
  non_postable_account: "Mapped account is not postable",
  invalid_payment_method_rule: "Payment method has no posting rule",
  other: "Other / internal error",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  credit_card: "Credit card",
  debit_card: "Debit card",
  bank_transfer: "Bank transfer",
  other: "Other",
};

function reasonLabel(code: string | null | undefined): string {
  if (!code) return "Unknown reason";
  return REASON_LABEL[code] ?? code.replace(/_/g, " ");
}

export default function AccountingBlockedExpenses() {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const qc = useQueryClient();
  const { toast } = useToast();

  // Build query params — only include filters when they're set so the
  // generated hook doesn't send `reasonCode=all` to the server.
  const listParams: {
    page: number;
    pageSize: number;
    reasonCode?: string;
  } = { page, pageSize };
  if (reasonFilter !== "all") listParams.reasonCode = reasonFilter;

  const { data, isLoading, isError, error } = useListBlockedExpenses(
    listParams,
    {
      query: {
        queryKey: getListBlockedExpensesQueryKey(listParams),
      },
    },
  );

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [naDialog, setNaDialog] = useState<BlockedExpenseRow | null>(null);
  const [naNote, setNaNote] = useState("");

  const retryMut = useRetryBlockedExpenses();
  const singleRetryMut = useRegenerateAccountingDraftForExpense();
  const naMut = useMarkExpenseAccountingNotApplicable();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const metrics = data?.metrics ?? {};

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map((i) => i.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const reasonChips = useMemo(
    () =>
      Object.entries(metrics).sort((a, b) => b[1] - a[1]),
    [metrics],
  );

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({
        queryKey: getListBlockedExpensesQueryKey({ page, pageSize }),
      }),
      qc.invalidateQueries({
        queryKey: getGetBlockedExpensesCountQueryKey(),
      }),
    ]);
  }

  async function runRetry(ids: number[]) {
    if (ids.length === 0) return;
    try {
      const resp = await retryMut.mutateAsync({ data: { expenseIds: ids } });
      const okCount = resp.results.filter((r) => r.result.ok).length;
      const failCount = resp.results.length - okCount;
      toast({
        title: "Retry complete",
        description: `${okCount} draft(s) generated, ${failCount} still blocked.`,
      });
      setSelected(new Set());
    } catch (err) {
      toast({
        title: "Retry failed",
        description:
          err instanceof Error
            ? err.message
            : "The server rejected the bulk retry. Try again or refresh.",
        variant: "destructive",
      });
    }
    await invalidate();
  }

  async function handleRetryAll() {
    await runRetry(items.map((i) => i.id));
  }

  async function handleRetrySelected() {
    await runRetry(Array.from(selected));
  }

  async function handleSingleRetry(id: number) {
    try {
      await singleRetryMut.mutateAsync({ id });
      toast({ title: "Draft generated", description: `Expense #${id}` });
    } catch {
      toast({
        title: "Still blocked",
        description: `Expense #${id} could not generate a draft. Check the mapping and try again.`,
        variant: "destructive",
      });
    }
    await invalidate();
  }

  async function handleMarkNotApplicable() {
    if (!naDialog) return;
    if (naNote.trim().length < 3) {
      toast({
        title: "Note required",
        description: "Add a short note (3+ characters) explaining why.",
        variant: "destructive",
      });
      return;
    }
    try {
      await naMut.mutateAsync({
        id: naDialog.id,
        data: { note: naNote.trim() },
      });
      toast({
        title: "Marked not applicable",
        description: `Expense #${naDialog.id} no longer needs an accounting entry.`,
      });
      setNaDialog(null);
      setNaNote("");
    } catch (err) {
      toast({
        title: "Could not mark not applicable",
        description:
          err instanceof Error
            ? err.message
            : "The expense state may have changed. Refresh and try again.",
        variant: "destructive",
      });
    }
    await invalidate();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6" data-testid="page-blocked-expenses">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Blocked accounting queue</h1>
        <p className="text-muted-foreground">
          Approved expenses and bills whose draft journal entry could not be
          generated. Fix the underlying mapping, then retry.
        </p>
      </div>

      <Tabs defaultValue="expenses" className="space-y-6">
        <TabsList data-testid="tabs-blocked-source">
          <TabsTrigger value="expenses" data-testid="tab-expenses">
            Expenses
          </TabsTrigger>
          <TabsTrigger value="bills" data-testid="tab-bills">
            Bills
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bills">
          <BlockedBillsTab />
        </TabsContent>

        <TabsContent value="expenses" className="space-y-6">

      {/* Metrics strip */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {total} blocked
          </CardTitle>
          <CardDescription>Breakdown by reason</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {reasonChips.length === 0 ? (
            <span className="text-sm text-muted-foreground">No blocked expenses.</span>
          ) : (
            reasonChips.map(([code, count]) => (
              <Badge
                key={code}
                variant="outline"
                data-testid={`metric-${code}`}
                className="gap-1.5 text-sm"
              >
                <span className="font-semibold">{count}</span>
                <span className="text-muted-foreground">{reasonLabel(code)}</span>
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      {/* Filters — keep the queue scannable when one block reason or
          category dominates. Both reset pagination since the filtered set
          changes the meaningful page count. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="filter-reason" className="text-xs text-muted-foreground">
            Block reason
          </Label>
          <Select
            value={reasonFilter}
            onValueChange={(v) => {
              setReasonFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger
              id="filter-reason"
              className="w-[260px]"
              data-testid="select-reason-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {Object.entries(REASON_LABEL).map(([code, label]) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reasonFilter !== "all" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReasonFilter("all");
              setPage(1);
            }}
            data-testid="button-clear-filters"
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Auth/permission errors should not silently render an empty queue —
          surface a clear message so finance can call the right person. */}
      {isError && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the blocked queue
            {error instanceof Error ? `: ${error.message}` : "."}
          </CardContent>
        </Card>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {selected.size > 0 ? `${selected.size} selected` : `${items.length} on this page`}
        </div>
        <div className="flex gap-2">
          <Link href="/admin/expense-categories">
            <Button variant="outline" size="sm" data-testid="button-manage-mappings">
              <Settings className="mr-2 h-4 w-4" />
              Manage category mappings
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetrySelected}
            disabled={selected.size === 0 || retryMut.isPending}
            data-testid="button-retry-selected"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry selected
          </Button>
          <Button
            size="sm"
            onClick={handleRetryAll}
            disabled={items.length === 0 || retryMut.isPending}
            data-testid="button-retry-all"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry all on page
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-8">
              <Empty
                title="Nothing blocked"
                description="Every approved expense has a draft entry or is marked not applicable."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        aria-label="Select all on page"
                        data-testid="checkbox-select-all"
                      />
                    </th>
                    <th className="px-3 py-2">Expense</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Submitter</th>
                    <th className="px-3 py-2">Merchant</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Program</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Payment</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="w-10 px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/20"
                      data-testid={`row-blocked-${row.id}`}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(row.id)}
                          onCheckedChange={() => toggleOne(row.id)}
                          aria-label={`Select expense ${row.id}`}
                          data-testid={`checkbox-row-${row.id}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/expenses/${row.id}`}>
                          <span className="font-medium text-primary hover:underline">
                            #{row.id}
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {format(new Date(row.expenseDate), "MMM d, yyyy")}
                      </td>
                      <td className="px-3 py-2">{row.submittedBy}</td>
                      <td className="px-3 py-2">{row.merchant}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        ${row.amount.toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        {row.programName ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.categoryName ?? (
                          <span className="italic text-muted-foreground">
                            Uncategorized
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {PAYMENT_METHOD_LABEL[row.paymentMethod] ?? row.paymentMethod}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="destructive" className="font-normal">
                          {reasonLabel(row.accountingBlockReason)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              data-testid={`button-actions-${row.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleSingleRetry(row.id)}
                              data-testid={`menu-retry-${row.id}`}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Retry generation
                            </DropdownMenuItem>
                            <Link
                              href={
                                row.categoryId
                                  ? `/admin/expense-categories?focus=${row.categoryId}`
                                  : "/admin/expense-categories"
                              }
                            >
                              <DropdownMenuItem
                                data-testid={`menu-mapping-${row.id}`}
                              >
                                <Settings className="mr-2 h-4 w-4" />
                                Edit category mapping
                              </DropdownMenuItem>
                            </Link>
                            <DropdownMenuItem
                              onClick={() => {
                                setNaDialog(row);
                                setNaNote("");
                              }}
                              data-testid={`menu-not-applicable-${row.id}`}
                            >
                              Mark not applicable
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Dialog
        open={!!naDialog}
        onOpenChange={(open) => {
          if (!open) {
            setNaDialog(null);
            setNaNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark expense not applicable</DialogTitle>
            <DialogDescription>
              {naDialog &&
                `Expense #${naDialog.id} (${naDialog.merchant}, $${naDialog.amount.toFixed(2)}) will no longer attempt to generate an accounting entry.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="na-note">Reason (required)</Label>
            <Textarea
              id="na-note"
              value={naNote}
              onChange={(e) => setNaNote(e.target.value)}
              rows={3}
              placeholder="e.g. duplicate of expense #123, refund handled separately"
              data-testid="textarea-na-note"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNaDialog(null);
                setNaNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMarkNotApplicable}
              disabled={naMut.isPending || naNote.trim().length < 3}
              data-testid="button-confirm-not-applicable"
            >
              Mark not applicable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task #63 — Bills version of the blocked queue. Bills can have two
// independently-blocked legs (accrual / payment), so each row carries an
// eventType and we key selection on `${billId}:${eventType}`.
// ---------------------------------------------------------------------------

const BILL_REASON_LABEL: Record<string, string> = {
  missing_category: "No expense category set on bill",
  missing_mapping: "Category has no GL account mapping",
  archived_account: "Mapped account is archived",
  non_postable_account: "Mapped account is not postable",
  missing_ap_account: "Default A/P account not configured",
  missing_cash_account: "Default cash account not configured",
  other: "Other / internal error",
};

function billReasonLabel(code: string | null | undefined): string {
  if (!code) return "Unknown reason";
  return BILL_REASON_LABEL[code] ?? code.replace(/_/g, " ");
}

type BillSelectionKey = string;
const billRowKey = (r: BlockedBillRow): BillSelectionKey =>
  `${r.billId}:${r.eventType}`;

function BlockedBillsTab() {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<BillSelectionKey>>(new Set());
  const [singleBusy, setSingleBusy] = useState<BillSelectionKey | null>(null);
  const [naBusy, setNaBusy] = useState<BillSelectionKey | null>(null);

  const params: {
    page: number;
    pageSize: number;
    reasonCode?: string;
    eventType?: "accrual" | "payment";
  } = { page, pageSize };
  if (reasonFilter !== "all") params.reasonCode = reasonFilter;
  if (eventTypeFilter === "accrual" || eventTypeFilter === "payment")
    params.eventType = eventTypeFilter;

  const { data, isLoading, isError, error } = useListBlockedBills(params, {
    query: { queryKey: getListBlockedBillsQueryKey(params) },
  });
  const retryMut = useRetryBlockedBills();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const metrics = data?.metrics ?? {};

  const allSelected =
    items.length > 0 && items.every((i) => selected.has(billRowKey(i)));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map(billRowKey)));
  };
  const toggleOne = (r: BlockedBillRow) => {
    const key = billRowKey(r);
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const reasonChips = useMemo(
    () => Object.entries(metrics).sort((a, b) => b[1] - a[1]),
    [metrics],
  );

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListBlockedBillsQueryKey(params) }),
      qc.invalidateQueries({ queryKey: getGetBlockedBillsCountQueryKey() }),
    ]);
  }

  async function runRetry(rows: BlockedBillRow[]) {
    if (rows.length === 0) return;
    try {
      const resp = await retryMut.mutateAsync({
        data: {
          items: rows.map((r) => ({
            billId: r.billId,
            eventType: r.eventType,
          })),
        },
      });
      const ok = resp.results.filter((r) => r.result.ok).length;
      const fail = resp.results.length - ok;
      toast({
        title: "Retry complete",
        description: `${ok} draft(s) generated, ${fail} still blocked.`,
      });
      setSelected(new Set());
    } catch (err) {
      toast({
        title: "Retry failed",
        description:
          err instanceof Error
            ? err.message
            : "The server rejected the bulk retry. Try again or refresh.",
        variant: "destructive",
      });
    }
    await invalidate();
  }

  async function handleSingleRetry(r: BlockedBillRow) {
    const key = billRowKey(r);
    setSingleBusy(key);
    try {
      await apiJson(`/bills/${r.billId}/regenerate-accounting-draft`, {
        method: "POST",
        body: { eventType: r.eventType },
      });
      toast({
        title: "Draft generated",
        description: `Bill #${r.billId} (${r.eventType})`,
      });
    } catch (err) {
      toast({
        title: "Still blocked",
        description:
          err instanceof Error
            ? err.message
            : `Bill #${r.billId} could not generate a draft.`,
        variant: "destructive",
      });
    } finally {
      setSingleBusy(null);
    }
    await invalidate();
  }

  async function handleNotApplicable(r: BlockedBillRow) {
    if (
      !confirm(
        `Mark bill #${r.billId} ${r.eventType} as not applicable? It will be excluded from the queue.`,
      )
    )
      return;
    const key = billRowKey(r);
    setNaBusy(key);
    try {
      await apiJson(`/bills/${r.billId}/mark-accounting-not-applicable`, {
        method: "POST",
        body: { eventType: r.eventType },
      });
      toast({ title: "Marked not applicable" });
    } catch (err) {
      toast({
        title: "Could not update",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setNaBusy(null);
    }
    await invalidate();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedRows = items.filter((i) => selected.has(billRowKey(i)));

  return (
    <div className="space-y-6" data-testid="panel-blocked-bills">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {total} blocked bill leg(s)
          </CardTitle>
          <CardDescription>Breakdown by reason</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {reasonChips.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No blocked bills.
            </span>
          ) : (
            reasonChips.map(([code, count]) => (
              <Badge
                key={code}
                variant="outline"
                data-testid={`metric-bill-${code}`}
                className="gap-1.5 text-sm"
              >
                <span className="font-semibold">{count}</span>
                <span className="text-muted-foreground">
                  {billReasonLabel(code)}
                </span>
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label
            htmlFor="filter-bill-reason"
            className="text-xs text-muted-foreground"
          >
            Block reason
          </Label>
          <Select
            value={reasonFilter}
            onValueChange={(v) => {
              setReasonFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger
              id="filter-bill-reason"
              className="w-[260px]"
              data-testid="select-bill-reason-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {Object.entries(BILL_REASON_LABEL).map(([code, label]) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label
            htmlFor="filter-bill-event"
            className="text-xs text-muted-foreground"
          >
            Leg
          </Label>
          <Select
            value={eventTypeFilter}
            onValueChange={(v) => {
              setEventTypeFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger
              id="filter-bill-event"
              className="w-[160px]"
              data-testid="select-bill-event-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both legs</SelectItem>
              <SelectItem value="accrual">Accrual</SelectItem>
              <SelectItem value="payment">Payment</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(reasonFilter !== "all" || eventTypeFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReasonFilter("all");
              setEventTypeFilter("all");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {isError && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the blocked bills queue
            {error instanceof Error ? `: ${error.message}` : "."}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {selected.size > 0
            ? `${selected.size} selected`
            : `${items.length} on this page`}
        </div>
        <div className="flex gap-2">
          <Link href="/admin/expense-categories">
            <Button variant="outline" size="sm">
              <Settings className="mr-2 h-4 w-4" />
              Manage category mappings
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runRetry(selectedRows)}
            disabled={selected.size === 0 || retryMut.isPending}
            data-testid="button-bill-retry-selected"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry selected
          </Button>
          <Button
            size="sm"
            onClick={() => runRetry(items)}
            disabled={items.length === 0 || retryMut.isPending}
            data-testid="button-bill-retry-all"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry all on page
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-8">
              <Empty
                title="Nothing blocked"
                description="Every approved bill has a draft entry on each leg, or is marked not applicable."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleAll}
                        aria-label="Select all on page"
                      />
                    </th>
                    <th className="px-3 py-2">Bill</th>
                    <th className="px-3 py-2">Leg</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Vendor</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2">Program</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="w-10 px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const key = billRowKey(row);
                    return (
                      <tr
                        key={key}
                        className="border-b last:border-0 hover:bg-muted/20"
                        data-testid={`row-blocked-bill-${row.billId}-${row.eventType}`}
                      >
                        <td className="px-3 py-2">
                          <Checkbox
                            checked={selected.has(key)}
                            onCheckedChange={() => toggleOne(row)}
                            aria-label={`Select bill ${row.billId} ${row.eventType}`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Link href={`/bills/${row.billId}`}>
                            <span className="font-medium text-primary hover:underline">
                              #{row.billId}
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-2 capitalize">
                          {row.eventType}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {format(
                            new Date(row.invoiceDate ?? row.dueDate),
                            "MMM d, yyyy",
                          )}
                        </td>
                        <td className="px-3 py-2">{row.vendorName}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          ${row.amount.toFixed(2)}
                        </td>
                        <td className="px-3 py-2">
                          {row.programName ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {row.categoryName ?? (
                            <span className="italic text-muted-foreground">
                              Uncategorized
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant="destructive"
                            className="font-normal"
                          >
                            {billReasonLabel(row.accountingBlockReason)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleSingleRetry(row)}
                                disabled={singleBusy === key}
                              >
                                <RefreshCw className="mr-2 h-4 w-4" />
                                Retry generation
                              </DropdownMenuItem>
                              <Link
                                href={
                                  row.categoryId
                                    ? `/admin/expense-categories?focus=${row.categoryId}`
                                    : "/admin/expense-categories"
                                }
                              >
                                <DropdownMenuItem>
                                  <Settings className="mr-2 h-4 w-4" />
                                  Edit category mapping
                                </DropdownMenuItem>
                              </Link>
                              <Link href="/accounting/settings">
                                <DropdownMenuItem>
                                  <Settings className="mr-2 h-4 w-4" />
                                  Open accounting settings
                                </DropdownMenuItem>
                              </Link>
                              <DropdownMenuItem
                                onClick={() => handleNotApplicable(row)}
                                disabled={naBusy === key}
                              >
                                Mark not applicable
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
