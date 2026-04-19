import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { format } from "date-fns";
import { ArrowLeft, BookOpen, Sparkles, User } from "lucide-react";

type JournalEntryLine = {
  id: number;
  lineNo: number;
  type: "debit" | "credit";
  amountCents: number;
  account: string;
  accountId: number | null;
  program: string | null;
  fund: string | null;
  memo: string | null;
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
  postedByUserId: number;
  agentActionId: number | null;
  threadId: number | null;
  assistantMessageId: number | null;
  approverUserId: number | null;
  evidenceSnapshot: unknown;
  reversesJournalEntryId: number | null;
  reversedByJournalEntryId: number | null;
  reversalReason: string | null;
  createdAt: string;
  lines: JournalEntryLine[];
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export default function JournalEntryDetailPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, params] = useRoute<{ id: string }>("/accounting/journal-entries/:id");
  const id = params?.id;

  const canView = user?.role === "admin" || user?.role === "approver";

  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView || !id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<{ journalEntry: JournalEntry }>(
      `/accounting/journal-entries/${id}`,
    )
      .then((data) => {
        if (cancelled) return;
        setEntry(data.journalEntry);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Failed to load entry.";
        setError(msg);
        toast({
          title: "Could not load entry",
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
  }, [id, canView, toast]);

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Journal entry</h1>
        <p className="text-muted-foreground">
          Only admins and approvers can view posted journal entries.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !entry) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/accounting/journal-entries">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to journal entries
          </Link>
        </Button>
        <p className="text-destructive">
          {error ?? "Journal entry not found."}
        </p>
      </div>
    );
  }

  const source: "manual" | "copilot" =
    entry.agentActionId !== null ? "copilot" : "manual";

  const evidenceJson =
    entry.evidenceSnapshot !== null && entry.evidenceSnapshot !== undefined
      ? JSON.stringify(entry.evidenceSnapshot, null, 2)
      : null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-7 w-7 text-primary" />
            {entry.entryNo}
          </h1>
          <p className="text-muted-foreground mt-1">{entry.memo}</p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/accounting/journal-entries">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to list
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Header</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Entry date
            </div>
            <div className="font-medium">
              {format(parseDateOnly(entry.entryDate), "MMM d, yyyy")}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Posted
            </div>
            <div className="font-medium">
              {format(new Date(entry.postedAt), "MMM d, yyyy p")}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Source
            </div>
            <div>
              {source === "copilot" ? (
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
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Status
            </div>
            <div>
              {entry.status === "posted" ? (
                <Badge>Posted</Badge>
              ) : (
                <Badge variant="destructive">Reversed</Badge>
              )}
            </div>
          </div>
          {entry.reversesJournalEntryId && (
            <div className="md:col-span-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Reverses
              </div>
              <Link
                className="text-primary underline"
                href={`/accounting/journal-entries/${entry.reversesJournalEntryId}`}
              >
                Entry #{entry.reversesJournalEntryId}
              </Link>
            </div>
          )}
          {entry.reversedByJournalEntryId && (
            <div className="md:col-span-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Reversed by
              </div>
              <Link
                className="text-primary underline"
                href={`/accounting/journal-entries/${entry.reversedByJournalEntryId}`}
              >
                Entry #{entry.reversedByJournalEntryId}
              </Link>
            </div>
          )}
          {entry.reversalReason && (
            <div className="md:col-span-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Reversal reason
              </div>
              <div>{entry.reversalReason}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
          <CardDescription>
            Debits and credits balance to{" "}
            <span className="font-mono">
              {formatCents(entry.totalsDebitsCents)}
            </span>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">#</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right w-[140px]">Debit</TableHead>
                  <TableHead className="text-right w-[140px]">Credit</TableHead>
                  <TableHead className="w-[140px]">Program</TableHead>
                  <TableHead className="w-[140px]">Fund</TableHead>
                  <TableHead>Memo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entry.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-muted-foreground">
                      {l.lineNo}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {l.account}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {l.type === "debit" ? formatCents(l.amountCents) : ""}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {l.type === "credit" ? formatCents(l.amountCents) : ""}
                    </TableCell>
                    <TableCell>{l.program ?? ""}</TableCell>
                    <TableCell>{l.fund ?? ""}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {l.memo ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell colSpan={2} className="text-right">
                    Totals
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCents(entry.totalsDebitsCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCents(entry.totalsCreditsCents)}
                  </TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evidence snapshot</CardTitle>
          <CardDescription>
            Frozen at the moment of posting — what the approver actually saw.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {evidenceJson ? (
            <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[480px] overflow-y-auto">
              {evidenceJson}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              No evidence snapshot was attached to this entry.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
