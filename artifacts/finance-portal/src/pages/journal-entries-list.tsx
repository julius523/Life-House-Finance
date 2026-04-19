import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Empty } from "@/components/ui/empty";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  useListJournalEntries,
  useListJournalEntryDrafts,
  useDeleteJournalEntryDraft,
  useListAccountingPeriods,
  useCreateAccountingPeriod,
  useCloseAccountingPeriod,
  getListJournalEntryDraftsQueryKey,
  getListAccountingPeriodsQueryKey,
  ListJournalEntriesStatus,
  ListJournalEntriesSource,
  type ListJournalEntriesParams,
  type ListJournalEntryDraftsParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowLeft,
  BookOpen,
  Download,
  FileEdit,
  Filter,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Unlock,
  User,
} from "lucide-react";

type EntryActor = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

type JournalEntry = {
  id: number;
  entryNo: string;
  entryDate: string;
  memo: string;
  status: "posted" | "reversed";
  totalsDebitsCents: number;
  totalsCreditsCents: number;
  postedAt: string;
  agentActionId: number | null;
  reversesJournalEntryId: number | null;
  postedBy: EntryActor | null;
  approver: EntryActor | null;
  // Task #53 — backend-derived source. Resolution order on the
  // server: copilot first, then expense, then manual.
  source?: "manual" | "copilot" | "expense" | "bill";
  // Task #53 — when source === 'expense', the originating expense
  // summary is included so the list cell can render "Expense #N".
  originatingExpense?: { id: number; merchant: string } | null;
  // Task #63 — when source === 'bill', the originating bill summary is
  // included so the list cell can render "Bill #N (Accrual)" /
  // "Bill #N (Payment)".
  originatingBill?: {
    id: number;
    eventType: "accrual" | "payment";
    vendorName: string;
  } | null;
  // Task #48 — covering accounting period (if any). When status is
  // "closed", the entry is locked and corrections must go through a
  // reversing entry.
  period?: {
    id: number;
    label: string;
    status: "open" | "closed";
  } | null;
};

type AccountingPeriod = {
  id: number;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: "open" | "closed";
  closedAt: string | null;
};

function actorName(a: EntryActor | null): string {
  if (!a) return "—";
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  return name || a.email || `User #${a.id}`;
}

type StatusFilter = "all" | "posted" | "reversed";
type SourceFilter = "all" | "manual" | "copilot" | "expense" | "bill";
type DraftScope = "mine" | "all";
type DraftStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "posted";
type DraftStatusFilter = "all" | DraftStatus;

type DraftSummary = {
  id: number;
  createdByUserId: number;
  entryDate: string | null;
  memo: string | null;
  status: DraftStatus;
  submittedByUserId: number | null;
  approvedByUserId: number | null;
  rejectedByUserId: number | null;
  rejectionReason: string | null;
  postedJournalEntryId: number | null;
  /** Task #44 — optimistic-lock token, sent on discard. */
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
};

function DraftStatusBadge({ status }: { status: DraftStatus }) {
  switch (status) {
    case "draft":
      return <Badge variant="outline">Draft</Badge>;
    case "submitted":
      return <Badge variant="secondary">Submitted</Badge>;
    case "approved":
      return <Badge className="bg-blue-600 hover:bg-blue-600">Approved</Badge>;
    case "rejected":
      return <Badge variant="destructive">Rejected</Badge>;
    case "posted":
      return <Badge>Posted</Badge>;
  }
}

const PAGE_SIZE = 50;

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function entrySource(e: JournalEntry): "manual" | "copilot" | "expense" {
  // Task #53 — backend now returns the resolved source (expense > copilot
  // > manual). Fall back to the legacy heuristic for older payloads.
  return e.source ?? (e.agentActionId !== null ? "copilot" : "manual");
}

