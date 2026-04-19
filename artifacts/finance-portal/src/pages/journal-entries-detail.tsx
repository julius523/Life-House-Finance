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
  postedByUserId: number;
  postedBy: EntryActor | null;
  agentActionId: number | null;
  threadId: number | null;
  assistantMessageId: number | null;
  approverUserId: number | null;
  approver: EntryActor | null;
  evidenceSnapshot: unknown;
  reversesJournalEntryId: number | null;
  reversedByJournalEntryId: number | null;
  reversalReason: string | null;
  manualDraftId: number | null;
  createdAt: string;
  lines: JournalEntryLine[];
  // Task #53 — populated by the backend from accounting_source_links
  // (and the legacy agentActionId fallback). Use this directly instead
  // of inferring from agentActionId so 'expense' surfaces correctly.
  source?: "manual" | "copilot" | "expense" | "bill";
  originatingExpense?: {
    id: number;
    merchant: string;
    amount: number;
    expenseDate: string;
    status: string;
    programId: number | null;
    programName: string | null;
    submitter: {
      name: string;
      email: string | null;
    } | null;
    approvedAt: string | null;
  } | null;
  // Task #63 — bill-sourced JEs surface vendor / leg / amount so reviewers
  // can confirm the entry without opening the bill.
  originatingBill?: {
    id: number;
    eventType: "accrual" | "payment";
    vendorId: number;
    vendorName: string;
    amount: number;
    invoiceDate: string | null;
    dueDate: string;
    status: string;
    programId: number | null;
    programName: string | null;
    categoryId: number | null;
    categoryName: string | null;
    approvedAt: string | null;
  } | null;
};

