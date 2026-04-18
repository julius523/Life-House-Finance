import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import {
  Calculator,
  Send,
  Sparkles,
  AlertTriangle,
  Plus,
  Trash2,
  ChevronDown,
  Pencil,
  Activity,
  Info,
} from "lucide-react";

type ThreadSummary = {
  id: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  messageCount?: number;
};

type CopilotMessage = {
  id: number;
  threadId: number;
  role: "user" | "assistant";
  status: "ok" | "error";
  userText: string | null;
  answer: string | null;
  why: string | null;
  missingInformation: string | null;
  riskFlags: string | null;
  recommendedNextStep: string | null;
  humanReviewNeeded: boolean | null;
  confidence: "low" | "medium" | "high" | null;
  pageContext: PageContext | null;
  modelName: string | null;
  latencyMs: number | null;
  errorCode: string | null;
  createdAt: string;
  toolCalls?: ToolCall[];
  sources?: SourceCitation[];
};

type SourceCitation = {
  id: number;
  snippetId: string;
  documentId: number;
  documentTitle: string;
  snippetText: string;
  rank: string | number | null;
  whyRelevant: string | null;
  createdAt: string;
};

type ToolCall = {
  id: number;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "ok" | "error";
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
};

type PageContext = {
  route: string;
  recordType: string;
  recordId: string | number | null;
  entityLabel: string | null;
  visibleSummary: Record<string, string | number | boolean | null>;
};

const STARTER_PROMPTS = [
  "How should we treat a restricted grant we received last week but haven't spent yet?",
  "What documentation do we need on file before paying a vendor invoice?",
  "Walk me through a clean month-end close checklist for a small nonprofit.",
];

