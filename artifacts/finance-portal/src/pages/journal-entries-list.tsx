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
import { apiJson } from "@/lib/api";
import { format } from "date-fns";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowLeft,
  BookOpen,
  Download,
  FileEdit,
  Filter,
  Plus,
  Sparkles,
  Trash2,
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
  // Task #53 — backend-derived source: 'expense' wins over 'copilot'
  // wins over 'manual'. Use this instead of the agentActionId heuristic.
  source?: "manual" | "copilot" | "expense";
};

function actorName(a: EntryActor | null): string {
  if (!a) return "—";
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  return name || a.email || `User #${a.id}`;
}

type StatusFilter = "all" | "posted" | "reversed";
type SourceFilter = "all" | "manual" | "copilot" | "expense";
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

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [includeLines, setIncludeLines] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftScope, setDraftScope] = useState<DraftScope>("mine");
  const [draftStatusFilter, setDraftStatusFilter] =
    useState<DraftStatusFilter>("all");
  const [draftRefreshKey, setDraftRefreshKey] = useState(0);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setDraftsLoading(true);
    apiJson<{ drafts: DraftSummary[] }>(
      `/accounting/journal-entry-drafts?scope=${draftScope}`,
    )
      .then((data) => {
        if (!cancelled) {
          const filtered =
            draftStatusFilter === "all"
              ? data.drafts
              : data.drafts.filter((d) => d.status === draftStatusFilter);
          setDrafts(filtered);
        }
      })
      .catch(() => {
        if (!cancelled) setDrafts([]);
      })
      .finally(() => {
        if (!cancelled) setDraftsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canView, draftScope, draftStatusFilter, draftRefreshKey]);

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
      await apiJson<null>(
        `/accounting/journal-entry-drafts/${id}?expectedVersion=${version}`,
        { method: "DELETE" },
      );
      toast({ title: "Draft discarded" });
      setDraftRefreshKey((k) => k + 1);
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

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (source !== "all") p.set("source", source);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [status, source, from, to, page]);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<{ entries: JournalEntry[]; total: number }>(
      `/accounting/journal-entries?${queryString}`,
    )
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
        setTotal(data.total);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Failed to load journal entries.";
        setError(msg);
        toast({
          title: "Could not load journal entries",
          description: msg,
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString, canView, toast]);

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

      <Card>
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
                            <Badge variant="secondary" className="gap-1">
                              Expense
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1">
                              <User className="h-3 w-3" />
                              Manual
                            </Badge>
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
