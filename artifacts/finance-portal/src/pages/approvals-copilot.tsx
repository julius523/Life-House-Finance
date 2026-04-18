import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { format } from "date-fns";

type AgentAction = {
  id: number;
  userId: number;
  threadId: number;
  assistantMessageId: number | null;
  actionType: string;
  payload: Record<string, unknown>;
  evidence: Record<string, unknown> | null;
  confidence: string | null;
  riskFlags: string | null;
  status: string;
  createdAt: string;
  reviewedBy: number | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  submitter: { id: number; firstName: string; lastName: string; email: string } | null;
  reviewer: { id: number; firstName: string; lastName: string; email: string } | null;
  sources: Array<{
    id: number;
    snippetId: string;
    documentTitle: string | null;
    snippetText: string;
    whyRelevant: string;
  }>;
};

type StatusFilter = "pending_review" | "approved" | "rejected" | "canceled";

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "canceled", label: "Canceled" },
];

const ACTION_LABEL: Record<string, string> = {
  draft_journal_entry: "Journal entry draft",
  draft_memo: "Memo draft",
  create_followup_task: "Follow-up task",
  escalate_to_human: "Escalation",
};

function formatActionType(t: string): string {
  return ACTION_LABEL[t] ?? t;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-green-100 text-green-800"
      : status === "rejected"
        ? "bg-red-100 text-red-800"
        : status === "canceled"
          ? "bg-gray-100 text-gray-700"
          : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function PayloadView({ action }: { action: AgentAction }) {
  const p = action.payload || {};
  if (action.actionType === "draft_journal_entry") {
    const lines = (p["lines"] as Array<Record<string, unknown>>) ?? [];
    const totals = (p["totals"] as Record<string, number>) ?? {};
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-3 text-sm">
          <div><span className="text-gray-500">Date:</span> {String(p["date"] ?? "—")}</div>
          <div><span className="text-gray-500">Memo:</span> {String(p["memo"] ?? "—")}</div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-1">Type</th>
              <th className="px-2 py-1">Account</th>
              <th className="px-2 py-1">Dimension</th>
              <th className="px-2 py-1 text-right">Amount</th>
              <th className="px-2 py-1">Description</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{String(l["type"])}</td>
                <td className="px-2 py-1">{String(l["account"])}</td>
                <td className="px-2 py-1 text-gray-600">{String(l["dimension"] ?? "")}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  ${Number(l["amount"] ?? 0).toFixed(2)}
                </td>
                <td className="px-2 py-1 text-gray-600">{String(l["description"] ?? "")}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t bg-gray-50 text-sm font-medium">
            <tr>
              <td colSpan={3} className="px-2 py-1 text-right">Totals</td>
              <td className="px-2 py-1 text-right tabular-nums">
                Dr ${Number(totals["debits"] ?? 0).toFixed(2)} / Cr ${Number(totals["credits"] ?? 0).toFixed(2)}
              </td>
              <td className="px-2 py-1 text-green-700">{totals["balanced"] ? "Balanced" : "Unbalanced"}</td>
            </tr>
          </tfoot>
        </table>
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Approving this draft does NOT post to any ledger. Step 6 only records the human decision; ledger posting is not implemented.
        </div>
      </div>
    );
  }
  if (action.actionType === "draft_memo") {
    return (
      <div className="space-y-2 text-sm">
        <div><span className="text-gray-500">Topic:</span> {String(p["topic"] ?? "")}</div>
        <div><span className="text-gray-500">Audience:</span> {String(p["audience"] ?? "")}</div>
        <div className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-gray-800">
          {String(p["body"] ?? "")}
        </div>
      </div>
    );
  }
  if (action.actionType === "create_followup_task") {
    return (
      <div className="space-y-1 text-sm">
        <div><span className="text-gray-500">Title:</span> {String(p["title"] ?? "")}</div>
        <div className="whitespace-pre-wrap text-gray-800">{String(p["body"] ?? "")}</div>
        {p["due_hint"] ? <div className="text-gray-500">Due hint: {String(p["due_hint"])}</div> : null}
      </div>
    );
  }
  if (action.actionType === "escalate_to_human") {
    return (
      <div className="space-y-1 text-sm">
        <div>
          <span className="text-gray-500">Severity:</span>{" "}
          <Badge variant="outline">{String(p["severity"] ?? "")}</Badge>
        </div>
        <div className="whitespace-pre-wrap text-gray-800">{String(p["reason"] ?? "")}</div>
        <div className="text-xs text-gray-500">
          Admin notifications were sent at draft time.
        </div>
      </div>
    );
  }
  return <pre className="text-xs">{JSON.stringify(p, null, 2)}</pre>;
}

