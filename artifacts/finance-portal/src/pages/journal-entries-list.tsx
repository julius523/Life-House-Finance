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
import { ArrowLeft, BookOpen, Filter, Plus, Sparkles, User } from "lucide-react";

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
};

type StatusFilter = "all" | "posted" | "reversed";
type SourceFilter = "all" | "manual" | "copilot";

const PAGE_SIZE = 50;

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function entrySource(e: JournalEntry): "manual" | "copilot" {
  return e.agentActionId !== null ? "copilot" : "manual";
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
            <CardTitle className="text-base">Entries</CardTitle>
            <CardDescription>
              {loading
                ? "Loading…"
                : total === 0
                  ? "No entries match the current filters."
                  : `Showing ${startIdx}–${endIdx} of ${total}`}
            </CardDescription>
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
