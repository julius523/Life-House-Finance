import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Calculator, Send, Sparkles, AlertTriangle } from "lucide-react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const STARTER_PROMPTS = [
  "How should we treat a restricted grant we received last week but haven't spent yet?",
  "What documentation do we need on file before paying a vendor invoice?",
  "Walk me through a clean month-end close checklist for a small nonprofit.",
];

export default function AccountingPage() {
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const history = messages;
    const next: ChatMessage[] = [
      ...history,
      { role: "user", content: trimmed },
    ];
    setMessages(next);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/accounting/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        error?: string;
      };
      if (!res.ok || !data.reply) {
        throw new Error(data.error ?? `Copilot error (${res.status})`);
      }
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      toast({
        title: "Copilot could not respond",
        description: errorMessage,
        variant: "destructive",
      });
      setMessages([
        ...next,
        {
          role: "assistant",
          content: `_The copilot ran into an error: ${errorMessage}_`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

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
          The copilot is conservative by design. It will say so when it
          doesn't have enough evidence, and it does not post journal
          entries or approve compliance conclusions on its own. Anything
          that affects filed financials, taxes, payroll, or external
          reporting needs human accounting review.
        </CardContent>
      </Card>

      <Card className="flex flex-col h-[640px]">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Life House GAAP Copilot
          </CardTitle>
          <CardDescription>
            Conversation stays in this browser tab. Refreshing clears it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4"
          >
            {messages.length === 0 && (
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
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Thinking…
                </div>
              </div>
            )}
          </div>
          <form
            className="border-t p-3 flex gap-2 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={2}
              placeholder="Ask about a transaction, a control, a close step, or paste a question…"
              disabled={sending}
              className="resize-none"
            />
            <Button
              type="submit"
              disabled={sending || !input.trim()}
              className="h-auto"
            >
              <Send className="h-4 w-4 mr-2" />
              Send
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
