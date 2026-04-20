import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  useListJournalEntries,
  useListJournalEntryDrafts,
  useDeleteJournalEntryDraft,
  useListJournalEntryActors,
  useListAccountingPeriods,
  useCreateAccountingPeriod,
  useCloseAccountingPeriod,
  getListJournalEntryDraftsQueryKey,
  getListAccountingPeriodsQueryKey,
  ListJournalEntriesStatus,
  ListJournalEntriesSource,
  type ListJournalEntriesParams,
  type ListJournalEntryDraftsParams,
  type AuthUser,
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

// Task #72 — keep filter state shareable via URL query string. Reading the
// initial state from the URL on mount means a link like
// `/accounting/journal-entries?approver=12&status=posted` restores those
// dropdowns; writing the state back on every change makes the URL the
// source of truth so browser back/forward replays the filter history.
function readFiltersFromSearch(search: string): {
  status: StatusFilter;
  source: SourceFilter;
  from: string;
  to: string;
  postedBy: string;
  approver: string;
} {
  const p = new URLSearchParams(search);
  const rawStatus = p.get("status");
  const rawSource = p.get("source");
  const rawPostedBy = p.get("postedBy");
  const rawApprover = p.get("approver");
  const status: StatusFilter =
    rawStatus === "posted" || rawStatus === "reversed" ? rawStatus : "all";
  const source: SourceFilter =
    rawSource === "manual" ||
    rawSource === "copilot" ||
    rawSource === "expense" ||
    rawSource === "bill"
      ? rawSource
      : "all";
  return {
    status,
    source,
    from: p.get("from") ?? "",
    to: p.get("to") ?? "",
    postedBy: rawPostedBy && /^\d+$/.test(rawPostedBy) ? rawPostedBy : "any",
    approver: rawApprover && /^\d+$/.test(rawApprover) ? rawApprover : "any",
  };
}

function buildFiltersSearch(f: {
  status: StatusFilter;
  source: SourceFilter;
  from: string;
  to: string;
  postedBy: string;
  approver: string;
}): string {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.source !== "all") p.set("source", f.source);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.postedBy !== "any") p.set("postedBy", f.postedBy);
  if (f.approver !== "any") p.set("approver", f.approver);
  return p.toString();
}

// Task #82 — page index is also part of the shareable link. We use a
// 1-based `page` query param (so `?page=2` reads naturally), but keep
// the in-component representation 0-based to match the offset math the
// list API expects. page=1 is the default and stays out of the URL.
function readPageFromSearch(search: string): number {
  const p = new URLSearchParams(search);
  const raw = p.get("page");
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n >= 1 ? n - 1 : 0;
}

