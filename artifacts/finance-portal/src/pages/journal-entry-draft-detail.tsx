import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { apiJson, ApiError } from "@/lib/api";
import { format } from "date-fns";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileEdit,
  Send,
  Upload,
  XCircle,
} from "lucide-react";

type DraftStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "posted";

type DraftLine = {
  uid?: number;
  type: "debit" | "credit";
  accountCode: string;
  amount: string;
  program: string;
  fund: string;
  memo: string;
};

type DraftPayload = {
  entryDate: string;
  memo: string;
  lines: DraftLine[];
};

type DraftRecord = {
  id: number;
  createdByUserId: number;
  entryDate: string | null;
  memo: string | null;
  payload: DraftPayload;
  status: DraftStatus;
  submittedByUserId: number | null;
  submittedAt: string | null;
  approvedByUserId: number | null;
  approvedAt: string | null;
  rejectedByUserId: number | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  postedJournalEntryId: number | null;
  /**
   * Task #44 — server-issued optimistic-lock token. Echoed back on every
   * mutation; if it has moved on the server, the request fails with 409
   * DRAFT_VERSION_CONFLICT and the UI refetches.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
  // Task #53 — populated when this draft was auto-generated from an
  // approved expense (via accounting_source_links).
  originatingExpense?: {
    id: number;
    merchant: string;
    amount: number;
    expenseDate: string;
    status: string;
  } | null;
};

type UserSummary = {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role?: string;
};

function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function formatAmount(input: string): string {
  const num = Number(input);
  if (!Number.isFinite(num)) return input;
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StatusBadge({ status }: { status: DraftStatus }) {
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

function userLabel(u: UserSummary | undefined, fallbackId: number | null) {
  if (!u) return fallbackId ? `User #${fallbackId}` : "—";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  if (name) return name;
  return u.email ?? `User #${u.id}`;
}

export default function JournalEntryDraftDetailPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, params] = useRoute<{ id: string }>(
    "/accounting/journal-entry-drafts/:id",
  );
  const [, setLocation] = useLocation();
  const id = params?.id;

  const canView = user?.role === "admin" || user?.role === "approver";

  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [users, setUsers] = useState<Record<number, UserSummary>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    title: string;
    message: string;
    code: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<
    "submit" | "approve" | "reject" | "post" | null
  >(null);
  const [rejectReason, setRejectReason] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch draft
  useEffect(() => {
    if (!canView || !id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    apiJson<{ draft: DraftRecord }>(`/accounting/journal-entry-drafts/${id}`)
      .then((data) => {
        if (!cancelled) setDraft(data.draft);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load draft.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canView, id, refreshKey]);

  // Fetch users to display submitter/approver/rejector names. Admin-only
  // endpoint; for approvers we fall back to "User #N" which is fine.
  useEffect(() => {
    if (user?.role !== "admin") return;
    let cancelled = false;
    apiJson<{ users: UserSummary[] }>("/admin/users")
      .then((data) => {
        if (cancelled) return;
        const map: Record<number, UserSummary> = {};
        for (const u of data.users) map[u.id] = u;
        setUsers(map);
      })
      .catch(() => {
        /* non-fatal — just show user IDs */
      });
    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    if (draft?.payload?.lines) {
      for (const ln of draft.payload.lines) {
        const n = Number(ln.amount);
        if (!Number.isFinite(n)) continue;
        if (ln.type === "debit") debits += n;
        else credits += n;
      }
    }
    return { debits, credits, balanced: Math.abs(debits - credits) < 0.005 };
  }, [draft]);

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Journal entry draft</h1>
        <p className="text-muted-foreground">
          Only admins and approvers can review journal entry drafts.
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

  if (loadError || !draft) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/accounting/journal-entries">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to journal entries
          </Link>
        </Button>
        <p className="text-destructive">{loadError ?? "Draft not found."}</p>
      </div>
    );
  }

  // Role/ownership/status gating per Task #42 acceptance: action buttons
  // are RENDERED (not just disabled) only when the actor is allowed to use
  // them. This is stricter than the server contract on purpose — the server
  // remains the authority and rejects anything that slips through.
  //   submit  → owner & status=draft
  //   approve → admin/approver & status=submitted & not submitter
  //   reject  → admin/approver & status=submitted & not submitter
  //   post    → admin/approver & status=approved & not submitter
  const isOwner = draft.createdByUserId === user!.id;
  const isReviewer = user!.role === "admin" || user!.role === "approver";
  const isSubmitter = draft.submittedByUserId === user!.id;
  const showSubmit = isOwner && draft.status === "draft";
  const showApprove =
    isReviewer && draft.status === "submitted" && !isSubmitter;
  const showReject = showApprove;
  const showPost =
    isReviewer && draft.status === "approved" && !isSubmitter;

  const runAction = async (
    action: "submit" | "approve" | "reject" | "post",
  ) => {
    setBusy(action);
    setActionError(null);
    try {
      const path = `/accounting/journal-entry-drafts/${draft.id}/${action}`;
      // Task #44 — every workflow transition carries the last-seen draft
      // version so the server can reject a stale action with 409
      // DRAFT_VERSION_CONFLICT instead of silently overwriting.
      const body: Record<string, unknown> = { expectedVersion: draft.version };
      if (action === "reject") {
        body["reason"] = rejectReason.trim();
      }
      const init: { method: string; body?: unknown } = {
        method: "POST",
        body,
      };
      const data = await apiJson<{
        draft: DraftRecord;
        journalEntry?: { id: number; entryNo: string };
      }>(path, init);
      setDraft(data.draft);
      setRejectReason("");
      const verbPast = {
        submit: "submitted",
        approve: "approved",
        reject: "rejected",
        post: "posted",
      }[action];
      toast({
        title: `Draft ${verbPast}`,
        description:
          action === "post" && data.journalEntry
            ? `Posted as ${data.journalEntry.entryNo}.`
            : undefined,
      });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      const message =
        e instanceof Error ? e.message : "Action failed unexpectedly.";
      const titleByCode: Record<string, string> = {
        NO_SELF_APPROVAL: "Separation of duties",
        INVALID_STATE_TRANSITION: "Cannot do that right now",
        DRAFT_NOT_EDITABLE: "Draft is locked",
        PERIOD_LOCKED: "Period is closed",
        UNBALANCED: "Debits and credits do not match",
        INVALID_ACCOUNT: "Invalid account",
        FORBIDDEN: "Not allowed",
        INVALID_PAYLOAD: "Invalid input",
        IDEMPOTENCY_CONFLICT: "Posting key conflict",
        // Task #44 — another reviewer changed the draft between our last
        // load and this action. We refetch below so the buttons reflect
        // reality.
        DRAFT_VERSION_CONFLICT: "Draft was changed by someone else",
      };
      setActionError({
        title: code ? (titleByCode[code] ?? "Action failed") : "Action failed",
        message,
        code,
      });
      // If the failure indicates the draft state moved underneath us
      // (e.g. another reviewer already approved/rejected/posted, or the
      // draft is no longer editable), refetch so the buttons reflect the
      // new state instead of leaving the user re-firing a doomed action.
      if (
        code === "INVALID_STATE_TRANSITION" ||
        code === "DRAFT_NOT_EDITABLE" ||
        code === "DRAFT_NOT_DELETABLE" ||
        code === "IDEMPOTENCY_CONFLICT" ||
        // Task #44 — version conflict means our local copy is stale;
        // refetch so the next attempt uses the new version.
        code === "DRAFT_VERSION_CONFLICT"
      ) {
        setRefreshKey((k) => k + 1);
      }
    } finally {
      setBusy(null);
    }
  };

  const submitterUser = draft.submittedByUserId
    ? users[draft.submittedByUserId]
    : undefined;
  const approverUser = draft.approvedByUserId
    ? users[draft.approvedByUserId]
    : undefined;
  const rejecterUser = draft.rejectedByUserId
    ? users[draft.rejectedByUserId]
    : undefined;
  const ownerUser = users[draft.createdByUserId];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <FileEdit className="h-7 w-7 text-primary" />
            Manual JE draft #{draft.id}
          </h1>
          <p className="text-muted-foreground mt-1">
            {draft.memo ?? "(no memo)"}
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/accounting/journal-entries">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to list
          </Link>
        </Button>
      </div>

      {/* Header card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Header
            <span data-testid="text-draft-status">
              <StatusBadge status={draft.status} />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Entry date
            </div>
            <div className="font-medium">
              {draft.payload?.entryDate &&
              /^\d{4}-\d{2}-\d{2}$/.test(draft.payload.entryDate)
                ? format(parseDateOnly(draft.payload.entryDate), "MMM d, yyyy")
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Created by
            </div>
            <div className="font-medium">
              {userLabel(ownerUser, draft.createdByUserId)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Last updated
            </div>
            <div className="font-medium">
              {format(new Date(draft.updatedAt), "MMM d, yyyy p")}
            </div>
          </div>
          {draft.submittedAt && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Submitted
              </div>
              <div className="font-medium">
                {userLabel(submitterUser, draft.submittedByUserId)}
              </div>
              <div className="text-xs text-muted-foreground">
                {format(new Date(draft.submittedAt), "MMM d, p")}
              </div>
            </div>
          )}
          {draft.approvedAt && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Approved
              </div>
              <div className="font-medium">
                {userLabel(approverUser, draft.approvedByUserId)}
              </div>
              <div className="text-xs text-muted-foreground">
                {format(new Date(draft.approvedAt), "MMM d, p")}
              </div>
            </div>
          )}
          {draft.rejectedAt && (
            <div className="md:col-span-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Rejected
              </div>
              <div className="font-medium">
                {userLabel(rejecterUser, draft.rejectedByUserId)}
                <span className="text-xs text-muted-foreground ml-2">
                  {format(new Date(draft.rejectedAt), "MMM d, p")}
                </span>
              </div>
              {draft.rejectionReason && (
                <div
                  className="text-sm mt-1 text-destructive"
                  data-testid="text-rejection-reason"
                >
                  Reason: {draft.rejectionReason}
                </div>
              )}
            </div>
          )}
          {draft.postedJournalEntryId && (
            <div className="md:col-span-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Posted as
              </div>
              <Link
                className="text-primary underline"
                href={`/accounting/journal-entries/${draft.postedJournalEntryId}`}
                data-testid="link-posted-journal-entry"
              >
                Journal entry #{draft.postedJournalEntryId}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        Task #53 — Originating expense card. Renders only when this draft
        was auto-generated from an approved expense (via accounting_source_links).
      */}
      {draft.originatingExpense && (
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
                href={`/expenses/${draft.originatingExpense.id}`}
                className="font-medium text-primary hover:underline"
                data-testid="link-originating-expense"
              >
                #{draft.originatingExpense.id}
              </Link>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Vendor
              </div>
              <div className="font-medium">
                {draft.originatingExpense.merchant}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Date
              </div>
              <div className="font-medium">
                {format(
                  parseDateOnly(draft.originatingExpense.expenseDate),
                  "MMM d, yyyy",
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Amount
              </div>
              <div className="font-medium font-mono">
                ${draft.originatingExpense.amount.toFixed(2)}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lines */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
          <CardDescription>
            Debits {formatAmount(String(totals.debits))}, credits{" "}
            {formatAmount(String(totals.credits))}
            {totals.balanced ? " — balanced." : " — UNBALANCED."}
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
                {(draft.payload?.lines ?? []).map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {l.accountCode || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {l.type === "debit" ? formatAmount(l.amount) : ""}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {l.type === "credit" ? formatAmount(l.amount) : ""}
                    </TableCell>
                    <TableCell>{l.program ?? ""}</TableCell>
                    <TableCell>{l.fund ?? ""}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {l.memo ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Workflow actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workflow</CardTitle>
          <CardDescription>
            {draft.status === "posted"
              ? "This draft has been posted to the ledger."
              : draft.status === "approved"
                ? "Approved and ready to post."
                : draft.status === "submitted"
                  ? "Awaiting reviewer approval."
                  : draft.status === "rejected"
                    ? "Returned to author for fixes."
                    : "Draft — not yet submitted for review."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {actionError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive flex gap-2"
              data-testid="text-action-error"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 flex-none" />
              <div>
                <div className="font-medium">{actionError.title}</div>
                <div className="text-destructive/80">{actionError.message}</div>
                {actionError.code && (
                  <div className="text-xs text-destructive/60 mt-1 font-mono">
                    {actionError.code}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {showSubmit && (
              <Button
                onClick={() => runAction("submit")}
                disabled={busy !== null}
                data-testid="button-submit-draft"
              >
                <Send className="h-4 w-4 mr-1" />
                {busy === "submit" ? "Submitting…" : "Submit for review"}
              </Button>
            )}

            {/* Owner can edit while draft is editable on the server. The
                editor route enforces its own access rules, but we mirror
                the server's editable set here. */}
            {isOwner &&
              (draft.status === "draft" || draft.status === "rejected") && (
                <Button asChild variant="outline">
                  <Link href={`/accounting/journal-entries/new?draft=${draft.id}`}>
                    <FileEdit className="h-4 w-4 mr-1" />
                    Edit
                  </Link>
                </Button>
              )}

            {showApprove && (
              <Button
                onClick={() => runAction("approve")}
                disabled={busy !== null}
                data-testid="button-approve-draft"
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                {busy === "approve" ? "Approving…" : "Approve"}
              </Button>
            )}

            {showPost && (
              <Button
                onClick={() => runAction("post")}
                disabled={busy !== null}
                data-testid="button-post-draft"
              >
                <Upload className="h-4 w-4 mr-1" />
                {busy === "post" ? "Posting…" : "Post to ledger"}
              </Button>
            )}

            {draft.status === "posted" && draft.postedJournalEntryId && (
              <Button
                onClick={() =>
                  setLocation(
                    `/accounting/journal-entries/${draft.postedJournalEntryId}`,
                  )
                }
                variant="outline"
              >
                View posted journal entry
              </Button>
            )}
          </div>

          {/* Reject form — only visible to a reviewer who is not the
              submitter, when the draft is awaiting review. */}
          {showReject && (
            <div className="border-t pt-4 space-y-2">
              <Label htmlFor="reject-reason">
                Rejection reason (required, ≥ 5 characters)
              </Label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={2}
                placeholder="Explain what the author should fix before resubmitting…"
                data-testid="input-reject-reason"
              />
              <Button
                variant="destructive"
                onClick={() => runAction("reject")}
                disabled={busy !== null || rejectReason.trim().length < 5}
                data-testid="button-reject-draft"
              >
                <XCircle className="h-4 w-4 mr-1" />
                {busy === "reject" ? "Rejecting…" : "Reject and return"}
              </Button>
            </div>
          )}

          {/* When the user is the submitter of a still-pending draft, show
              an explanatory note instead of approve/reject buttons so they
              understand why no actions are available. */}
          {draft.status === "submitted" && isSubmitter && (
            <p
              className="text-sm text-muted-foreground border-t pt-4"
              data-testid="text-submitter-waiting"
            >
              You submitted this draft. A different reviewer must approve or
              reject it (separation of duties).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