function actorName(a: EntryActor | null): string {
  if (!a) return "—";
  const name = [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  return name || a.email || `User #${a.id}`;
}

type ApprovalEvent = {
  id: number;
  type:
    | "manual_je_draft_created"
    | "manual_je_draft_edited"
    | "manual_je_draft_submitted"
    | "manual_je_draft_approved"
    | "manual_je_draft_rejected"
    | "manual_je_draft_posted"
    | string;
  description: string;
  actor: string;
  actorUserId: number | null;
  actorEmail: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

const EVENT_LABELS: Record<string, string> = {
  manual_je_draft_created: "Created",
  manual_je_draft_edited: "Edited",
  manual_je_draft_submitted: "Submitted for review",
  manual_je_draft_approved: "Approved",
  manual_je_draft_rejected: "Rejected",
  manual_je_draft_posted: "Posted to ledger",
};

function eventLabel(t: string): string {
  return EVENT_LABELS[t] ?? t;
}

function actorDisplay(ev: ApprovalEvent): string {
  const name = [ev.actorFirstName, ev.actorLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) return name;
  if (ev.actorEmail) return ev.actorEmail;
  if (ev.actor) return ev.actor;
  if (ev.actorUserId) return `User #${ev.actorUserId}`;
  return "System";
}

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
  const [history, setHistory] = useState<ApprovalEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!canView || !id || !entry || entry.manualDraftId === null) {
      setHistory(null);
      setHistoryError(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    apiJson<{ events: ApprovalEvent[] }>(
      `/accounting/journal-entries/${id}/approval-history`,
    )
      .then((data) => {
        if (cancelled) return;
        setHistory(data.events);
      })
      .catch((e) => {
        if (cancelled) return;
        setHistoryError(
          e instanceof Error ? e.message : "Failed to load approval history.",
        );
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, canView, entry]);

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

  // Task #53 — prefer the backend's `source` field (manual|copilot|expense)
  // over the legacy agentActionId heuristic so expense-derived entries
  // surface as such.
  const source: "manual" | "copilot" | "expense" =
    entry.source ?? (entry.agentActionId !== null ? "copilot" : "manual");

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
              ) : source === "expense" ? (
                <Badge variant="secondary" className="gap-1">
                  Expense
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
          <div data-testid="text-posted-by">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Posted by
            </div>
            <div
              className="font-medium"
              title={entry.postedBy?.email ?? undefined}
            >
              {actorName(entry.postedBy)}
            </div>
          </div>
          {source === "copilot" && (
            <div data-testid="text-approver">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Approver
              </div>
              <div
                className="font-medium"
                title={entry.approver?.email ?? undefined}
              >
                {actorName(entry.approver)}
              </div>
            </div>
          )}
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

      {/*
        Task #53 — Originating expense card. Renders only when this
        entry was posted from an expense (via accounting_source_links).
      */}
      {entry.originatingExpense && (
        <Card data-testid="card-originating-expense">
          <CardHeader>
            <CardTitle className="text-base">Originating expense</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Expense
              </div>
              <Link
                href={`/expenses/${entry.originatingExpense.id}`}
                className="font-medium text-primary hover:underline"
                data-testid="link-originating-expense"
              >
                #{entry.originatingExpense.id}
              </Link>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Merchant
              </div>
              <div className="font-medium">
                {entry.originatingExpense.merchant}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Date
              </div>
              <div className="font-medium">
                {format(
                  parseDateOnly(entry.originatingExpense.expenseDate),
                  "MMM d, yyyy",
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Amount
              </div>
              <div className="font-medium font-mono">
                ${entry.originatingExpense.amount.toFixed(2)}
              </div>
            </div>
            {entry.originatingExpense.programName && (
              <div data-testid="text-originating-expense-program">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Program
                </div>
                <div className="font-medium">
                  {entry.originatingExpense.programName}
                </div>
              </div>
            )}
            {entry.originatingExpense.submitter && (
              <div
                className="md:col-span-2"
                data-testid="text-originating-expense-submitter"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Submitter
                </div>
                <div className="font-medium">
                  {entry.originatingExpense.submitter.name ||
                    entry.originatingExpense.submitter.email ||
                    "—"}
                </div>
                {entry.originatingExpense.submitter.email &&
                  entry.originatingExpense.submitter.email !==
                    entry.originatingExpense.submitter.name && (
                    <div className="text-xs text-muted-foreground">
                      {entry.originatingExpense.submitter.email}
                    </div>
                  )}
              </div>
            )}
            {entry.originatingExpense.approvedAt && (
              <div data-testid="text-originating-expense-approved-at">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Approved
                </div>
                <div className="font-medium">
                  {format(
                    new Date(entry.originatingExpense.approvedAt),
                    "MMM d, yyyy",
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Task #63 — Originating bill card (parallel to expense card). */}
      {entry.originatingBill && (
        <Card data-testid="card-originating-bill">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Originating bill</CardTitle>
              <Badge
                variant="outline"
                className="capitalize"
                data-testid="badge-bill-event-type"
              >
                {entry.originatingBill.eventType}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Bill
              </div>
              <Link
                href={`/bills/${entry.originatingBill.id}`}
                className="font-medium text-primary hover:underline"
                data-testid="link-originating-bill"
              >
                #{entry.originatingBill.id}
              </Link>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Vendor
              </div>
              <div className="font-medium">
                {entry.originatingBill.vendorName || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {entry.originatingBill.invoiceDate ? "Invoice date" : "Due date"}
              </div>
              <div className="font-medium">
                {format(
                  parseDateOnly(
                    entry.originatingBill.invoiceDate ??
                      entry.originatingBill.dueDate,
                  ),
                  "MMM d, yyyy",
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Amount
              </div>
              <div className="font-medium font-mono">
                ${entry.originatingBill.amount.toFixed(2)}
              </div>
            </div>
            {entry.originatingBill.categoryName && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Category
                </div>
                <div className="font-medium">
                  {entry.originatingBill.categoryName}
                </div>
              </div>
            )}
            {entry.originatingBill.programName && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Program
                </div>
                <div className="font-medium">
                  {entry.originatingBill.programName}
                </div>
              </div>
            )}
            {entry.originatingBill.approvedAt && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Approved
                </div>
                <div className="font-medium">
                  {format(
                    new Date(entry.originatingBill.approvedAt),
                    "MMM d, yyyy",
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      {entry.manualDraftId !== null && (
        <Card data-testid="card-approval-history">
          <CardHeader>
            <CardTitle className="text-base">Approval history</CardTitle>
            <CardDescription>
              Full chain from draft through posting for manual draft #
              {entry.manualDraftId}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {historyLoading && !history ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-6 w-3/5" />
              </div>
            ) : historyError ? (
              <p className="text-sm text-destructive">{historyError}</p>
            ) : !history || history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approval events recorded for this draft.
              </p>
            ) : (
              <ol
                className="relative border-l border-border ml-3 space-y-4"
                data-testid="list-approval-history"
              >
                {history.map((ev) => {
                  let reason: string | null = null;
                  if (ev.type === "manual_je_draft_rejected") {
                    const fromMeta =
                      ev.metadata &&
                      typeof (ev.metadata as Record<string, unknown>)[
                        "reason"
                      ] === "string"
                        ? ((ev.metadata as Record<string, unknown>)[
                            "reason"
                          ] as string)
                        : null;
                    if (fromMeta) {
                      reason = fromMeta;
                    } else {
                      // Fallback for events logged before the metadata.reason
                      // field was added: parse from the description, which
                      // is shaped "<actor> rejected manual JE draft #N: <reason>".
                      const idx = ev.description.indexOf(": ");
                      reason =
                        idx >= 0 ? ev.description.slice(idx + 2).trim() : null;
                    }
                  }
                  const dotClass =
                    ev.type === "manual_je_draft_rejected"
                      ? "bg-destructive"
                      : ev.type === "manual_je_draft_posted"
                        ? "bg-primary"
                        : ev.type === "manual_je_draft_approved"
                          ? "bg-green-600"
                          : "bg-muted-foreground";
                  return (
                    <li
                      key={ev.id}
                      className="ml-6"
                      data-testid={`history-event-${ev.id}`}
                    >
                      <span
                        className={`absolute -left-[7px] flex h-3 w-3 items-center justify-center rounded-full ${dotClass} ring-2 ring-background`}
                      />
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-medium">
                          {eventLabel(ev.type)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          by {actorDisplay(ev)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          · {format(new Date(ev.createdAt), "MMM d, yyyy p")}
                        </span>
                      </div>
                      {reason && (
                        <p
                          className="text-sm text-muted-foreground mt-1"
                          data-testid={`history-reason-${ev.id}`}
                        >
                          Reason: {reason}
                        </p>
                      )}
                      {ev.description &&
                        ev.type !== "manual_je_draft_rejected" && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {ev.description}
                          </p>
                        )}
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