export default function JournalEntriesListPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const canView = user?.role === "admin" || user?.role === "approver";

  // Task #72 — the URL query string is the single source of truth for the
  // filters. Reading derived state on every render means browser back/forward
  // (which fires popstate → useSearch update) just works without effect
  // ping-pong, and a shared link hydrates the controls on first render.
  const filters = useMemo(() => readFiltersFromSearch(search), [search]);
  const { status, source, from, to, postedBy: postedByFilter, approver: approverFilter } = filters;
  // Task #82 — page index lives in the URL alongside the filters so a
  // shared link lands on the same page the sender was looking at.
  const page = useMemo(() => readPageFromSearch(search), [search]);

  const updateFilters = useCallback(
    (
      patch: Partial<ReturnType<typeof readFiltersFromSearch>>,
      opts: { replace?: boolean } = {},
    ) => {
      // Task #82 — changing any filter resets to page 1. We do this by
      // simply not carrying the `page` param forward in the rebuilt URL.
      const next = buildFiltersSearch({ ...filters, ...patch });
      const path = window.location.pathname;
      setLocation(next ? `${path}?${next}` : path, { replace: opts.replace });
    },
    [filters, setLocation],
  );

  const setPage = useCallback(
    (updater: number | ((p: number) => number)) => {
      const nextPage =
        typeof updater === "function" ? updater(page) : updater;
      const filterStr = buildFiltersSearch(filters);
      const params = new URLSearchParams(filterStr);
      if (nextPage > 0) params.set("page", String(nextPage + 1));
      const path = window.location.pathname;
      const qs = params.toString();
      setLocation(qs ? `${path}?${qs}` : path);
    },
    [filters, page, setLocation],
  );

  const setStatus = useCallback(
    (v: StatusFilter) => updateFilters({ status: v }),
    [updateFilters],
  );
  const setSource = useCallback(
    (v: SourceFilter) => updateFilters({ source: v }),
    [updateFilters],
  );
  // Date inputs fire onChange on every keystroke, so use replace to keep the
  // history stack readable. The shared link still captures the final value.
  const setFrom = useCallback(
    (v: string) => updateFilters({ from: v }, { replace: true }),
    [updateFilters],
  );
  const setTo = useCallback(
    (v: string) => updateFilters({ to: v }, { replace: true }),
    [updateFilters],
  );
  const setPostedByFilter = useCallback(
    (v: string) => updateFilters({ postedBy: v }),
    [updateFilters],
  );
  const setApproverFilter = useCallback(
    (v: string) => updateFilters({ approver: v }),
    [updateFilters],
  );

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

  // Task #66 — closing a period that contains in-flight drafts (status
  // draft/submitted/approved) would silently make those drafts un-postable.
  // The server is the source of truth: we always attempt the close without
  // acknowledgement first; if drafts exist, the server returns a 409 with
  // the authoritative list. We surface that list in a dialog and only
  // re-send the close with acknowledgeOpenDrafts=true after the admin
  // explicitly confirms.
  type OpenDraftRow = {
    id: number;
    status: "draft" | "submitted" | "approved";
    entryDate: string | null;
    memo: string | null;
  };
  type OpenDraftsConflict = {
    period: AccountingPeriod;
    openDraftsCount: number;
    openDrafts: OpenDraftRow[];
  };
  const [closeConflict, setCloseConflict] =
    useState<OpenDraftsConflict | null>(null);
  const [closingPeriodId, setClosingPeriodId] = useState<number | null>(null);

  const isOpenDraftsConflict = (
    err: unknown,
  ): err is { status: 409; data: { code: string; openDraftsCount?: number; openDrafts?: OpenDraftRow[] } } => {
    if (!err || typeof err !== "object") return false;
    const e = err as { status?: unknown; data?: unknown };
    if (e.status !== 409) return false;
    const data = e.data as { code?: unknown } | null | undefined;
    return !!data && data.code === "OPEN_DRAFTS_EXIST";
  };

  const closePeriodWithAck = async (
    period: AccountingPeriod,
    acknowledgeOpenDrafts: boolean,
  ) => {
    setClosingPeriodId(period.id);
    try {
      await closePeriodMut.mutateAsync({
        id: period.id,
        data: acknowledgeOpenDrafts ? { acknowledgeOpenDrafts: true } : {},
      });
      toast({ title: "Period closed" });
      refreshPeriods();
      setCloseConflict(null);
    } catch (err) {
      if (isOpenDraftsConflict(err)) {
        const data = err.data;
        setCloseConflict({
          period,
          openDraftsCount:
            typeof data.openDraftsCount === "number"
              ? data.openDraftsCount
              : Array.isArray(data.openDrafts)
                ? data.openDrafts.length
                : 0,
          openDrafts: Array.isArray(data.openDrafts) ? data.openDrafts : [],
        });
      } else {
        toast({
          title: "Could not close period",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
        setCloseConflict(null);
      }
    } finally {
      setClosingPeriodId(null);
    }
  };

  const requestClosePeriod = (period: AccountingPeriod) => {
    void closePeriodWithAck(period, false);
  };

  const confirmClosePeriod = () => {
    if (!closeConflict) return;
    void closePeriodWithAck(closeConflict.period, true);
  };

  const cancelClosePeriod = () => {
    if (closePeriodMut.isPending) return;
    setCloseConflict(null);
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

  // Task #82 — no effect needed to reset the page on filter change:
  // updateFilters rebuilds the URL without the `page` param, so the
  // derived page index naturally falls back to 0.

  // Task #50 — fetch the distinct posters/approvers so the pickers show
  // only people who have actually touched a journal entry.
  const { data: actorsData } = useListJournalEntryActors({
    query: { enabled: canView },
  });
  const posters = (actorsData?.posters ?? []) as AuthUser[];
  const approvers = (actorsData?.approvers ?? []) as AuthUser[];

  const postedByUserId =
    postedByFilter !== "any" && /^\d+$/.test(postedByFilter)
      ? Number(postedByFilter)
      : null;
  const approverUserId =
    approverFilter !== "any" && /^\d+$/.test(approverFilter)
      ? Number(approverFilter)
      : null;

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
    if (postedByUserId !== null) p.postedBy = postedByUserId;
    if (approverUserId !== null) p.approver = approverUserId;
    return p;
  }, [status, source, from, to, postedByUserId, approverUserId, page]);

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
    // Single update so the cleared state is one history entry, not six.
    updateFilters({
      status: "all",
      source: "all",
      from: "",
      to: "",
      postedBy: "any",
      approver: "any",
    });
  };

  const filtersActive =
    status !== "all" ||
    source !== "all" ||
    from !== "" ||
    to !== "" ||
    postedByFilter !== "any" ||
    approverFilter !== "any";

  const downloadCsv = async () => {
    setExporting(true);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (source !== "all") p.set("source", source);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (postedByUserId !== null) p.set("postedBy", String(postedByUserId));
      if (approverUserId !== null) p.set("approver", String(approverUserId));
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
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
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
          <div className="space-y-1.5">
            <Label>Posted by</Label>
            <Select
              value={postedByFilter}
              onValueChange={setPostedByFilter}
            >
              <SelectTrigger data-testid="select-posted-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Anyone</SelectItem>
                {posters.map((u) => (
                  <SelectItem
                    key={u.id}
                    value={String(u.id)}
                    data-testid={`option-posted-by-${u.id}`}
                  >
                    {actorName({
                      id: u.id,
                      firstName: u.firstName ?? null,
                      lastName: u.lastName ?? null,
                      email: u.email ?? null,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Approver</Label>
            <Select
              value={approverFilter}
              onValueChange={setApproverFilter}
            >
              <SelectTrigger data-testid="select-approver">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Anyone</SelectItem>
                {approvers.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    No copilot approvals yet
                  </SelectItem>
                ) : (
                  approvers.map((u) => (
                    <SelectItem
                      key={u.id}
                      value={String(u.id)}
                      data-testid={`option-approver-${u.id}`}
                    >
                      {actorName({
                        id: u.id,
                        firstName: u.firstName ?? null,
                        lastName: u.lastName ?? null,
                        email: u.email ?? null,
                      })}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2 flex md:justify-end">
            <Button
              variant="outline"
              onClick={clearFilters}
              disabled={!filtersActive}
              className="w-full md:w-auto"
              data-testid="button-clear-filters"
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
                            onClick={() => requestClosePeriod(p)}
                            disabled={
                              closePeriodMut.isPending &&
                              closingPeriodId === p.id
                            }
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

      <AlertDialog
        open={closeConflict !== null}
        onOpenChange={(open) => {
          if (!open) cancelClosePeriod();
        }}
      >
        <AlertDialogContent
          className="max-w-2xl"
          data-testid="dialog-close-period-confirm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close period &ldquo;{closeConflict?.period.label}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Once closed, no journal entries dated between{" "}
              {closeConflict
                ? format(
                    parseDateOnly(closeConflict.period.periodStart),
                    "MMM d, yyyy",
                  )
                : ""}{" "}
              and{" "}
              {closeConflict
                ? format(
                    parseDateOnly(closeConflict.period.periodEnd),
                    "MMM d, yyyy",
                  )
                : ""}{" "}
              can be posted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {closeConflict && (
            <div
              className="space-y-2"
              data-testid="warning-close-period-open-drafts"
            >
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <div
                  className="font-medium text-destructive"
                  data-testid="text-close-period-open-drafts-count"
                >
                  {closeConflict.openDraftsCount} open draft
                  {closeConflict.openDraftsCount === 1 ? "" : "s"} fall within
                  this period and will become un-postable if you close it.
                </div>
                <div className="mt-1 text-muted-foreground">
                  Resolve them first (post, reject, or delete), or proceed
                  knowing they will be stranded.
                  {closeConflict.openDrafts.length <
                    closeConflict.openDraftsCount && (
                    <>
                      {" "}
                      Showing the first {closeConflict.openDrafts.length} of{" "}
                      {closeConflict.openDraftsCount}.
                    </>
                  )}
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Draft</TableHead>
                      <TableHead className="w-[120px]">Status</TableHead>
                      <TableHead className="w-[120px]">Date</TableHead>
                      <TableHead>Memo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closeConflict.openDrafts.map((d) => (
                      <TableRow
                        key={d.id}
                        data-testid={`row-close-period-open-draft-${d.id}`}
                      >
                        <TableCell>
                          <Link
                            href={`/accounting/journal-entry-drafts/${d.id}`}
                            className="text-primary underline-offset-2 hover:underline"
                            data-testid={`link-close-period-open-draft-${d.id}`}
                          >
                            #{d.id}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">
                            {d.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {d.entryDate
                            ? format(
                                parseDateOnly(d.entryDate),
                                "MMM d, yyyy",
                              )
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground truncate max-w-[260px]">
                          {d.memo ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={closePeriodMut.isPending}
              data-testid="button-close-period-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmClosePeriod();
              }}
              disabled={closePeriodMut.isPending}
              data-testid="button-close-period-confirm"
            >
              {closeConflict
                ? `Close anyway (${closeConflict.openDraftsCount} draft${
                    closeConflict.openDraftsCount === 1 ? "" : "s"
                  } stranded)`
                : "Close period"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