// Parse "YYYY-MM-DD" as a local-time date so format() doesn't render the
// previous day in negative-UTC-offset timezones.
function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export default function JournalEntriesListPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const canView = user?.role === "admin" || user?.role === "approver";

  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [page, setPage] = useState(0);

  const queryClient = useQueryClient();
  const deleteDraftMut = useDeleteJournalEntryDraft();

  // Task #48 — accounting periods admin block. Only admins can create or
  // close periods, but approvers can also view them so they understand
  // why a post might be rejected.
  const isAdmin = user?.role === "admin";
  const { data: periodsData } = useListAccountingPeriods({
    query: { enabled: canView },
  });
  const periods = ((periodsData as { periods?: AccountingPeriod[] } | undefined)
    ?.periods ?? []) as AccountingPeriod[];
  const createPeriodMut = useCreateAccountingPeriod();
  const closePeriodMut = useCloseAccountingPeriod();
  const [periodLabel, setPeriodLabel] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const refreshPeriods = () => {
    queryClient.invalidateQueries({
      queryKey: getListAccountingPeriodsQueryKey(),
    });
  };

  const createPeriod = async () => {
    if (!periodLabel || !periodStart || !periodEnd) return;
    try {
      await createPeriodMut.mutateAsync({
        data: {
          label: periodLabel,
          periodStart,
          periodEnd,
        },
      });
      toast({ title: "Period created" });
      setPeriodLabel("");
      setPeriodStart("");
      setPeriodEnd("");
      refreshPeriods();
    } catch (e) {
      toast({
        title: "Could not create period",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const closePeriod = async (id: number, label: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Close period "${label}"? Posts dated within this period will be rejected.`,
      )
    ) {
      return;
    }
    try {
      await closePeriodMut.mutateAsync({ id });
      toast({ title: "Period closed" });
      refreshPeriods();
    } catch (e) {
      toast({
        title: "Could not close period",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const [includeLines, setIncludeLines] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [draftScope, setDraftScope] = useState<DraftScope>("mine");
  const [draftStatusFilter, setDraftStatusFilter] =
    useState<DraftStatusFilter>("all");

  const draftsParams: ListJournalEntryDraftsParams = { scope: draftScope };
  const { data: draftsData, isLoading: draftsLoading } =
    useListJournalEntryDrafts(draftsParams, {
      query: { enabled: canView },
    });
  const drafts = useMemo(() => {
    const all = (draftsData as { drafts?: DraftSummary[] } | undefined)
      ?.drafts ?? [];
    return draftStatusFilter === "all"
      ? all
      : all.filter((d) => d.status === draftStatusFilter);
  }, [draftsData, draftStatusFilter]);

  const discardDraft = async (id: number, version: number) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Discard this draft? This cannot be undone.")
    ) {
      return;
    }
    try {
      // Task #44 — send last-seen version so we don't blow away a draft
      // that someone else just edited.
      await deleteDraftMut.mutateAsync({
        id,
        params: { expectedVersion: version },
      });
      toast({ title: "Draft discarded" });
      queryClient.invalidateQueries({
        queryKey: getListJournalEntryDraftsQueryKey(draftsParams),
      });
    } catch (e) {
      toast({
        title: "Could not discard draft",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  // Reset to first page when filters change.
  useEffect(() => {
    setPage(0);
  }, [status, source, from, to]);

  const entriesParams = useMemo<ListJournalEntriesParams>(() => {
    const p: ListJournalEntriesParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (status !== "all") {
      p.status = status as (typeof ListJournalEntriesStatus)[
        keyof typeof ListJournalEntriesStatus
      ];
    }
    if (source !== "all") {
      p.source = source as (typeof ListJournalEntriesSource)[
        keyof typeof ListJournalEntriesSource
      ];
    }
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [status, source, from, to, page]);

  const {
    data: entriesData,
    isLoading: loading,
    error: entriesError,
  } = useListJournalEntries(entriesParams, {
    query: { enabled: canView },
  });
  const entries = ((entriesData as { entries?: JournalEntry[] } | undefined)
    ?.entries ?? []) as JournalEntry[];
  const total = (entriesData as { total?: number } | undefined)?.total ?? 0;
  const error = entriesError
    ? entriesError instanceof Error
      ? entriesError.message
      : "Failed to load journal entries."
    : null;
  useEffect(() => {
    if (entriesError) {
      toast({
        title: "Could not load journal entries",
        description:
          entriesError instanceof Error ? entriesError.message : undefined,
        variant: "destructive",
      });
    }
  }, [entriesError, toast]);

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Journal entries</h1>
        <p className="text-muted-foreground">
          Only admins and approvers can review posted journal entries.
        </p>
      </div>
    );
  }

  const startIdx = page * PAGE_SIZE + 1;
  const endIdx = Math.min(total, page * PAGE_SIZE + entries.length);
  const hasNext = (page + 1) * PAGE_SIZE < total;
  const hasPrev = page > 0;

  const clearFilters = () => {
    setStatus("all");
    setSource("all");
    setFrom("");
    setTo("");
  };

  const filtersActive =
    status !== "all" || source !== "all" || from !== "" || to !== "";

  const downloadCsv = async () => {
    setExporting(true);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (source !== "all") p.set("source", source);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (includeLines) p.set("includeLines", "true");
      const res = await fetch(`/api/accounting/journal-entries.csv?${p.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // non-JSON error body — keep default message
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const today = new Date().toISOString().slice(0, 10);
      const filename = `journal-entries-${today}${includeLines ? "-with-lines" : ""}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({
        title: "Could not export journal entries",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-7 w-7 text-primary" />
            Journal entries
          </h1>
          <p className="text-muted-foreground mt-1">
            Every posted ledger entry — manual and copilot-posted — in one
            audit-friendly view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" asChild>
            <Link href="/accounting">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
          <Button asChild>
            <Link href="/accounting/journal-entries/new">
              <Plus className="h-4 w-4 mr-1" />
              New entry
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            Filters
          </CardTitle>
          <CardDescription>
            Filter by date range, status, and how the entry was posted.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="je-from">From</Label>
            <Input
              id="je-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="je-to">To</Label>
            <Input
              id="je-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="copilot">Copilot</SelectItem>
                <SelectItem value="expense">Expense</SelectItem>
                <SelectItem value="bill">Bill</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Button
              variant="outline"
              onClick={clearFilters}
              disabled={!filtersActive}
              className="w-full"
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-accounting-periods">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            Accounting periods
          </CardTitle>
          <CardDescription>
            Closed periods are locked: posts dated inside them are rejected
            and corrections must go through reversing entries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isAdmin && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div className="space-y-1.5">
                <Label htmlFor="period-label">Label</Label>
                <Input
                  id="period-label"
                  placeholder="e.g. 2026-04"
                  value={periodLabel}
                  onChange={(e) => setPeriodLabel(e.target.value)}
                  data-testid="input-period-label"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="period-start">Start</Label>
                <Input
                  id="period-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  data-testid="input-period-start"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="period-end">End</Label>
                <Input
                  id="period-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  data-testid="input-period-end"
                />
              </div>
              <Button
                onClick={createPeriod}
                disabled={
                  !periodLabel ||
                  !periodStart ||
                  !periodEnd ||
                  createPeriodMut.isPending
                }
                data-testid="button-create-period"
              >
                <Plus className="h-4 w-4 mr-1" />
                {createPeriodMut.isPending ? "Creating…" : "Add period"}
              </Button>
            </div>
          )}
          {periods.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No accounting periods defined yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Label</TableHead>
                    <TableHead className="w-[140px]">Start</TableHead>
                    <TableHead className="w-[140px]">End</TableHead>
                    <TableHead className="w-[120px]">Status</TableHead>
                    <TableHead className="w-[180px]">Closed at</TableHead>
                    <TableHead className="w-[120px] text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((p) => (
                    <TableRow
                      key={p.id}
                      data-testid={`row-period-${p.id}`}
                    >
                      <TableCell className="font-medium">{p.label}</TableCell>
                      <TableCell>
                        {format(parseDateOnly(p.periodStart), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        {format(parseDateOnly(p.periodEnd), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        {p.status === "closed" ? (
                          <Badge
                            variant="destructive"
                            className="gap-1"
                            data-testid={`badge-period-status-${p.id}`}
                          >
                            <Lock className="h-3 w-3" />
                            Closed
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="gap-1"
                            data-testid={`badge-period-status-${p.id}`}
                          >
                            <Unlock className="h-3 w-3" />
                            Open
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.closedAt
                          ? format(new Date(p.closedAt), "MMM d, p")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {isAdmin && p.status === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => closePeriod(p.id, p.label)}
                            disabled={closePeriodMut.isPending}
                            data-testid={`button-close-period-${p.id}`}
                          >
                            <Lock className="h-4 w-4 mr-1" />
                            Close
                          </Button>
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

      <Card id="drafts" className="scroll-mt-20">
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileEdit className="h-4 w-4 text-muted-foreground" />
              Drafts
            </CardTitle>
            <CardDescription>
              Saved work-in-progress entries that have not been posted yet.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={draftStatusFilter}
              onValueChange={(v) =>
                setDraftStatusFilter(v as DraftStatusFilter)
              }
            >
              <SelectTrigger
                className="w-[160px]"
                data-testid="select-draft-status-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={draftScope}
              onValueChange={(v) => setDraftScope(v as DraftScope)}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">My drafts</SelectItem>
                <SelectItem value="all">All drafts</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {draftsLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : drafts.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              {draftScope === "mine"
                ? "You don't have any saved drafts."
                : "No saved drafts."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Status</TableHead>
                    <TableHead className="w-[120px]">Entry date</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead className="w-[180px]">Saved by</TableHead>
                    <TableHead className="w-[160px]">Last updated</TableHead>
                    <TableHead className="w-[200px] text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drafts.map((d) => {
                    const ownerName =
                      [d.createdBy.firstName, d.createdBy.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                      d.createdBy.email ||
                      `User #${d.createdBy.id}`;
                    const editable =
                      d.status === "draft" || d.status === "rejected";
                    const openLabel =
                      d.status === "posted"
                        ? "View"
                        : d.status === "submitted" || d.status === "approved"
                          ? "Review"
                          : "Open";
                    return (
                      <TableRow
                        key={d.id}
                        data-testid={`row-draft-${d.id}`}
                      >
                        <TableCell data-testid={`text-draft-status-${d.id}`}>
                          <DraftStatusBadge status={d.status} />
                        </TableCell>
                        <TableCell>
                          {d.entryDate
                            ? format(parseDateOnly(d.entryDate), "MMM d, yyyy")
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="max-w-[420px]">
                          <div className="truncate" title={d.memo ?? ""}>
                            {d.memo ?? <span className="text-muted-foreground">(no memo yet)</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{ownerName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(d.updatedAt), "MMM d, p")}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              data-testid={`button-open-draft-${d.id}`}
                            >
                              <Link href={`/accounting/journal-entry-drafts/${d.id}`}>
                                {openLabel}
                              </Link>
                            </Button>
                            {editable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => discardDraft(d.id, d.version)}
                                data-testid={`button-discard-draft-${d.id}`}
                                title="Discard draft"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Entries</CardTitle>
            <CardDescription>
              {loading
                ? "Loading…"
                : total === 0
                  ? "No entries match the current filters."
                  : `Showing ${startIdx}–${endIdx} of ${total}`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <label
              className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none"
              title="One row per journal entry line, with account, debit, credit, program, fund, and memo."
            >
              <Checkbox
                checked={includeLines}
                onCheckedChange={(v) => setIncludeLines(v === true)}
                data-testid="checkbox-include-lines"
              />
              Include lines
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadCsv}
              disabled={exporting || loading || total === 0}
              data-testid="button-download-csv"
            >
              <Download className="h-4 w-4 mr-1" />
              {exporting ? "Exporting…" : "Download CSV"}
            </Button>
            {user?.role === "admin" ? (
              <Button
                asChild
                variant="ghost"
                size="sm"
                data-testid="button-schedule-exports"
              >
                <Link href="/accounting/journal-export-schedules">
                  Schedule exports
                </Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && !loading && (
            <p className="text-sm text-destructive p-4">{error}</p>
          )}
          {loading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : entries.length === 0 && !error ? (
            <div className="p-12">
              <Empty
                icon={BookOpen}
                title="No journal entries"
                description={
                  filtersActive
                    ? "Try clearing the filters to see more entries."
                    : "Post a manual entry or approve a copilot draft to populate the ledger."
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Entry no</TableHead>
                    <TableHead className="w-[120px]">Entry date</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead className="w-[140px] text-right">Total</TableHead>
                    <TableHead className="w-[110px]">Source</TableHead>
                    <TableHead className="w-[140px]">Period</TableHead>
                    <TableHead className="w-[110px]">Status</TableHead>
                    <TableHead className="w-[160px]">Posted</TableHead>
                    <TableHead className="w-[180px]">Posted by</TableHead>
                    <TableHead className="w-[100px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => {
                    const src = entrySource(e);
                    return (
                      <TableRow
                        key={e.id}
                        data-testid={`row-je-${e.id}`}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() =>
                          setLocation(`/accounting/journal-entries/${e.id}`)
                        }
                      >
                        <TableCell className="font-mono text-sm">
                          {e.entryNo}
                        </TableCell>
                        <TableCell>
                          {format(parseDateOnly(e.entryDate), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="max-w-[420px]">
                          <div className="truncate" title={e.memo}>
                            {e.memo}
                          </div>
                          {e.reversesJournalEntryId && (
                            <div className="text-xs text-muted-foreground">
                              Reverses #{e.reversesJournalEntryId}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCents(e.totalsDebitsCents)}
                        </TableCell>
                        <TableCell>
                          {src === "copilot" ? (
                            <Badge variant="secondary" className="gap-1">
                              <Sparkles className="h-3 w-3" />
                              Copilot
                            </Badge>
                          ) : src === "expense" ? (
                            e.originatingExpense ? (
                              <Link
                                href={`/expenses/${e.originatingExpense.id}`}
                                onClick={(ev) => ev.stopPropagation()}
                                data-testid={`link-source-expense-${e.id}`}
                              >
                                <Badge
                                  variant="secondary"
                                  className="gap-1 hover:underline"
                                >
                                  Expense #{e.originatingExpense.id}
                                </Badge>
                              </Link>
                            ) : (
                              <Badge variant="secondary" className="gap-1">
                                Expense
                              </Badge>
                            )
                          ) : src === "bill" ? (
                            e.originatingBill ? (
                              <Link
                                href={`/bills/${e.originatingBill.id}`}
                                onClick={(ev) => ev.stopPropagation()}
                                data-testid={`link-source-bill-${e.id}`}
                              >
                                <Badge
                                  variant="secondary"
                                  className="gap-1 hover:underline"
                                >
                                  Bill #{e.originatingBill.id} (
                                  {e.originatingBill.eventType === "accrual"
                                    ? "Accrual"
                                    : "Payment"}
                                  )
                                </Badge>
                              </Link>
                            ) : (
                              <Badge variant="secondary" className="gap-1">
                                Bill
                              </Badge>
                            )
                          ) : (
                            <Badge variant="outline" className="gap-1">
                              <User className="h-3 w-3" />
                              Manual
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell data-testid={`text-period-${e.id}`}>
                          {e.period ? (
                            e.period.status === "closed" ? (
                              <Badge
                                variant="destructive"
                                className="gap-1"
                                title="This period is closed — entries within it are locked."
                              >
                                <Lock className="h-3 w-3" />
                                {e.period.label}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="gap-1">
                                <Unlock className="h-3 w-3" />
                                {e.period.label}
                              </Badge>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {e.status === "posted" ? (
                            <Badge>Posted</Badge>
                          ) : (
                            <Badge variant="destructive">Reversed</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(e.postedAt), "MMM d, p")}
                        </TableCell>
                        <TableCell
                          className="text-sm"
                          data-testid={`text-posted-by-${e.id}`}
                        >
                          <div
                            className="truncate"
                            title={e.postedBy?.email ?? undefined}
                          >
                            {actorName(e.postedBy)}
                          </div>
                          {src === "copilot" && e.approver && (
                            <div
                              className="text-xs text-muted-foreground truncate"
                              title={e.approver.email ?? undefined}
                              data-testid={`text-approver-${e.id}`}
                            >
                              Approved by {actorName(e.approver)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/accounting/journal-entries/${e.id}`}>
                              View
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {(hasNext || hasPrev) && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