export default function AccountingPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [location] = useLocation();

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [diagnostics, setDiagnostics] = useState<{
    status: string;
    detail: string;
  } | null>(null);
  const [pingingDiagnostics, setPingingDiagnostics] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Build pageContext from current route. For Step 2/3 we wire the
  // Accounting page itself; pushing context from other detail pages is a
  // small follow-on.
  const pageContext: PageContext = useMemo(
    () => ({
      route: location,
      recordType: "accounting",
      recordId: null,
      entityLabel: "Accounting workspace",
      visibleSummary: {
        active_thread_id: activeThreadId,
        thread_count: threads.length,
      },
    }),
    [location, activeThreadId, threads.length],
  );

  // ---- Load thread list ---------------------------------------------------
  const loadThreads = async () => {
    try {
      const data = await apiJson<{ threads: ThreadSummary[] }>(
        "/accounting/threads",
      );
      setThreads(data.threads);
      if (data.threads.length > 0 && activeThreadId === null) {
        setActiveThreadId(data.threads[0]!.id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load conversations";
      toast({ title: "Could not load conversations", description: msg, variant: "destructive" });
    }
  };

  useEffect(() => {
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Load messages for active thread -----------------------------------
  useEffect(() => {
    if (activeThreadId === null) {
      setMessages([]);
      return;
    }
    setLoadingThread(true);
    apiJson<{ thread: ThreadSummary; messages: CopilotMessage[] }>(
      `/accounting/threads/${activeThreadId}`,
    )
      .then((data) => setMessages(data.messages))
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Failed to load thread";
        toast({ title: "Could not load conversation", description: msg, variant: "destructive" });
      })
      .finally(() => setLoadingThread(false));
  }, [activeThreadId, toast]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  // ---- Send a message ----------------------------------------------------
  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setInput("");

    try {
      let threadId = activeThreadId;
      if (threadId === null) {
        const created = await apiJson<{ thread: ThreadSummary }>(
          "/accounting/threads",
          { method: "POST", body: {} },
        );
        threadId = created.thread.id;
        setActiveThreadId(threadId);
        setThreads((t) => [
          { ...created.thread, messageCount: 0 },
          ...t,
        ]);
      }

      // Optimistic user bubble
      const optimisticUser: CopilotMessage = {
        id: -Date.now(),
        threadId: threadId,
        role: "user",
        status: "ok",
        userText: trimmed,
        answer: null, why: null, missingInformation: null, riskFlags: null,
        recommendedNextStep: null, humanReviewNeeded: null, confidence: null,
        pageContext, modelName: null, latencyMs: null, errorCode: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, optimisticUser]);

      const res = await fetch(
        `/api/accounting/threads/${threadId}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, pageContext }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        userMessage?: CopilotMessage;
        assistantMessage?: CopilotMessage;
        error?: string;
      };

      if (data.userMessage && data.assistantMessage) {
        setMessages((m) => {
          const without = m.filter((x) => x.id !== optimisticUser.id);
          return [...without, data.userMessage!, data.assistantMessage!];
        });
        if (data.error) {
          toast({
            title: "Copilot returned an error",
            description: data.error,
            variant: "destructive",
          });
        }
      } else {
        throw new Error(data.error ?? `Copilot error (${res.status})`);
      }

      // Refresh thread list (titles may have auto-set)
      void loadThreads();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      toast({
        title: "Copilot could not respond",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  // ---- Thread mgmt -------------------------------------------------------
  const newThread = () => {
    setActiveThreadId(null);
    setMessages([]);
  };

  const deleteThread = async (id: number) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await apiJson(`/accounting/threads/${id}`, { method: "DELETE" });
      setThreads((t) => t.filter((x) => x.id !== id));
      if (activeThreadId === id) {
        setActiveThreadId(null);
        setMessages([]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to delete";
      toast({ title: "Could not delete", description: msg, variant: "destructive" });
    }
  };

  const startRename = (t: ThreadSummary) => {
    setRenamingId(t.id);
    setRenameValue(t.title ?? "");
  };

  const saveRename = async (id: number) => {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await apiJson(`/accounting/threads/${id}`, {
        method: "PATCH",
        body: { title },
      });
      setThreads((t) => t.map((x) => (x.id === id ? { ...x, title } : x)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to rename";
      toast({ title: "Could not rename", description: msg, variant: "destructive" });
    } finally {
      setRenamingId(null);
    }
  };

  // ---- Diagnostics (admin only) ------------------------------------------
  const runDiagnostics = async () => {
    setPingingDiagnostics(true);
    try {
      const data = await apiJson<{ status: string; detail: string }>(
        "/accounting/diagnostics/ping",
        { method: "POST", body: {} },
      );
      setDiagnostics(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to ping";
      setDiagnostics({ status: "unknown_error", detail: msg });
    } finally {
      setPingingDiagnostics(false);
    }
  };

  const isAdmin = user?.role === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Calculator className="h-7 w-7 text-primary" />
          Accounting
        </h1>
        <p className="text-muted-foreground mt-1">
          Ask the Life House GAAP Copilot about classifications,
          documentation, controls, and month-end close.
        </p>
      </div>

      <Card className="border-amber-500/40 bg-amber-50/40">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-amber-700 text-base">
            <AlertTriangle className="h-4 w-4" />
            Evidence-first, not a replacement for your CPA
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-amber-900/80 pt-0">
          The copilot is conservative by design. It currently has no access
          to your internal documents, policies, or transaction data, so its
          reasoning is general accounting guidance only. Anything that
          affects filed financials, taxes, payroll, or external reporting
          needs human accounting review.
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              Copilot diagnostics
            </CardTitle>
            <CardDescription>
              Admin-only. Sends a tiny ping to verify the OpenAI API key, billing,
              and model are configured.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={runDiagnostics}
              disabled={pingingDiagnostics}
            >
              {pingingDiagnostics ? "Checking…" : "Check copilot status"}
            </Button>
            {diagnostics && (
              <div className="flex items-center gap-2 text-sm">
                <Badge
                  variant={diagnostics.status === "healthy" ? "default" : "destructive"}
                >
                  {diagnostics.status.replace(/_/g, " ")}
                </Badge>
                <span className="text-muted-foreground">{diagnostics.detail}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 h-[700px]">
        {/* Thread sidebar */}
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="pb-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Conversations</CardTitle>
              <Button size="sm" variant="ghost" onClick={newThread} title="New conversation">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-y-auto">
            {threads.length === 0 && activeThreadId === null && (
              <p className="text-xs text-muted-foreground p-3">
                No conversations yet. Send a message to start one.
              </p>
            )}
            {activeThreadId === null && messages.length === 0 && threads.length > 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground border-b">
                Starting a new conversation…
              </div>
            )}
            <ul className="divide-y">
              {threads.map((t) => (
                <li
                  key={t.id}
                  className={`group flex items-center gap-1 px-3 py-2 cursor-pointer hover:bg-muted/50 ${
                    t.id === activeThreadId ? "bg-muted" : ""
                  }`}
                  onClick={() => setActiveThreadId(t.id)}
                >
                  {renamingId === t.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(t.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => void saveRename(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-7 text-sm"
                    />
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          {t.title ?? "(new conversation)"}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(t.updatedAt).toLocaleString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(t);
                        }}
                        title="Rename"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteThread(t.id);
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* Conversation pane */}
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="border-b py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              Life House GAAP Copilot
            </CardTitle>
            <CardDescription>
              Conversations are saved to your account. Page context is sent with each message.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingThread && (
                <p className="text-sm text-muted-foreground">Loading conversation…</p>
              )}
              {!loadingThread && messages.length === 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Try one of these to get started:
                  </p>
                  <div className="space-y-2">
                    {STARTER_PROMPTS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => send(p)}
                        className="w-full text-left text-sm rounded-md border bg-background hover:bg-muted/50 px-3 py-2 transition-colors"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} />
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                    Thinking…
                  </div>
                </div>
              )}
            </div>

            {/* Page context chip */}
            <div className="border-t bg-muted/30 px-3 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              <span>Sending context:</span>
              <span className="font-medium text-foreground">
                {pageContext.entityLabel ?? pageContext.route}
              </span>
              <details className="ml-auto">
                <summary className="cursor-pointer hover:text-foreground">peek</summary>
                <pre className="absolute right-4 mt-1 max-w-md rounded-md border bg-background p-2 text-[11px] shadow-md whitespace-pre-wrap">
                  {JSON.stringify(pageContext, null, 2)}
                </pre>
              </details>
            </div>

            <form
              className="border-t p-3 flex gap-2 items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder="Ask about a transaction, a control, a close step, or paste a question…"
                disabled={sending}
                className="resize-none"
              />
              <Button type="submit" disabled={sending || !input.trim()}>
                <Send className="h-4 w-4 mr-2" />
                Send
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: CopilotMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground">
          {m.userText}
        </div>
      </div>
    );
  }
  return <AssistantCard m={m} />;
}

function AssistantCard({ m }: { m: CopilotMessage }) {
  if (m.status === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <div className="font-medium text-destructive">Copilot failed</div>
          <div className="text-xs text-muted-foreground mt-1">
            {m.errorCode === "rate_or_quota_limited"
              ? "Rate or billing limit reached. An admin should check the diagnostics card above."
              : m.errorCode === "auth_failed"
                ? "API key was rejected. An admin should verify configuration."
                : m.errorCode === "schema_violation"
                  ? "The model returned an unexpected response. Retry the message."
                  : m.errorCode === "key_missing"
                    ? "OPENAI_API_KEY is not configured."
                    : m.errorCode === "fabricated_citation"
                      ? "The copilot cited internal evidence that was never retrieved. The response was rejected — please retry."
                      : "Try again, or check the diagnostics above."}
          </div>
        </div>
      </div>
    );
  }

  const sections: Array<{
    label: string;
    value: string;
    defaultOpen: boolean;
    hideIfNone?: boolean;
    accent?: "amber";
  }> = [
    { label: "Why", value: m.why ?? "", defaultOpen: true },
    { label: "Missing information", value: m.missingInformation ?? "", defaultOpen: false, hideIfNone: true },
    { label: "Risk flags", value: m.riskFlags ?? "", defaultOpen: false, hideIfNone: true, accent: "amber" },
    { label: "Recommended next step", value: m.recommendedNextStep ?? "", defaultOpen: true },
  ];

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] w-full space-y-2 rounded-lg border bg-card p-3 shadow-sm">
        {/* Header badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {m.humanReviewNeeded ? (
            <Badge variant="destructive">Needs human review</Badge>
          ) : (
            <Badge variant="secondary">No human review needed</Badge>
          )}
          <ConfidenceBadge confidence={m.confidence} />
        </div>

        {/* Answer */}
        <div className="text-sm whitespace-pre-wrap break-words">{m.answer}</div>

        {/* Collapsible sections */}
        <div className="space-y-1.5 pt-1">
          {sections.map((s) => {
            if (s.hideIfNone && (s.value.trim().toLowerCase() === "none" || !s.value.trim())) {
              return null;
            }
            return (
              <Collapsible key={s.label} defaultOpen={s.defaultOpen}>
                <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronDown className="h-3 w-3 transition-transform data-[state=closed]:-rotate-90" />
                  {s.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div
                    className={`text-sm whitespace-pre-wrap break-words mt-1 pl-4 ${
                      s.accent === "amber" ? "text-amber-900" : "text-foreground/90"
                    }`}
                  >
                    {s.value}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>

        {/* Sources (Step 5) */}
        {m.sources && m.sources.length > 0 && (
          <Collapsible defaultOpen={true}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-900 pt-1">
              <ChevronDown className="h-3 w-3 transition-transform data-[state=closed]:-rotate-90" />
              Sources ({m.sources.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-1.5 mt-1 pl-4">
                {m.sources.map((s) => (
                  <SourceRow key={s.id} s={s} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Tool calls */}
        {m.toolCalls && m.toolCalls.length > 0 && (
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground pt-1">
              <ChevronDown className="h-3 w-3 transition-transform data-[state=closed]:-rotate-90" />
              Tools used ({m.toolCalls.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-1.5 mt-1 pl-4">
                {m.toolCalls.map((tc) => (
                  <ToolCallRow key={tc.id} tc={tc} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Footer */}
        <div className="text-[10px] text-muted-foreground pt-1 border-t mt-2">
          {m.modelName ?? "model"}
          {m.latencyMs !== null && ` · ${m.latencyMs}ms`}
          {m.toolCalls && m.toolCalls.length > 0 && ` · ${m.toolCalls.length} tool call${m.toolCalls.length === 1 ? "" : "s"}`}
        </div>
      </div>
    </div>
  );
}

function SourceRow({ s }: { s: SourceCitation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-emerald-200 bg-emerald-50/40 p-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left"
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300">
          {s.snippetId}
        </Badge>
        <span className="font-medium text-foreground truncate">
          {s.documentTitle}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          {s.whyRelevant && (
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">
                Why cited
              </div>
              <div className="text-xs text-foreground/90">{s.whyRelevant}</div>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              Snippet
            </div>
            <div className="rounded border bg-background p-2 text-xs whitespace-pre-wrap break-words font-sans text-foreground/90 max-h-48 overflow-auto">
              {s.snippetText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isMemo =
    tc.toolName === "draft_memo" &&
    tc.status === "ok" &&
    tc.result !== null &&
    typeof tc.result === "object" &&
    "body" in (tc.result as Record<string, unknown>);
  const isEscalation =
    tc.toolName === "escalate_to_human" && tc.status === "ok";
  const isFollowup =
    tc.toolName === "create_followup_task" && tc.status === "ok";
  return (
    <div className="rounded border bg-muted/40 p-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left"
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="font-mono">{tc.toolName}</span>
        {tc.status === "error" ? (
          <Badge variant="destructive">error</Badge>
        ) : isEscalation ? (
          <Badge className="bg-red-100 text-red-800 border-red-300">
            escalated
          </Badge>
        ) : isFollowup ? (
          <Badge className="bg-blue-100 text-blue-800 border-blue-300">
            follow-up created
          </Badge>
        ) : isMemo ? (
          <Badge variant="secondary">draft memo</Badge>
        ) : (
          <Badge variant="outline">ok</Badge>
        )}
        <span className="text-muted-foreground ml-auto">
          {tc.latencyMs ?? 0}ms
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {isMemo && (
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">
                Memo body (draft only — not saved or sent)
              </div>
              <pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs font-sans">
                {String((tc.result as { body: string }).body)}
              </pre>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              Arguments
            </div>
            <pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-[11px] font-mono max-h-40 overflow-auto">
              {JSON.stringify(tc.arguments, null, 2)}
            </pre>
          </div>
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              Result {tc.status === "error" ? "(error)" : ""}
            </div>
            <pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-[11px] font-mono max-h-60 overflow-auto">
              {tc.status === "error"
                ? tc.errorMessage ?? "(no message)"
                : JSON.stringify(tc.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: CopilotMessage["confidence"];
}) {
  if (!confidence) return null;
  const cls =
    confidence === "high"
      ? "bg-green-100 text-green-800 border-green-300"
      : confidence === "medium"
        ? "bg-amber-100 text-amber-800 border-amber-300"
        : "bg-red-100 text-red-800 border-red-300";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>
      Confidence: {confidence}
    </span>
  );
}