export default function CopilotApprovalsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<StatusFilter>("pending_review");
  const [actions, setActions] = useState<AgentAction[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectNotes, setRejectNotes] = useState<Record<number, string>>({});

  async function load() {
    setLoading(true);
    try {
      const data = await apiJson<{ actions: AgentAction[] }>(
        `/accounting/agent-actions?status=${status}`,
      );
      setActions(data.actions ?? []);
    } catch (e) {
      toast({
        title: "Could not load drafts",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      setActions([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function decide(
    id: number,
    decision: "approve" | "reject" | "cancel",
    notes?: string,
  ) {
    setBusyId(id);
    try {
      await apiJson(`/accounting/agent-actions/${id}/${decision}`, {
        method: "POST",
        body: notes ? { notes } : {},
      });
      toast({ title: `Draft ${decision}d` });
      await load();
    } catch (e) {
      toast({
        title: `Could not ${decision} draft`,
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(() => actions ?? [], [actions]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Copilot drafts — human review</CardTitle>
          <CardDescription>
            Drafts created by the GAAP Copilot stay here until a human reviewer
            approves or rejects them. Submitters cannot approve their own
            drafts. Approving a draft does not post to the ledger or send any
            external communication — Step 6 records the decision only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-2">
            {STATUS_TABS.map((t) => (
              <Button
                key={t.value}
                variant={status === t.value ? "default" : "outline"}
                size="sm"
                onClick={() => setStatus(t.value)}
                data-testid={`tab-${t.value}`}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">
              No {status.replace("_", " ")} drafts to show.
            </div>
          ) : (
            <div className="space-y-3">
              {visible.map((a) => {
                const isSubmitter = user?.id === a.userId;
                const canDecide = !isSubmitter && a.status === "pending_review";
                const canCancel =
                  (isSubmitter || user?.role === "admin") &&
                  a.status === "pending_review";
                return (
                  <Card key={a.id} data-testid={`action-${a.id}`}>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base">
                          {formatActionType(a.actionType)}
                        </CardTitle>
                        <StatusBadge status={a.status} />
                        {a.confidence ? (
                          <Badge variant="outline" className="text-xs">
                            {a.confidence} confidence
                          </Badge>
                        ) : null}
                        <span className="ml-auto text-xs text-gray-500">
                          #{a.id} · {format(new Date(a.createdAt), "PPp")}
                        </span>
                      </div>
                      <CardDescription>
                        Drafted by{" "}
                        {a.submitter
                          ? `${a.submitter.firstName} ${a.submitter.lastName}`
                          : `user #${a.userId}`}{" "}
                        in thread #{a.threadId}
                        {a.reviewer ? (
                          <>
                            {" "}· reviewed by {a.reviewer.firstName}{" "}
                            {a.reviewer.lastName}
                            {a.reviewedAt
                              ? ` on ${format(new Date(a.reviewedAt), "PPp")}`
                              : ""}
                          </>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <PayloadView action={a} />
                      {a.riskFlags ? (
                        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                          <span className="font-medium">Risk flags:</span> {a.riskFlags}
                        </div>
                      ) : null}
                      {a.sources.length > 0 ? (
                        <div className="rounded bg-gray-50 p-2 text-xs">
                          <div className="mb-1 font-medium text-gray-700">
                            Cited sources ({a.sources.length})
                          </div>
                          <ul className="list-disc pl-4 text-gray-600">
                            {a.sources.map((s) => (
                              <li key={s.id}>
                                <span className="font-medium">
                                  {s.documentTitle ?? s.snippetId}
                                </span>
                                {s.whyRelevant ? ` — ${s.whyRelevant}` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {a.reviewNotes ? (
                        <div className="rounded bg-gray-50 p-2 text-xs text-gray-700">
                          <span className="font-medium">Reviewer notes:</span>{" "}
                          {a.reviewNotes}
                        </div>
                      ) : null}

                      {a.status === "pending_review" ? (
                        <div className="space-y-2 border-t pt-3">
                          {isSubmitter ? (
                            <div className="text-xs text-gray-500">
                              You drafted this. Another reviewer must approve
                              or reject. You may cancel it.
                            </div>
                          ) : null}
                          <Textarea
                            placeholder="Reviewer notes (required to reject)…"
                            value={rejectNotes[a.id] ?? ""}
                            onChange={(e) =>
                              setRejectNotes((m) => ({
                                ...m,
                                [a.id]: e.target.value,
                              }))
                            }
                            rows={2}
                            data-testid={`notes-${a.id}`}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={!canDecide || busyId === a.id}
                              onClick={() =>
                                decide(a.id, "approve", rejectNotes[a.id])
                              }
                              data-testid={`approve-${a.id}`}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={
                                !canDecide ||
                                busyId === a.id ||
                                !(rejectNotes[a.id] ?? "").trim()
                              }
                              onClick={() =>
                                decide(a.id, "reject", rejectNotes[a.id])
                              }
                              data-testid={`reject-${a.id}`}
                            >
                              Reject
                            </Button>
                            {canCancel ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyId === a.id}
                                onClick={() =>
                                  decide(a.id, "cancel", rejectNotes[a.id])
                                }
                                data-testid={`cancel-${a.id}`}
                              >
                                Cancel draft
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
