import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  copilotThreadsTable,
  copilotMessagesTable,
  copilotToolCallsTable,
  copilotDocumentsTable,
  copilotDocumentChunksTable,
  copilotMessageSourcesTable,
  agentActionsTable,
  activityLogTable,
  notificationsTable,
  usersTable,
  journalEntriesTable,
  journalEntryLinesTable,
  manualJournalEntryDraftsTable,
  accountingPeriodsTable,
  accountingSettingsTable,
  chartOfAccountsTable,
  type ManualJournalEntryDraftRow,
  type CopilotMessageRow,
  type CopilotThreadRow,
  type CopilotToolCallRow,
  type CopilotMessageSourceRow,
  type AgentActionRow,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  postApprovedJournalEntry,
  postManualJournalEntry,
  reverseJournalEntry,
  type PostingActor,
} from "../lib/postingService";
import {
  getOpenAIToolDefinitions,
  runTool,
  type CopilotToolContext,
  type PageContextLike,
  type RetrievedSnippet,
} from "../lib/copilotTools";

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOTAL_TOOL_CALLS = 12;

// ---------------------------------------------------------------------------
// Step 7: per-request cost / usage tracking.
//
// Pricing table is in USD per 1M tokens. Numbers are kept here (not in env)
// so cost attribution is reproducible from a code commit. Update when models
// or list prices change.
//
// If a model is not in this table, token counts are still recorded but
// `costUsdMicros` is left null — never silently zeroed.
// ---------------------------------------------------------------------------
const MODEL_PRICING_USD_PER_1M_TOKENS: Readonly<
  Record<string, { input: number; output: number }>
> = {
  "gpt-5.4": { input: 2.5, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

type LlmTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCallCount: number;
};

function emptyUsage(): LlmTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
  };
}

function accumulateUsage(
  acc: LlmTurnUsage,
  resp: { usage?: unknown } | null | undefined,
): void {
  acc.llmCallCount += 1;
  const u = (resp?.usage ?? null) as
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      }
    | null;
  if (!u) return;
  // The Responses API returns input_tokens/output_tokens/total_tokens.
  // Fall back to chat-completions field names for safety in case OpenAI
  // ever returns the legacy shape.
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  const total = u.total_tokens ?? input + output;
  acc.inputTokens += Number.isFinite(input) ? input : 0;
  acc.outputTokens += Number.isFinite(output) ? output : 0;
  acc.totalTokens += Number.isFinite(total) ? total : 0;
}

function lookupPricing(
  modelName: string,
): { input: number; output: number } | null {
  // Exact match first (canonical names like "gpt-5.4").
  const exact = MODEL_PRICING_USD_PER_1M_TOKENS[modelName];
  if (exact) return exact;
  // OpenAI returns date-stamped variants like "gpt-5.4-2026-03-05".
  // Prefix-match against the longest known base id so a stamped model
  // inherits its base's pricing without a separate table entry.
  const keys = Object.keys(MODEL_PRICING_USD_PER_1M_TOKENS).sort(
    (a, b) => b.length - a.length,
  );
  for (const k of keys) {
    if (modelName === k || modelName.startsWith(k + "-")) {
      return MODEL_PRICING_USD_PER_1M_TOKENS[k] ?? null;
    }
  }
  return null;
}

function computeCostUsdMicros(
  modelName: string | null | undefined,
  usage: LlmTurnUsage,
): number | null {
  if (!modelName) return null;
  const price = lookupPricing(modelName);
  if (!price) return null;
  // micros == USD * 1_000_000. Per-token price is (USD/1M tokens) so:
  //   tokens * (USD per 1M) = tokens * price  → divide by 1M to get USD,
  //   then multiply by 1M to get micros — i.e. multiply tokens * price * 1.
  // Round to nearest integer micro.
  const micros =
    usage.inputTokens * price.input + usage.outputTokens * price.output;
  return Math.round(micros);
}

function usageColumns(
  modelName: string | null | undefined,
  usage: LlmTurnUsage,
): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsdMicros: number | null;
  llmCallCount: number;
} {
  return {
    inputTokens: usage.llmCallCount > 0 ? usage.inputTokens : null,
    outputTokens: usage.llmCallCount > 0 ? usage.outputTokens : null,
    totalTokens: usage.llmCallCount > 0 ? usage.totalTokens : null,
    costUsdMicros: computeCostUsdMicros(modelName, usage),
    llmCallCount: usage.llmCallCount,
  };
}

const router: IRouter = Router();

router.use("/accounting", requireAuth);

const AGENT_INSTRUCTIONS = `You are the internal accounting copilot for Life House Reentry, a nonprofit organization.

Your job is to help users with:
- GAAP-aware accounting guidance
- transaction classification suggestions
- receipt and documentation requirements
- expense reporting workflows
- internal controls and audit readiness
- month-end close guidance
- nonprofit bookkeeping organization

Non-negotiable rules:
1. Never guess.
2. If evidence is missing, say so clearly in "missing_information" and lower your confidence.
3. Never invent GAAP rules, ASC references, balances, vendors, receipts, approvals, journal entries, or financial statement results.
4. Internal evidence rules:
   a. You may cite internal Life House policies/memos/documents in the "why" field ONLY if you obtained the supporting snippet from search_internal_policies in this same turn.
   b. Every internal claim must be supported by an entry in the top-level "sources" array.
   c. Each "sources" entry's snippet_id MUST be an exact snippet_id returned by search_internal_policies on this turn. The server will reject your response if any snippet_id was not actually returned.
   d. If search_internal_policies returns no_documents_indexed=true or no relevant matches, you have no internal evidence — say so in "missing_information" and leave "sources" as an empty array. General accounting reasoning is still allowed in "why" but must not claim to be based on internal documents.
   e. The Life House Chart of Accounts is configured (see CHART OF ACCOUNTS block appended below). When you reference a GL account, use the canonical "<code> — <name>" form from that list. Never invent codes that are not in the list. Use search_chart_of_accounts to discover or filter accounts.
5. Be conservative and audit-ready.
6. If the question affects filed financials, taxes, payroll, external reporting, bank movement, or final journal posting, set "human_review_needed" to true.
7. If a user asks for a classification decision without enough detail, ask for the missing facts in "missing_information".
8. Prefer internal consistency, documentation, and traceability over speed.
9. Note when nonprofit treatment may differ from for-profit presentation.
10. When the user provides page context describing what they are currently looking at, treat it as authoritative read-only background — do not invent details beyond what is provided.
11. You have read-only tools to inspect Life House records (current page record, programs, vendors, open approvals, missing receipts, reconciliation status, search). Call them whenever the user's question depends on actual Life House data — do NOT guess at what records exist. Tool results are the only authoritative internal data source you currently have.
12. For policy / procedure / memo questions, ALWAYS call search_internal_policies first. Cite the snippets you actually used in "sources". If nothing relevant comes back, say so in "missing_information" and do not pretend to have internal sources.
13a. The Chart of Accounts IS the source of truth for GL coding. Always pick a code from the canonical CHART OF ACCOUNTS block below (or from a fresh search_chart_of_accounts call). When drafting a journal entry, every line MUST use a real account_code from the list — accounts that are archived or have allow_manual_posting=false are rejected by the posting service. Programs (search_programs / search_chart_of_accounts mapping_type=program) are dimensions, NOT accounts.
13b. Use escalate_to_human only when human accountant judgment, oversight, or sign-off is genuinely required. Use create_followup_task to leave the current user an actionable reminder. Use draft_memo to produce a draft document the user can copy — never claim a memo was sent or saved.
14. Hard tool boundaries (Step 6 — drafting only):
    - You have FOUR drafting tools: draft_journal_entry, draft_memo, create_followup_task, escalate_to_human.
    - Every draft is saved with status="pending_review" and requires a human reviewer to approve before any downstream effect occurs.
    - You CANNOT post journal entries, change account balances, approve or reject expenses/bills, mark anything compliant, send external emails, or alter any financial record. The tools simply do not have those capabilities.
    - draft_journal_entry validates that debits equal credits to the cent AND that every line's account_code resolves to an active, manually-postable Chart of Accounts row before saving; unbalanced or invalid-account drafts are rejected and you must fix them.
    - When you draft an action, name it explicitly in your "answer" (e.g., "I drafted a journal entry for review") and put a high-level summary of the proposal in "recommended_next_step". Do not pretend a draft has been posted, sent, or approved.
    - escalate_to_human additionally creates an admin notification immediately (because that IS the purpose of escalation) and is also recorded as an agent_action for acknowledgement.

You MUST respond with a single JSON object that strictly matches the response schema. Use the literal string "None" in any narrative field that genuinely does not apply. Do not use Markdown headings inside fields — the UI provides the structure.`;

/**
 * Step 9: build the live system prompt by appending a snapshot of the active
 * Chart of Accounts. Loaded once per agent turn so any CoA edits show up
 * immediately without restarting the model. Only active rows are listed
 * — archived accounts are intentionally hidden so the model doesn't try to
 * reference them.
 */
async function buildAgentInstructions(): Promise<string> {
  const rows = await db
    .select({
      code: chartOfAccountsTable.code,
      name: chartOfAccountsTable.name,
      type: chartOfAccountsTable.type,
      normalBalance: chartOfAccountsTable.normalBalance,
      allowManualPosting: chartOfAccountsTable.allowManualPosting,
    })
    .from(chartOfAccountsTable)
    .where(eq(chartOfAccountsTable.isActive, true))
    .orderBy(asc(chartOfAccountsTable.code));
  if (rows.length === 0) {
    return `${AGENT_INSTRUCTIONS}

CHART OF ACCOUNTS:
(empty — no active accounts configured. State this explicitly in "missing_information" if the question depends on the CoA.)`;
  }
  const lines: string[] = [];
  for (const r of rows) {
    const flag = r.allowManualPosting ? "" : " [HEADER — no manual posting]";
    lines.push(
      `- ${r.code} — ${r.name} (${r.type}, normal ${r.normalBalance})${flag}`,
    );
  }
  return `${AGENT_INSTRUCTIONS}

CHART OF ACCOUNTS (active accounts only — use these exact codes):
${lines.join("\n")}`;
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "answer",
    "why",
    "missing_information",
    "risk_flags",
    "recommended_next_step",
    "human_review_needed",
    "confidence",
    "sources",
  ],
  properties: {
    answer: { type: "string", minLength: 1 },
    why: { type: "string" },
    missing_information: { type: "string" },
    risk_flags: { type: "string" },
    recommended_next_step: { type: "string" },
    human_review_needed: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    sources: {
      type: "array",
      description:
        "Internal evidence cited in this answer. Each entry MUST be an exact snippet_id returned by search_internal_policies on this turn. Empty array if no internal documents were used.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["snippet_id", "why_relevant"],
        properties: {
          snippet_id: { type: "string", minLength: 1, maxLength: 200 },
          why_relevant: { type: "string", minLength: 1, maxLength: 600 },
        },
      },
    },
  },
} as const;

const AGENT_MODEL = process.env["ACCOUNTING_AGENT_MODEL"] ?? "gpt-5.4";
const apiKey = process.env["OPENAI_API_KEY"];
const openai = apiKey ? new OpenAI({ apiKey }) : null;

const MAX_TOTAL_CHARS = 60_000;
const RECORD_TYPES = [
  "none",
  "bill",
  "expense",
  "vendor",
  "program",
  "credit",
  "month-end",
  "report",
  "transaction",
  "accounting",
] as const;

const PageContextSchema = z
  .object({
    route: z.string().min(1).max(200),
    recordType: z.enum(RECORD_TYPES).default("none"),
    recordId: z
      .union([z.string().max(100), z.number()])
      .nullable()
      .default(null),
    entityLabel: z.string().max(120).nullable().default(null),
    visibleSummary: z
      .record(
        z.string().max(80),
        z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
      )
      .default({}),
  })
  .strict()
  .superRefine((val, ctx) => {
    const keys = Object.keys(val.visibleSummary);
    if (keys.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visibleSummary may have at most 20 keys",
      });
    }
    if (JSON.stringify(val.visibleSummary).length > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visibleSummary exceeds 4KB",
      });
    }
    if (JSON.stringify(val).length > 8192) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pageContext exceeds 8KB",
      });
    }
  });

type PageContext = z.infer<typeof PageContextSchema>;

const SendMessageBody = z.object({
  message: z.string().min(1).max(20_000),
  pageContext: PageContextSchema.optional(),
});

const PatchThreadBody = z.object({
  title: z.string().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});

// ---- Per-user rate limit (in-memory, sliding 60s window) -----------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateBuckets = new Map<number, number[]>();

function checkRateLimit(userId: number): boolean {
  const now = Date.now();
  const bucket = (rateBuckets.get(userId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(userId, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  return true;
}

// ---- Helpers -------------------------------------------------------------
function serializeThread(t: CopilotThreadRow) {
  return {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    archivedAt: t.archivedAt,
  };
}

function serializeMessage(m: CopilotMessageRow) {
  return {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    status: m.status,
    userText: m.userText,
    answer: m.answer,
    why: m.why,
    missingInformation: m.missingInformation,
    riskFlags: m.riskFlags,
    recommendedNextStep: m.recommendedNextStep,
    humanReviewNeeded: m.humanReviewNeeded,
    confidence: m.confidence,
    pageContext: m.pageContext,
    modelName: m.modelName,
    latencyMs: m.latencyMs,
    errorCode: m.errorCode,
    // Step 7: per-turn cost/usage attribution.
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    totalTokens: m.totalTokens,
    costUsdMicros: m.costUsdMicros,
    llmCallCount: m.llmCallCount,
    createdAt: m.createdAt,
  };
}

async function loadOwnedThread(
  threadId: number,
  userId: number,
): Promise<CopilotThreadRow | null> {
  if (!Number.isInteger(threadId) || threadId <= 0) return null;
  const [thread] = await db
    .select()
    .from(copilotThreadsTable)
    .where(
      and(
        eq(copilotThreadsTable.id, threadId),
        eq(copilotThreadsTable.userId, userId),
      ),
    );
  return thread ?? null;
}

function buildPageContextBlock(ctx: PageContext): string {
  const lines = [
    `route: ${ctx.route}`,
    `record_type: ${ctx.recordType}`,
  ];
  if (ctx.recordId !== null && ctx.recordId !== undefined) {
    lines.push(`record_id: ${ctx.recordId}`);
  }
  if (ctx.entityLabel) {
    lines.push(`entity_label: ${ctx.entityLabel}`);
  }
  const keys = Object.keys(ctx.visibleSummary);
  if (keys.length > 0) {
    lines.push("visible_summary:");
    for (const k of keys) {
      lines.push(`  ${k}: ${JSON.stringify(ctx.visibleSummary[k])}`);
    }
  }
  return [
    "[page_context — read-only background, what the user is currently viewing]",
    ...lines,
  ].join("\n");
}

function trimHistoryToBudget(
  prior: CopilotMessageRow[],
  newUserMessage: string,
  pageContextBlock: string | null,
): CopilotMessageRow[] {
  let total = newUserMessage.length + (pageContextBlock?.length ?? 0);
  const kept: CopilotMessageRow[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i]!;
    const len =
      (m.userText?.length ?? 0) +
      (m.answer?.length ?? 0) +
      (m.why?.length ?? 0) +
      (m.missingInformation?.length ?? 0) +
      (m.riskFlags?.length ?? 0) +
      (m.recommendedNextStep?.length ?? 0);
    if (total + len > MAX_TOTAL_CHARS) break;
    total += len;
    kept.unshift(m);
  }
  return kept;
}

function messageToInput(
  m: CopilotMessageRow,
): { role: "user" | "assistant"; content: string } | null {
  if (m.role === "user" && m.userText) {
    return { role: "user", content: m.userText };
  }
  if (m.role === "assistant" && m.status === "ok" && m.answer) {
    return {
      role: "assistant",
      content: JSON.stringify({
        answer: m.answer,
        why: m.why ?? "",
        missing_information: m.missingInformation ?? "",
        risk_flags: m.riskFlags ?? "",
        recommended_next_step: m.recommendedNextStep ?? "",
        human_review_needed: m.humanReviewNeeded ?? false,
        confidence: m.confidence ?? "low",
      }),
    };
  }
  return null;
}

function deriveTitle(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}…`;
}

async function linkToolCallsToMessage(
  toolCallIds: number[],
  assistantMessageId: number,
): Promise<void> {
  if (toolCallIds.length === 0) return;
  await db
    .update(copilotToolCallsTable)
    .set({ assistantMessageId })
    .where(inArray(copilotToolCallsTable.id, toolCallIds));
}

/**
 * Back-fills agent_action rows created during the turn with the resulting
 * assistant message id and (when available) the final cited evidence.
 * Always runs — even on error paths — so drafts remain attributable.
 */
async function linkAgentActionsToMessage(
  agentActionIds: number[],
  assistantMessageId: number,
  finalEvidence: Record<string, unknown> | null,
): Promise<void> {
  if (agentActionIds.length === 0) return;
  if (finalEvidence) {
    await db
      .update(agentActionsTable)
      .set({
        assistantMessageId,
        evidence: sql`COALESCE(${agentActionsTable.evidence}, '{}'::jsonb) || ${JSON.stringify(
          { final: finalEvidence },
        )}::jsonb`,
      })
      .where(inArray(agentActionsTable.id, agentActionIds));
  } else {
    await db
      .update(agentActionsTable)
      .set({ assistantMessageId })
      .where(inArray(agentActionsTable.id, agentActionIds));
  }
}

function serializeSource(s: CopilotMessageSourceRow): Record<string, unknown> {
  return {
    id: s.id,
    snippetId: s.snippetId,
    documentId: s.documentId,
    documentTitle: s.documentTitle,
    snippetText: s.snippetText,
    rank: s.rank,
    whyRelevant: s.whyRelevant,
    createdAt: s.createdAt,
  };
}

function serializeAgentAction(a: AgentActionRow): Record<string, unknown> {
  return {
    id: a.id,
    userId: a.userId,
    threadId: a.threadId,
    assistantMessageId: a.assistantMessageId,
    actionType: a.actionType,
    payload: a.payload,
    evidence: a.evidence,
    confidence: a.confidence,
    riskFlags: a.riskFlags,
    requiresHumanReview: a.requiresHumanReview,
    status: a.status,
    createdAt: a.createdAt,
    reviewedBy: a.reviewedBy,
    reviewedAt: a.reviewedAt,
    reviewNotes: a.reviewNotes,
  };
}

function serializeToolCall(t: CopilotToolCallRow): Record<string, unknown> {
  return {
    id: t.id,
    threadId: t.threadId,
    assistantMessageId: t.assistantMessageId,
    toolName: t.toolName,
    arguments: t.arguments,
    result: t.result,
    status: t.status,
    errorMessage: t.errorMessage,
    // Step 7: surface the role-scope denial reason on the wire so the UI
    // and tests can show it explicitly.
    deniedReason: t.deniedReason,
    latencyMs: t.latencyMs,
    createdAt: t.createdAt,
  };
}

function classifyError(err: unknown): {
  status: number;
  code: string;
  user: string;
} {
  const apiStatus =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : null;
  if (apiStatus === 429) {
    return {
      status: 502,
      code: "rate_or_quota_limited",
      user:
        "The copilot is unavailable. An administrator needs to verify the OpenAI billing status.",
    };
  }
  if (apiStatus === 401 || apiStatus === 403) {
    return {
      status: 502,
      code: "auth_failed",
      user: "The copilot is not configured correctly. Please contact an administrator.",
    };
  }
  return {
    status: 502,
    code: "upstream_error",
    user: "The copilot could not respond. Please try again.",
  };
}

// ---- Routes --------------------------------------------------------------

router.post("/accounting/threads", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const [thread] = await db
    .insert(copilotThreadsTable)
    .values({ userId })
    .returning();
  if (!thread) {
    res.status(500).json({ error: "Failed to create thread" });
    return;
  }
  res.json({ thread: serializeThread(thread) });
});

router.get("/accounting/threads", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const rows = await db
    .select({
      thread: copilotThreadsTable,
      messageCount: sql<number>`count(${copilotMessagesTable.id})::int`,
    })
    .from(copilotThreadsTable)
    .leftJoin(
      copilotMessagesTable,
      eq(copilotMessagesTable.threadId, copilotThreadsTable.id),
    )
    .where(
      and(
        eq(copilotThreadsTable.userId, userId),
        isNull(copilotThreadsTable.archivedAt),
      ),
    )
    .groupBy(copilotThreadsTable.id)
    .orderBy(desc(copilotThreadsTable.updatedAt));

  res.json({
    threads: rows.map((r) => ({
      ...serializeThread(r.thread),
      messageCount: r.messageCount ?? 0,
    })),
  });
});

router.get("/accounting/threads/:id", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const threadId = Number(req.params["id"]);
  const thread = await loadOwnedThread(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  const messages = await db
    .select()
    .from(copilotMessagesTable)
    .where(eq(copilotMessagesTable.threadId, threadId))
    .orderBy(asc(copilotMessagesTable.id));
  const assistantMsgIds = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.id);
  const [toolCalls, sources, actions] = await Promise.all([
    db
      .select()
      .from(copilotToolCallsTable)
      .where(eq(copilotToolCallsTable.threadId, threadId))
      .orderBy(asc(copilotToolCallsTable.id)),
    assistantMsgIds.length === 0
      ? Promise.resolve([] as CopilotMessageSourceRow[])
      : db
          .select()
          .from(copilotMessageSourcesTable)
          .where(
            inArray(
              copilotMessageSourcesTable.assistantMessageId,
              assistantMsgIds,
            ),
          )
          .orderBy(asc(copilotMessageSourcesTable.id)),
    db
      .select()
      .from(agentActionsTable)
      .where(eq(agentActionsTable.threadId, threadId))
      .orderBy(asc(agentActionsTable.id)),
  ]);
  const callsByMsg = new Map<number, CopilotToolCallRow[]>();
  for (const c of toolCalls) {
    if (c.assistantMessageId == null) continue;
    const arr = callsByMsg.get(c.assistantMessageId) ?? [];
    arr.push(c);
    callsByMsg.set(c.assistantMessageId, arr);
  }
  const sourcesByMsg = new Map<number, CopilotMessageSourceRow[]>();
  for (const s of sources) {
    const arr = sourcesByMsg.get(s.assistantMessageId) ?? [];
    arr.push(s);
    sourcesByMsg.set(s.assistantMessageId, arr);
  }
  const actionsByMsg = new Map<number, AgentActionRow[]>();
  for (const a of actions) {
    if (a.assistantMessageId == null) continue;
    const arr = actionsByMsg.get(a.assistantMessageId) ?? [];
    arr.push(a);
    actionsByMsg.set(a.assistantMessageId, arr);
  }
  res.json({
    thread: serializeThread(thread),
    messages: messages.map((m) => ({
      ...serializeMessage(m),
      toolCalls: (callsByMsg.get(m.id) ?? []).map(serializeToolCall),
      sources: (sourcesByMsg.get(m.id) ?? []).map(serializeSource),
      agentActions: (actionsByMsg.get(m.id) ?? []).map(serializeAgentAction),
    })),
  });
});

router.patch("/accounting/threads/:id", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const threadId = Number(req.params["id"]);
  const thread = await loadOwnedThread(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  const parsed = PatchThreadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }
  const updates: Partial<typeof copilotThreadsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.archived !== undefined) {
    updates.archivedAt = parsed.data.archived ? new Date() : null;
  }
  const [updated] = await db
    .update(copilotThreadsTable)
    .set(updates)
    .where(eq(copilotThreadsTable.id, threadId))
    .returning();
  res.json({ thread: serializeThread(updated!) });
});

// Hard delete the copilot thread and its messages ONLY. Cascades only within
// the copilot_messages table via the FK on copilot_messages.thread_id; nothing
// outside the copilot_* tables is touched.
router.delete("/accounting/threads/:id", async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const threadId = Number(req.params["id"]);
  const thread = await loadOwnedThread(threadId, userId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  await db
    .delete(copilotThreadsTable)
    .where(eq(copilotThreadsTable.id, threadId));
  res.status(204).end();
});

router.post(
  "/accounting/threads/:id/messages",
  async (req, res): Promise<void> => {
    const userId = req.authUser!.id;
    const threadId = Number(req.params["id"]);

    const thread = await loadOwnedThread(threadId, userId);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    if (!checkRateLimit(userId)) {
      res
        .status(429)
        .json({ error: "Too many messages — please wait a moment." });
      return;
    }

    const { message, pageContext } = parsed.data;

    const [userMessage] = await db
      .insert(copilotMessagesTable)
      .values({
        threadId,
        role: "user",
        status: "ok",
        userText: message,
        pageContext: pageContext ?? null,
      })
      .returning();

    const titleUpdates: Partial<typeof copilotThreadsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (!thread.title) {
      titleUpdates.title = deriveTitle(message);
    }
    await db
      .update(copilotThreadsTable)
      .set(titleUpdates)
      .where(eq(copilotThreadsTable.id, threadId));

    if (!openai) {
      const [assistantRow] = await db
        .insert(copilotMessagesTable)
        .values({
          threadId,
          role: "assistant",
          status: "error",
          errorCode: "key_missing",
          answer: null,
        })
        .returning();
      res.status(503).json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: serializeMessage(assistantRow!),
        error:
          "OPENAI_API_KEY is not configured on this server. Please add it as a secret to enable the accounting copilot.",
      });
      return;
    }

    const prior = await db
      .select()
      .from(copilotMessagesTable)
      .where(eq(copilotMessagesTable.threadId, threadId))
      .orderBy(asc(copilotMessagesTable.id));
    // Exclude the user message we just inserted (it'll be appended explicitly).
    const priorBeforeNow = prior.filter((m) => m.id !== userMessage!.id);

    const pageContextBlock = pageContext
      ? buildPageContextBlock(pageContext)
      : null;

    const trimmed = trimHistoryToBudget(
      priorBeforeNow,
      message,
      pageContextBlock,
    );

    const input: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of trimmed) {
      const item = messageToInput(m);
      if (item) input.push(item);
    }
    if (pageContextBlock) {
      input.push({ role: "user", content: pageContextBlock });
    }
    input.push({ role: "user", content: message });

    const startedAt = Date.now();
    const toolCallLogIds: number[] = [];
    const agentActionIds: number[] = [];
    const retrievedSnippets = new Map<string, RetrievedSnippet>();
    const turnUsage = emptyUsage();
    const toolCtx: CopilotToolContext = {
      user: req.authUser!,
      pageContext: (pageContext ?? null) as PageContextLike | null,
      threadId,
      retrievedSnippets,
      agentActionIds,
    };
    try {
      const liveInstructions = await buildAgentInstructions();
      let response = await openai.responses.create({
        model: AGENT_MODEL,
        instructions: liveInstructions,
        input: input as never,
        tools: getOpenAIToolDefinitions() as never,
        reasoning: { effort: "low", summary: "auto" },
        text: {
          format: {
            type: "json_schema",
            name: "gaap_copilot_reply",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
        store: true,
        metadata: {
          agent_name: "Life House GAAP Copilot",
          user_id: String(userId),
          thread_id: String(threadId),
        },
      });
      accumulateUsage(turnUsage, response as { usage?: unknown });

      let totalToolCalls = 0;
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const calls = ((response.output ?? []) as Array<Record<string, unknown>>).filter(
          (o) => o["type"] === "function_call",
        );
        if (calls.length === 0) break;
        if (totalToolCalls + calls.length > MAX_TOTAL_TOOL_CALLS) break;
        totalToolCalls += calls.length;

        const toolOutputs: Array<{
          type: "function_call_output";
          call_id: string;
          output: string;
        }> = [];

        for (const call of calls) {
          const name = String(call["name"]);
          const callId = String(call["call_id"]);
          const argsRaw = String(call["arguments"] ?? "{}");
          let parsedArgs: unknown = {};
          try {
            parsedArgs = JSON.parse(argsRaw);
          } catch {
            parsedArgs = { __parse_error: true };
          }
          const t0 = Date.now();
          const toolResult = await runTool(name, parsedArgs, toolCtx);
          const latency = Date.now() - t0;

          // Step 7: classify the outcome for status + denied_reason. A
          // denied tool call is NOT an exec failure — the tool body never
          // ran. We persist the row so the audit trail has the attempt,
          // and we feed a structured denial back to the model so it can
          // surface the denial to the user instead of silently retrying.
          const isDenied = !toolResult.ok && toolResult.denied === true;
          const status: "ok" | "error" | "denied" = toolResult.ok
            ? "ok"
            : isDenied
              ? "denied"
              : "error";

          const [logRow] = await db
            .insert(copilotToolCallsTable)
            .values({
              threadId,
              userId,
              toolName: name,
              arguments: parsedArgs as Record<string, unknown>,
              result: toolResult.ok
                ? (toolResult.data as Record<string, unknown>)
                : isDenied
                  ? { denied: true, error: toolResult.error }
                  : { error: toolResult.error },
              status,
              errorMessage: toolResult.ok ? null : toolResult.error,
              deniedReason: isDenied ? toolResult.error : null,
              latencyMs: latency,
            })
            .returning({ id: copilotToolCallsTable.id });
          if (logRow) toolCallLogIds.push(logRow.id);

          toolOutputs.push({
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(
              toolResult.ok
                ? toolResult.data
                : isDenied
                  ? { denied: true, error: toolResult.error }
                  : { error: toolResult.error },
            ),
          });
        }

        response = await openai.responses.create({
          model: AGENT_MODEL,
          tools: getOpenAIToolDefinitions() as never,
          input: toolOutputs as never,
          previous_response_id: response.id,
          reasoning: { effort: "low", summary: "auto" },
          text: {
            format: {
              type: "json_schema",
              name: "gaap_copilot_reply",
              strict: true,
              schema: RESPONSE_SCHEMA,
            },
          },
          store: true,
          metadata: {
            agent_name: "Life House GAAP Copilot",
            user_id: String(userId),
            thread_id: String(threadId),
            iteration: String(iter + 1),
          },
        });
        accumulateUsage(turnUsage, response as { usage?: unknown });
      }

      const latencyMs = Date.now() - startedAt;
      const text = (response.output_text ?? "").trim();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        req.log.error(
          { rawText: text },
          "Copilot returned non-JSON despite structured output",
        );
        const [assistantRow] = await db
          .insert(copilotMessagesTable)
          .values({
            threadId,
            role: "assistant",
            status: "error",
            errorCode: "schema_violation",
            modelName: response.model ?? AGENT_MODEL,
            latencyMs,
            ...usageColumns(response.model ?? AGENT_MODEL, turnUsage),
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
        await linkAgentActionsToMessage(agentActionIds, assistantRow!.id, {
          turn_status: "schema_violation_unparseable",
        });
        res.status(502).json({
          userMessage: serializeMessage(userMessage!),
          assistantMessage: serializeMessage(assistantRow!),
          error: "The copilot returned an unexpected response. Please retry.",
        });
        return;
      }

      const Shape = z.object({
        answer: z.string().min(1),
        why: z.string(),
        missing_information: z.string(),
        risk_flags: z.string(),
        recommended_next_step: z.string(),
        human_review_needed: z.boolean(),
        confidence: z.enum(["low", "medium", "high"]),
        sources: z
          .array(
            z.object({
              snippet_id: z.string().min(1).max(200),
              why_relevant: z.string().min(1).max(600),
            }),
          )
          .default([]),
      });
      const shaped = Shape.safeParse(parsedJson);
      if (!shaped.success) {
        req.log.error(
          { rawJson: parsedJson, issues: shaped.error.issues },
          "Copilot JSON failed schema validation",
        );
        const [assistantRow] = await db
          .insert(copilotMessagesTable)
          .values({
            threadId,
            role: "assistant",
            status: "error",
            errorCode: "schema_violation",
            modelName: response.model ?? AGENT_MODEL,
            latencyMs,
            rawResponseJson: parsedJson as Record<string, unknown>,
            ...usageColumns(response.model ?? AGENT_MODEL, turnUsage),
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
        await linkAgentActionsToMessage(agentActionIds, assistantRow!.id, {
          turn_status: "schema_violation",
        });
        res.status(502).json({
          userMessage: serializeMessage(userMessage!),
          assistantMessage: serializeMessage(assistantRow!),
          error: "The copilot returned an unexpected response. Please retry.",
        });
        return;
      }

      // Citation validation — every cited snippet_id MUST have actually been
      // returned by search_internal_policies in this turn. Otherwise the
      // model is fabricating evidence and the response must be rejected.
      const fabricated: string[] = [];
      for (const s of shaped.data.sources) {
        if (!retrievedSnippets.has(s.snippet_id)) {
          fabricated.push(s.snippet_id);
        }
      }
      if (fabricated.length > 0) {
        req.log.error(
          {
            fabricated,
            retrieved: Array.from(retrievedSnippets.keys()),
          },
          "Copilot cited snippet ids that were not retrieved this turn",
        );
        const [assistantRow] = await db
          .insert(copilotMessagesTable)
          .values({
            threadId,
            role: "assistant",
            status: "error",
            errorCode: "fabricated_citation",
            modelName: response.model ?? AGENT_MODEL,
            latencyMs,
            rawResponseJson: parsedJson as Record<string, unknown>,
            ...usageColumns(response.model ?? AGENT_MODEL, turnUsage),
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
        await linkAgentActionsToMessage(agentActionIds, assistantRow!.id, {
          turn_status: "fabricated_citation_rejected",
          fabricated_snippet_ids: fabricated,
        });
        res.status(502).json({
          userMessage: serializeMessage(userMessage!),
          assistantMessage: serializeMessage(assistantRow!),
          error:
            "The copilot cited internal evidence that was never retrieved. The response was rejected.",
          fabricatedSnippetIds: fabricated,
        });
        return;
      }

      // De-duplicate citations by snippet_id (keep the first whyRelevant)
      // so the model can't bloat the sources list by repeating the same id.
      const seenSnippetIds = new Set<string>();
      const dedupedSources = shaped.data.sources.filter((s) => {
        if (seenSnippetIds.has(s.snippet_id)) return false;
        seenSnippetIds.add(s.snippet_id);
        return true;
      });

      // Persist message and its sources atomically — never let an assistant
      // answer survive without its supporting evidence rows.
      const assistantRow = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(copilotMessagesTable)
          .values({
            threadId,
            role: "assistant",
            status: "ok",
            answer: shaped.data.answer,
            why: shaped.data.why,
            missingInformation: shaped.data.missing_information,
            riskFlags: shaped.data.risk_flags,
            recommendedNextStep: shaped.data.recommended_next_step,
            humanReviewNeeded: shaped.data.human_review_needed,
            confidence: shaped.data.confidence,
            rawResponseJson: parsedJson as Record<string, unknown>,
            modelName: response.model ?? AGENT_MODEL,
            latencyMs,
            ...usageColumns(response.model ?? AGENT_MODEL, turnUsage),
          })
          .returning();
        if (dedupedSources.length > 0) {
          await tx.insert(copilotMessageSourcesTable).values(
            dedupedSources.map((s) => {
              const snip = retrievedSnippets.get(s.snippet_id)!;
              return {
                assistantMessageId: row!.id,
                chunkId: snip.chunkId,
                documentId: snip.documentId,
                snippetText: snip.snippet,
                documentTitle: snip.documentTitle,
                snippetId: snip.snippetId,
                rank: String(snip.rank),
                whyRelevant: s.why_relevant,
              };
            }),
          );
        }
        return row!;
      });

      await linkToolCallsToMessage(toolCallLogIds, assistantRow.id);
      await linkAgentActionsToMessage(agentActionIds, assistantRow.id, {
        turn_status: "ok",
        sources: dedupedSources,
        why: shaped.data.why,
        missing_information: shaped.data.missing_information,
        recommended_next_step: shaped.data.recommended_next_step,
        human_review_needed: shaped.data.human_review_needed,
        confidence: shaped.data.confidence,
        risk_flags: shaped.data.risk_flags,
      });

      const [linkedToolCalls, linkedSources, linkedAgentActions] = await Promise.all([
        db
          .select()
          .from(copilotToolCallsTable)
          .where(eq(copilotToolCallsTable.assistantMessageId, assistantRow.id))
          .orderBy(asc(copilotToolCallsTable.id)),
        db
          .select()
          .from(copilotMessageSourcesTable)
          .where(
            eq(copilotMessageSourcesTable.assistantMessageId, assistantRow.id),
          )
          .orderBy(asc(copilotMessageSourcesTable.id)),
        db
          .select()
          .from(agentActionsTable)
          .where(eq(agentActionsTable.assistantMessageId, assistantRow.id))
          .orderBy(asc(agentActionsTable.id)),
      ]);

      await db
        .update(copilotThreadsTable)
        .set({ updatedAt: new Date() })
        .where(eq(copilotThreadsTable.id, threadId));

      res.json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: {
          ...serializeMessage(assistantRow),
          toolCalls: linkedToolCalls.map(serializeToolCall),
          sources: linkedSources.map(serializeSource),
          agentActions: linkedAgentActions.map(serializeAgentAction),
        },
      });
    } catch (err) {
      req.log.error({ err }, "Accounting copilot run failed");
      const latencyMs = Date.now() - startedAt;
      const cls = classifyError(err);
      // Step 7: even on the upstream/model-error catch path, persist any
      // tokens/cost we accumulated before the failure so the per-LLM-turn
      // cost ledger is not silently dropped on partial failures.
      const [assistantRow] = await db
        .insert(copilotMessagesTable)
        .values({
          threadId,
          role: "assistant",
          status: "error",
          errorCode: cls.code,
          modelName: AGENT_MODEL,
          latencyMs,
          ...usageColumns(AGENT_MODEL, turnUsage),
        })
        .returning();
      await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
      await linkAgentActionsToMessage(agentActionIds, assistantRow!.id, {
        turn_status: "model_error",
        error_code: cls.code,
      });
      res.status(cls.status).json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: serializeMessage(assistantRow!),
        error: cls.user,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Step 6 — agent_actions (drafts) review/approval endpoints
//
// Hard rules enforced here:
//   * The submitter (the user whose copilot turn produced the draft) cannot
//     approve or reject their own draft. They CAN cancel it while it is still
//     pending. This is the "submitters cannot self-approve" guardrail.
//   * Approve and reject are idempotent: once a row reaches a terminal state
//     (approved/rejected/canceled) further approve/reject calls return the
//     current state with HTTP 200 and do NOT re-run any side effect.
//   * Approving a create_followup_task is the ONLY action that creates a
//     downstream record (the notification). draft_journal_entry approval does
//     NOT post to any ledger — that capability does not exist in Step 6.
//   * Every state change (create / approve / reject / cancel) is also logged
//     to activity_log for an immutable audit trail outside this table.
// ---------------------------------------------------------------------------

const SELF_APPROVAL_ALLOWED_ROLES: ReadonlyArray<string> = [];

function canApproveAgentAction(
  reviewer: { id: number; role: string },
  action: AgentActionRow,
): { ok: true } | { ok: false; reason: string } {
  if (reviewer.id === action.userId) {
    if (!SELF_APPROVAL_ALLOWED_ROLES.includes(reviewer.role)) {
      return {
        ok: false,
        reason:
          "You cannot approve or reject a draft you submitted yourself. Ask another reviewer.",
      };
    }
  }
  return { ok: true };
}

router.get("/accounting/agent-actions", async (req, res): Promise<void> => {
  const status = String(req.query["status"] ?? "pending_review");
  const mineParam = String(req.query["mine"] ?? "false") === "true";
  const conds = [eq(agentActionsTable.status, status)];
  if (mineParam) {
    conds.push(eq(agentActionsTable.userId, req.authUser!.id));
  }
  const rows = await db
    .select()
    .from(agentActionsTable)
    .where(and(...conds))
    .orderBy(desc(agentActionsTable.createdAt))
    .limit(200);
  // Enrich with submitter + reviewer + linked sources.
  const userIds = new Set<number>();
  const msgIds = new Set<number>();
  for (const r of rows) {
    userIds.add(r.userId);
    if (r.reviewedBy) userIds.add(r.reviewedBy);
    if (r.assistantMessageId) msgIds.add(r.assistantMessageId);
  }
  const [users, sources] = await Promise.all([
    userIds.size === 0
      ? Promise.resolve([] as Array<{ id: number; firstName: string; lastName: string; email: string }>)
      : db
          .select({
            id: usersTable.id,
            firstName: usersTable.firstName,
            lastName: usersTable.lastName,
            email: usersTable.email,
          })
          .from(usersTable)
          .where(inArray(usersTable.id, Array.from(userIds))),
    msgIds.size === 0
      ? Promise.resolve([] as CopilotMessageSourceRow[])
      : db
          .select()
          .from(copilotMessageSourcesTable)
          .where(
            inArray(
              copilotMessageSourcesTable.assistantMessageId,
              Array.from(msgIds),
            ),
          ),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const sourcesByMsg = new Map<number, CopilotMessageSourceRow[]>();
  for (const s of sources) {
    const arr = sourcesByMsg.get(s.assistantMessageId) ?? [];
    arr.push(s);
    sourcesByMsg.set(s.assistantMessageId, arr);
  }
  res.json({
    actions: rows.map((r) => ({
      ...serializeAgentAction(r),
      submitter: userById.get(r.userId) ?? null,
      reviewer: r.reviewedBy ? userById.get(r.reviewedBy) ?? null : null,
      sources:
        r.assistantMessageId != null
          ? (sourcesByMsg.get(r.assistantMessageId) ?? []).map(serializeSource)
          : [],
    })),
    counts: { returned: rows.length, status },
  });
});

router.get("/accounting/agent-actions/:id", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(agentActionsTable)
    .where(eq(agentActionsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Agent action not found" });
    return;
  }
  const userIds = [row.userId, ...(row.reviewedBy ? [row.reviewedBy] : [])];
  const [users, sources] = await Promise.all([
    db
      .select({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
      })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds)),
    row.assistantMessageId == null
      ? Promise.resolve([] as CopilotMessageSourceRow[])
      : db
          .select()
          .from(copilotMessageSourcesTable)
          .where(
            eq(
              copilotMessageSourcesTable.assistantMessageId,
              row.assistantMessageId,
            ),
          ),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  res.json({
    action: {
      ...serializeAgentAction(row),
      submitter: userById.get(row.userId) ?? null,
      reviewer: row.reviewedBy ? userById.get(row.reviewedBy) ?? null : null,
      sources: sources.map(serializeSource),
    },
  });
});

const ReviewBody = z
  .object({ notes: z.string().max(2000).optional() })
  .strict();

async function reviewAgentAction(
  req: Request,
  res: Response,
  decision: "approved" | "rejected" | "canceled",
): Promise<void> {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsedBody = ReviewBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({
      error: parsedBody.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }
  const reviewer = req.authUser!;
  const notes = parsedBody.data.notes ?? null;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentActionsTable)
      .where(eq(agentActionsTable.id, id))
      .for("update");
    if (!row) return { kind: "not_found" as const };

    // Idempotency — already in a terminal state, return as-is.
    if (row.status !== "pending_review") {
      return { kind: "idempotent" as const, row };
    }

    // Permission checks per decision
    if (decision === "canceled") {
      if (row.userId !== reviewer.id && reviewer.role !== "admin") {
        return {
          kind: "forbidden" as const,
          reason: "Only the submitter or an admin can cancel a draft.",
        };
      }
    } else {
      const guard = canApproveAgentAction(
        { id: reviewer.id, role: reviewer.role },
        row,
      );
      if (!guard.ok) {
        return { kind: "forbidden" as const, reason: guard.reason };
      }
      if (decision === "rejected" && !notes) {
        return {
          kind: "bad_request" as const,
          reason: "A rejection note is required.",
        };
      }
    }

    // For approve, perform the (single) downstream side-effect for tasks.
    let downstream: Record<string, unknown> = {};
    if (decision === "approved" && row.actionType === "create_followup_task") {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const title = String(payload["title"] ?? "Follow-up");
      const body = String(payload["body"] ?? "");
      const assignedToUserId = Number(
        payload["assigned_to_user_id"] ?? row.userId,
      );
      const [n] = await tx
        .insert(notificationsTable)
        .values({
          userId: assignedToUserId,
          type: "copilot_followup",
          title: `Follow-up: ${title}`,
          body,
          link: `/accounting`,
          referenceType: "copilot_thread",
          referenceId: row.threadId,
          emailTo: null,
        })
        .returning({ id: notificationsTable.id });
      downstream = { notification_id: n?.id, assigned_to_user_id: assignedToUserId };
    }

    const updatedPayload = {
      ...((row.payload ?? {}) as Record<string, unknown>),
      ...(decision === "approved" &&
      row.actionType === "create_followup_task"
        ? { notification_created: true, ...downstream }
        : {}),
      ...(decision === "approved" && row.actionType === "draft_journal_entry"
        ? {
            ledger_posted: false,
            posting_outcome:
              "Approved for posting, but ledger posting is not implemented in Step 6. No financial record was modified.",
          }
        : {}),
    };

    const [updated] = await tx
      .update(agentActionsTable)
      .set({
        status: decision,
        reviewedBy: reviewer.id,
        reviewedAt: new Date(),
        reviewNotes: notes,
        payload: updatedPayload,
      })
      .where(eq(agentActionsTable.id, id))
      .returning();

    await tx.insert(activityLogTable).values({
      type: `copilot_draft_${decision}`,
      description: `${reviewer.firstName} ${reviewer.lastName} ${decision} ${row.actionType} draft #${row.id}`,
      actor: `${reviewer.firstName} ${reviewer.lastName}`,
      referenceId: row.id,
      referenceType: "agent_action",
    });

    return { kind: "ok" as const, row: updated! };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Agent action not found" });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(403).json({ error: result.reason });
    return;
  }
  if (result.kind === "bad_request") {
    res.status(400).json({ error: result.reason });
    return;
  }
  if (result.kind === "idempotent") {
    res.status(200).json({
      action: serializeAgentAction(result.row),
      idempotent: true,
      note: `Action was already ${result.row.status}; no change made.`,
    });
    return;
  }
  res.status(200).json({ action: serializeAgentAction(result.row) });
}

router.post(
  "/accounting/agent-actions/:id/approve",
  async (req, res): Promise<void> => {
    await reviewAgentAction(req, res, "approved");
  },
);
router.post(
  "/accounting/agent-actions/:id/reject",
  async (req, res): Promise<void> => {
    await reviewAgentAction(req, res, "rejected");
  },
);
router.post(
  "/accounting/agent-actions/:id/cancel",
  async (req, res): Promise<void> => {
    await reviewAgentAction(req, res, "canceled");
  },
);

// ===========================================================================
// Step 8 — Controlled ledger posting endpoints
//
// These routes are the ONLY way an approved JE draft becomes a real ledger
// row. The actual rules (idempotency, period-lock, role check, evidence
// snapshot, etc.) live in `lib/postingService.ts`. The handlers here are
// intentionally thin: parse + map result kinds to HTTP codes.
// ===========================================================================

function toPostingActor(req: Request): PostingActor {
  const u = req.authUser!;
  return {
    id: u.id,
    role: u.role as PostingActor["role"],
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    email: u.email ?? null,
  };
}

function serializeJournalEntry(
  je: typeof journalEntriesTable.$inferSelect,
  lines?: Array<typeof journalEntryLinesTable.$inferSelect>,
) {
  return {
    id: je.id,
    entryNo: je.entryNo,
    entryDate: je.entryDate,
    memo: je.memo,
    status: je.status,
    totalsDebitsCents: je.totalsDebitsCents,
    totalsCreditsCents: je.totalsCreditsCents,
    postedAt: je.postedAt,
    postedByUserId: je.postedByUserId,
    agentActionId: je.agentActionId,
    threadId: je.threadId,
    assistantMessageId: je.assistantMessageId,
    approverUserId: je.approverUserId,
    evidenceSnapshot: je.evidenceSnapshot,
    reversesJournalEntryId: je.reversesJournalEntryId,
    reversedByJournalEntryId: je.reversedByJournalEntryId,
    reversalReason: je.reversalReason,
    manualDraftId: je.manualDraftId,
    createdAt: je.createdAt,
    ...(lines ? { lines } : {}),
  };
}

router.post(
  "/accounting/agent-actions/:id/post",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await postApprovedJournalEntry(id, toPostingActor(req));
    switch (result.kind) {
      case "ok":
        res.status(result.idempotent ? 200 : 201).json({
          journalEntry: serializeJournalEntry(
            result.journalEntry,
            result.lines,
          ),
          agentAction: serializeAgentAction(result.agentAction),
          idempotent: result.idempotent,
        });
        return;
      case "not_found":
        res.status(404).json({ error: "Agent action not found" });
        return;
      case "wrong_action_type":
        res.status(400).json({
          error: `Only draft_journal_entry actions can be posted; got '${result.actionType}'.`,
          code: "WRONG_ACTION_TYPE",
        });
        return;
      case "not_approved":
        res.status(409).json({
          error: `Agent action is not approved (status='${result.status}'). Approve it first.`,
          code: "NOT_APPROVED",
        });
        return;
      case "forbidden":
        res
          .status(403)
          .json({ error: result.reason, code: "FORBIDDEN" });
        return;
      case "invalid_payload":
        res.status(422).json({
          error: result.reason,
          code: "INVALID_PAYLOAD",
        });
        return;
      case "unbalanced":
        res.status(422).json({
          error: `Posting refused: debits (${(result.debitsCents / 100).toFixed(2)}) do not equal credits (${(result.creditsCents / 100).toFixed(2)}).`,
          code: "UNBALANCED",
          debitsCents: result.debitsCents,
          creditsCents: result.creditsCents,
        });
        return;
      case "invalid_account": {
        const reasonText =
          result.reason === "unknown_account"
            ? `account '${result.account}' is not in the chart of accounts`
            : result.reason === "archived_account"
              ? `account '${result.account}' is archived`
              : `account '${result.account}' is not allowed for manual posting`;
        res.status(400).json({
          error: `Posting refused: line ${result.lineNo} — ${reasonText}.`,
          code: "INVALID_ACCOUNT",
          lineNo: result.lineNo,
          account: result.account,
          reason: result.reason,
        });
        return;
      }
      case "period_locked":
        res.status(409).json({
          error: `Posting refused: ${result.entryDate} falls in ${result.periodLabel ? `closed period '${result.periodLabel}'` : "no open accounting period"}.`,
          code: "PERIOD_LOCKED",
          entryDate: result.entryDate,
          periodLabel: result.periodLabel,
        });
        return;
    }
  },
);

router.post(
  "/accounting/journal-entries/:id/reverse",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const Body = z.object({ reason: z.string().min(1).max(2000) });
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid body",
      });
      return;
    }
    const result = await reverseJournalEntry(
      id,
      toPostingActor(req),
      parsed.data.reason,
    );
    switch (result.kind) {
      case "ok":
        res.status(result.idempotent ? 200 : 201).json({
          original: serializeJournalEntry(result.original),
          reversal: serializeJournalEntry(
            result.reversal,
            result.reversalLines,
          ),
          idempotent: result.idempotent,
        });
        return;
      case "not_found":
        res.status(404).json({ error: "Journal entry not found" });
        return;
      case "forbidden":
        res
          .status(403)
          .json({ error: result.reason, code: "FORBIDDEN" });
        return;
      case "missing_reason":
        res.status(400).json({
          error: "A reversal reason of at least 5 characters is required.",
          code: "MISSING_REASON",
        });
        return;
      case "period_locked":
        res.status(409).json({
          error: `Reversal refused: today (${result.entryDate}) falls in ${result.periodLabel ? `closed period '${result.periodLabel}'` : "no open accounting period"}.`,
          code: "PERIOD_LOCKED",
          entryDate: result.entryDate,
          periodLabel: result.periodLabel,
        });
        return;
    }
  },
);

// Manual journal entry posting from the UI. Admin or approver only — same
// role gate as the agent_action posting flow. The actual rules
// (account validation, balance, period lock) live in postingService so
// the manual path and the copilot draft → approval → post path stay in
// lockstep.
const ManualJournalEntryBody = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "entryDate must be YYYY-MM-DD",
  }),
  memo: z.string().min(1).max(2000),
  lines: z
    .array(
      z.object({
        type: z.enum(["debit", "credit"]),
        amount: z.number().positive().finite(),
        account_code: z.string().min(1).max(60),
        program: z.string().max(120).nullish(),
        fund: z.string().max(120).nullish(),
        memo: z.string().max(500).nullish(),
      }),
    )
    .min(2, { message: "At least two lines are required." })
    .max(100),
});

// Task 25A — accept v1/v3/v4/v5 UUIDs (canonical 8-4-4-4-12 hex). We do not
// accept arbitrary strings as keys: a UUID format keeps clients honest and
// makes accidental collisions across users effectively impossible.
const IDEMPOTENCY_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Task 25A — stable logical-payload fingerprint. Two requests have the same
// fingerprint iff they post the same JE: same date, same memo (trimmed),
// same lines (sorted by type+account+amount+program+fund+memo so JSON key
// order or array order cannot change the hash). Account is normalized to
// the account_code, since that's the field the posting service resolves.
function computeManualJeFingerprint(payload: {
  entryDate: string;
  memo: string;
  lines: Array<{
    type: "debit" | "credit";
    amount: number;
    account_code: string;
    program?: string | null;
    fund?: string | null;
    memo?: string | null;
  }>;
}): string {
  const normalized = {
    entry_date: payload.entryDate,
    memo: payload.memo.trim(),
    lines: payload.lines
      .map((ln) => ({
        type: ln.type,
        // Normalize amount to fixed-precision cents-as-string so 100 and
        // 100.00 hash identically.
        amount_cents: Math.round(Number(ln.amount) * 100).toString(),
        account_code: ln.account_code.trim(),
        program: ln.program ?? null,
        fund: ln.fund ?? null,
        memo: ln.memo ?? null,
      }))
      .sort((a, b) => {
        const ka = `${a.type}|${a.account_code}|${a.amount_cents}|${a.program ?? ""}|${a.fund ?? ""}|${a.memo ?? ""}`;
        const kb = `${b.type}|${b.account_code}|${b.amount_cents}|${b.program ?? ""}|${b.fund ?? ""}|${b.memo ?? ""}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

router.post(
  "/accounting/journal-entries",
  async (req, res): Promise<void> => {
    const role = req.authUser?.role;
    if (role !== "admin" && role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    // Task 25A — Idempotency-Key is REQUIRED on this endpoint. We do not
    // grandfather any caller: this route was only just shipped (Task #25)
    // and has no in-the-wild integrations to break.
    const rawKey = req.header("Idempotency-Key") ?? req.header("idempotency-key");
    if (typeof rawKey !== "string" || rawKey.length === 0) {
      res.status(400).json({
        error:
          "Missing required header 'Idempotency-Key'. Send a UUID (e.g. crypto.randomUUID()) so duplicate retries are safe.",
        code: "IDEMPOTENCY_KEY_REQUIRED",
      });
      return;
    }
    if (!IDEMPOTENCY_KEY_RE.test(rawKey)) {
      res.status(400).json({
        error:
          "Header 'Idempotency-Key' must be a UUID (8-4-4-4-12 hex, dash-separated).",
        code: "IDEMPOTENCY_KEY_INVALID",
      });
      return;
    }
    const idempotencyKey = rawKey.toLowerCase();

    const parsed = ManualJournalEntryBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid body",
        code: "INVALID_PAYLOAD",
      });
      return;
    }
    const fingerprint = computeManualJeFingerprint({
      entryDate: parsed.data.entryDate,
      memo: parsed.data.memo,
      lines: parsed.data.lines.map((ln) => ({
        type: ln.type,
        amount: ln.amount,
        account_code: ln.account_code,
        program: ln.program ?? null,
        fund: ln.fund ?? null,
        memo: ln.memo ?? null,
      })),
    });
    const result = await postManualJournalEntry(
      {
        entryDate: parsed.data.entryDate,
        memo: parsed.data.memo,
        lines: parsed.data.lines,
        idempotencyKey,
        fingerprint,
      },
      toPostingActor(req),
    );
    switch (result.kind) {
      case "ok":
        // Task 25A — 201 on first post, 200 on idempotent replay. Same
        // body shape both ways so clients can't tell the difference at
        // the JE-id level (which is the whole point).
        res.status(result.idempotent ? 200 : 201).json({
          journalEntry: serializeJournalEntry(
            result.journalEntry,
            result.lines,
          ),
          idempotent: result.idempotent,
        });
        return;
      case "idempotency_conflict":
        res.status(409).json({
          error:
            "Idempotency-Key was previously used with a different payload. Generate a new key for a different journal entry.",
          code: "IDEMPOTENCY_CONFLICT",
          idempotencyKey: result.idempotencyKey,
          existingJournalEntryId: result.existingJournalEntryId,
        });
        return;
      case "forbidden":
        res
          .status(403)
          .json({ error: result.reason, code: "FORBIDDEN" });
        return;
      case "invalid_payload":
        res.status(422).json({
          error: result.reason,
          code: "INVALID_PAYLOAD",
        });
        return;
      case "unbalanced":
        res.status(422).json({
          error: `Posting refused: debits (${(result.debitsCents / 100).toFixed(2)}) do not equal credits (${(result.creditsCents / 100).toFixed(2)}).`,
          code: "UNBALANCED",
          debitsCents: result.debitsCents,
          creditsCents: result.creditsCents,
        });
        return;
      case "invalid_account": {
        const reasonText =
          result.reason === "unknown_account"
            ? `account '${result.account}' is not in the chart of accounts`
            : result.reason === "archived_account"
              ? `account '${result.account}' is archived`
              : `account '${result.account}' is not allowed for manual posting`;
        res.status(400).json({
          error: `Posting refused: line ${result.lineNo} — ${reasonText}.`,
          code: "INVALID_ACCOUNT",
          lineNo: result.lineNo,
          account: result.account,
          reason: result.reason,
        });
        return;
      }
      case "period_locked":
        res.status(409).json({
          error: `Posting refused: ${result.entryDate} falls in ${result.periodLabel ? `closed period '${result.periodLabel}'` : "no open accounting period"}.`,
          code: "PERIOD_LOCKED",
          entryDate: result.entryDate,
          periodLabel: result.periodLabel,
        });
        return;
    }
  },
);

router.get(
  "/accounting/journal-entries",
  async (req, res): Promise<void> => {
    const role = req.authUser?.role;
    if (role !== "admin" && role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const q = req.query;
    const status = typeof q["status"] === "string" ? (q["status"] as string) : null;
    const source = typeof q["source"] === "string" ? (q["source"] as string) : null;
    const from = typeof q["from"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q["from"] as string)
      ? (q["from"] as string)
      : null;
    const to = typeof q["to"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q["to"] as string)
      ? (q["to"] as string)
      : null;
    const limitRaw = Number(q["limit"]);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
    const offsetRaw = Number(q["offset"]);
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const conds = [];
    if (status === "posted" || status === "reversed") {
      conds.push(eq(journalEntriesTable.status, status));
    }
    if (source === "copilot") {
      conds.push(sql`${journalEntriesTable.agentActionId} IS NOT NULL`);
    } else if (source === "manual") {
      conds.push(sql`${journalEntriesTable.agentActionId} IS NULL`);
    }
    if (from) {
      conds.push(sql`${journalEntriesTable.entryDate} >= ${from}`);
    }
    if (to) {
      conds.push(sql`${journalEntriesTable.entryDate} <= ${to}`);
    }
    const whereExpr = conds.length ? and(...conds) : undefined;

    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(journalEntriesTable)
        .where(whereExpr)
        .orderBy(desc(journalEntriesTable.postedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(journalEntriesTable)
        .where(whereExpr),
    ]);
    res.json({
      entries: rows.map((r) => serializeJournalEntry(r)),
      total: totalRow[0]?.count ?? 0,
      limit,
      offset,
    });
  },
);

router.get(
  "/accounting/journal-entries/:id",
  async (req, res): Promise<void> => {
    const role = req.authUser?.role;
    if (role !== "admin" && role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [je] = await db
      .select()
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.id, id));
    if (!je) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }
    const lines = await db
      .select()
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.journalEntryId, je.id))
      .orderBy(asc(journalEntryLinesTable.lineNo));
    res.json({ journalEntry: serializeJournalEntry(je, lines) });
  },
);

// --- Manual journal entry drafts ------------------------------------------
// Drafts let accountants save work-in-progress JE editor state and resume
// later. They never touch the ledger. Visibility is the user who created
// the draft, plus admin/approver reviewers.

const MAX_DRAFT_PAYLOAD_BYTES = 64 * 1024;

const DraftLineSchema = z.object({
  uid: z.number().optional(),
  type: z.enum(["debit", "credit"]),
  accountCode: z.string().max(60).default(""),
  amount: z.string().max(40).default(""),
  program: z.string().max(120).default(""),
  fund: z.string().max(120).default(""),
  memo: z.string().max(500).default(""),
});

const DraftPayloadSchema = z.object({
  entryDate: z.string().max(40).default(""),
  memo: z.string().max(2000).default(""),
  lines: z.array(DraftLineSchema).min(1).max(100),
});

const SaveDraftBody = z.object({
  payload: DraftPayloadSchema,
});

function canAccessDraft(
  draft: ManualJournalEntryDraftRow,
  user: { id: number; role: string },
): boolean {
  if (draft.createdByUserId === user.id) return true;
  return user.role === "admin" || user.role === "approver";
}

function serializeDraft(d: ManualJournalEntryDraftRow) {
  return {
    id: d.id,
    createdByUserId: d.createdByUserId,
    entryDate: d.entryDate,
    memo: d.memo,
    payload: d.payload,
    status: d.status,
    submittedByUserId: d.submittedByUserId,
    submittedAt: d.submittedAt,
    approvedByUserId: d.approvedByUserId,
    approvedAt: d.approvedAt,
    rejectedByUserId: d.rejectedByUserId,
    rejectedAt: d.rejectedAt,
    rejectionReason: d.rejectionReason,
    postedJournalEntryId: d.postedJournalEntryId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * Task #29B — load the (single-row) accounting_settings to determine
 * whether maker/checker separation is currently enforced. Defaults to
 * TRUE (i.e. enforce) on any failure so a missing/corrupt settings row
 * cannot silently downgrade the control.
 */
async function isSeparationOfDutiesEnforced(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ enforced: accountingSettingsTable.separationOfDuties })
      .from(accountingSettingsTable)
      .limit(1);
    if (!row) return true;
    return row.enforced !== false;
  } catch {
    return true;
  }
}

function actorLabel(u: {
  id: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  if (name.length > 0) return name;
  return u.email ?? `user#${u.id}`;
}

async function logDraftActivity(
  type:
    | "manual_je_draft_created"
    | "manual_je_draft_edited"
    | "manual_je_draft_submitted"
    | "manual_je_draft_approved"
    | "manual_je_draft_rejected"
    | "manual_je_draft_posted",
  draftId: number,
  actor: {
    id: number;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  },
  description: string,
): Promise<void> {
  await db.insert(activityLogTable).values({
    type,
    description,
    actor: actorLabel(actor),
    referenceId: draftId,
    referenceType: "manual_journal_entry_draft",
  });
}

function summarizeDraftHeader(payload: z.infer<typeof DraftPayloadSchema>): {
  entryDate: string | null;
  memo: string | null;
} {
  const entryDate = payload.entryDate.trim();
  const memo = payload.memo.trim();
  return {
    entryDate: /^\d{4}-\d{2}-\d{2}$/.test(entryDate) ? entryDate : null,
    memo: memo.length > 0 ? memo.slice(0, 2000) : null,
  };
}

router.get(
  "/accounting/journal-entry-drafts",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    const role = user.role;
    if (role !== "admin" && role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    // Reviewers (admin/approver) can choose to see all drafts or just
    // their own. Defaults to their own to keep the list focused.
    const scope =
      typeof req.query["scope"] === "string"
        ? (req.query["scope"] as string)
        : "mine";
    const conds = [];
    if (scope !== "all") {
      conds.push(eq(manualJournalEntryDraftsTable.createdByUserId, user.id));
    }
    const rows = await db
      .select({
        draft: manualJournalEntryDraftsTable,
        createdByEmail: usersTable.email,
        createdByFirstName: usersTable.firstName,
        createdByLastName: usersTable.lastName,
      })
      .from(manualJournalEntryDraftsTable)
      .leftJoin(
        usersTable,
        eq(usersTable.id, manualJournalEntryDraftsTable.createdByUserId),
      )
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(manualJournalEntryDraftsTable.updatedAt))
      .limit(200);
    res.json({
      drafts: rows.map((r) => ({
        ...serializeDraft(r.draft),
        createdBy: {
          id: r.draft.createdByUserId,
          email: r.createdByEmail,
          firstName: r.createdByFirstName,
          lastName: r.createdByLastName,
        },
      })),
    });
  },
);

router.post(
  "/accounting/journal-entry-drafts",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const parsed = SaveDraftBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid body",
        code: "INVALID_PAYLOAD",
      });
      return;
    }
    const payload = parsed.data.payload;
    if (JSON.stringify(payload).length > MAX_DRAFT_PAYLOAD_BYTES) {
      res
        .status(413)
        .json({ error: "Draft payload too large", code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    const summary = summarizeDraftHeader(payload);
    const [row] = await db
      .insert(manualJournalEntryDraftsTable)
      .values({
        createdByUserId: user.id,
        entryDate: summary.entryDate,
        memo: summary.memo,
        payload,
        status: "draft",
      })
      .returning();
    await logDraftActivity(
      "manual_je_draft_created",
      row!.id,
      user,
      `${actorLabel(user)} created manual JE draft #${row!.id}`,
    );
    res.status(201).json({ draft: serializeDraft(row!) });
  },
);

router.get(
  "/accounting/journal-entry-drafts/:id",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [draft] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!draft) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (!canAccessDraft(draft, user)) {
      res.status(403).json({ error: "Draft is owned by another user" });
      return;
    }
    res.json({ draft: serializeDraft(draft) });
  },
);

router.patch(
  "/accounting/journal-entry-drafts/:id",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = SaveDraftBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid body",
        code: "INVALID_PAYLOAD",
      });
      return;
    }
    const payload = parsed.data.payload;
    if (JSON.stringify(payload).length > MAX_DRAFT_PAYLOAD_BYTES) {
      res
        .status(413)
        .json({ error: "Draft payload too large", code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (!canAccessDraft(existing, user)) {
      res.status(403).json({ error: "Draft is owned by another user" });
      return;
    }
    // Task #29B — once a draft has left the author's hands it is locked.
    // Only 'draft' (never submitted) and 'rejected' (sent back for fixes)
    // are editable. Submitted/approved/posted drafts must be acted on via
    // the workflow endpoints, not silently mutated.
    if (existing.status !== "draft" && existing.status !== "rejected") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state and cannot be edited.`,
        code: "DRAFT_NOT_EDITABLE",
        status: existing.status,
      });
      return;
    }
    const summary = summarizeDraftHeader(payload);
    const [updated] = await db
      .update(manualJournalEntryDraftsTable)
      .set({
        payload,
        entryDate: summary.entryDate,
        memo: summary.memo,
        updatedAt: new Date(),
      })
      .where(eq(manualJournalEntryDraftsTable.id, id))
      .returning();
    await logDraftActivity(
      "manual_je_draft_edited",
      updated!.id,
      user,
      `${actorLabel(user)} edited manual JE draft #${updated!.id}`,
    );
    res.json({ draft: serializeDraft(updated!) });
  },
);

router.delete(
  "/accounting/journal-entry-drafts/:id",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (!canAccessDraft(existing, user)) {
      res.status(403).json({ error: "Draft is owned by another user" });
      return;
    }
    // Task #29B — keep approval-chain history. Once a draft has been
    // submitted, approved, or posted it must NEVER be deleted; otherwise
    // the activity_log rows pointing at draft#id would orphan and the
    // audit trail would be incomplete.
    if (existing.status !== "draft" && existing.status !== "rejected") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state and cannot be deleted.`,
        code: "DRAFT_NOT_DELETABLE",
        status: existing.status,
      });
      return;
    }
    await db
      .delete(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    res.status(204).end();
  },
);

// --- Task #29B — Manual JE approval workflow ------------------------------
// State machine:
//   draft     --submit-->  submitted
//   rejected  --submit-->  submitted
//   submitted --approve--> approved      (no self-approval when SoD on)
//   submitted --reject-->  rejected      (with rejection_reason)
//   approved  --post-->    posted        (calls postManualJournalEntry)
//
// Every transition writes a row to activity_log with a draft-scoped
// type so the full chain is reconstructible. The /post endpoint reuses
// the existing hardened postManualJournalEntry service via a
// deterministic Idempotency-Key derived from the draft id, so a retried
// post does NOT produce a second JE.

router.post(
  "/accounting/journal-entry-drafts/:id/submit",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (!canAccessDraft(existing, user)) {
      res.status(403).json({ error: "Draft is owned by another user" });
      return;
    }
    if (existing.status !== "draft" && existing.status !== "rejected") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state and cannot be submitted for review.`,
        code: "INVALID_STATE_TRANSITION",
        status: existing.status,
      });
      return;
    }
    const [updated] = await db
      .update(manualJournalEntryDraftsTable)
      .set({
        status: "submitted",
        submittedByUserId: user.id,
        submittedAt: new Date(),
        // Resubmission after a rejection: clear the prior rejection
        // metadata so the draft is fresh in the reviewer's queue but
        // the activity_log retains the historical rejection row.
        rejectedByUserId: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(manualJournalEntryDraftsTable.id, id))
      .returning();
    await logDraftActivity(
      "manual_je_draft_submitted",
      updated!.id,
      user,
      `${actorLabel(user)} submitted manual JE draft #${updated!.id} for approval`,
    );
    res.json({ draft: serializeDraft(updated!) });
  },
);

router.post(
  "/accounting/journal-entry-drafts/:id/approve",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (existing.status !== "submitted") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state; only 'submitted' drafts can be approved.`,
        code: "INVALID_STATE_TRANSITION",
        status: existing.status,
      });
      return;
    }
    // Server-side maker/checker enforcement. Honors
    // accounting_settings.separationOfDuties (default TRUE). Cannot be
    // bypassed by the client because the check uses the *stored*
    // submittedByUserId, not anything the client sends.
    const sodOn = await isSeparationOfDutiesEnforced();
    if (sodOn && existing.submittedByUserId === user.id) {
      res.status(403).json({
        error:
          "You submitted this draft and cannot also approve it (separation of duties).",
        code: "NO_SELF_APPROVAL",
      });
      return;
    }
    const [updated] = await db
      .update(manualJournalEntryDraftsTable)
      .set({
        status: "approved",
        approvedByUserId: user.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(manualJournalEntryDraftsTable.id, id))
      .returning();
    await logDraftActivity(
      "manual_je_draft_approved",
      updated!.id,
      user,
      `${actorLabel(user)} approved manual JE draft #${updated!.id}`,
    );
    res.json({ draft: serializeDraft(updated!) });
  },
);

const RejectDraftBody = z.object({
  reason: z.string().trim().min(5).max(500),
});

router.post(
  "/accounting/journal-entry-drafts/:id/reject",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = RejectDraftBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          "A rejection reason of at least 5 characters is required.",
        code: "INVALID_PAYLOAD",
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    if (existing.status !== "submitted") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state; only 'submitted' drafts can be rejected.`,
        code: "INVALID_STATE_TRANSITION",
        status: existing.status,
      });
      return;
    }
    const [updated] = await db
      .update(manualJournalEntryDraftsTable)
      .set({
        status: "rejected",
        rejectedByUserId: user.id,
        rejectedAt: new Date(),
        rejectionReason: parsed.data.reason,
        updatedAt: new Date(),
      })
      .where(eq(manualJournalEntryDraftsTable.id, id))
      .returning();
    await logDraftActivity(
      "manual_je_draft_rejected",
      updated!.id,
      user,
      `${actorLabel(user)} rejected manual JE draft #${updated!.id}: ${parsed.data.reason}`,
    );
    res.json({ draft: serializeDraft(updated!) });
  },
);

router.post(
  "/accounting/journal-entry-drafts/:id/post",
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    if (user.role !== "admin" && user.role !== "approver") {
      res.status(403).json({ error: "Admins or approvers only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(manualJournalEntryDraftsTable)
      .where(eq(manualJournalEntryDraftsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }
    // Posted is terminal-and-idempotent: if a previous post already
    // succeeded, return the linked JE rather than 409, so retries are
    // safe at the route layer too (defence in depth on top of the
    // service-level idempotency key).
    if (existing.status === "posted" && existing.postedJournalEntryId) {
      const [je] = await db
        .select()
        .from(journalEntriesTable)
        .where(eq(journalEntriesTable.id, existing.postedJournalEntryId));
      if (je) {
        const lines = await db
          .select()
          .from(journalEntryLinesTable)
          .where(eq(journalEntryLinesTable.journalEntryId, je.id))
          .orderBy(asc(journalEntryLinesTable.lineNo));
        res.status(200).json({
          draft: serializeDraft(existing),
          journalEntry: serializeJournalEntry(je, lines),
          idempotent: true,
        });
        return;
      }
    }
    if (existing.status !== "approved") {
      res.status(409).json({
        error: `Draft is in '${existing.status}' state; only 'approved' drafts can be posted to the ledger.`,
        code: "INVALID_STATE_TRANSITION",
        status: existing.status,
      });
      return;
    }
    // Belt-and-braces: even though the approve route already enforces
    // SoD, re-check here so a future change that lets an admin self-
    // approve cannot accidentally also let them post their own draft.
    const sodOn = await isSeparationOfDutiesEnforced();
    if (sodOn && existing.submittedByUserId === user.id) {
      res.status(403).json({
        error:
          "You submitted this draft and cannot also post it (separation of duties).",
        code: "NO_SELF_APPROVAL",
      });
      return;
    }
    // Validate and re-shape the stored payload for the posting service.
    // Reuse the existing wire schema (ManualJournalEntryBody) so any
    // validation drift between save-time and post-time is caught here,
    // not silently posted.
    const draftPayload = (existing.payload ?? {}) as Record<string, unknown>;
    const toAmount = (v: unknown): number | unknown => {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = Number(v.trim());
        return Number.isFinite(n) ? n : v;
      }
      return v;
    };
    const adapted = {
      entryDate: draftPayload["entryDate"],
      memo: draftPayload["memo"],
      lines: Array.isArray(draftPayload["lines"])
        ? (draftPayload["lines"] as Array<Record<string, unknown>>).map((ln) => ({
            type: ln["type"],
            amount: toAmount(ln["amount"]),
            account_code: ln["accountCode"] ?? ln["account_code"],
            program:
              typeof ln["program"] === "string" && ln["program"].length > 0
                ? ln["program"]
                : null,
            fund:
              typeof ln["fund"] === "string" && ln["fund"].length > 0
                ? ln["fund"]
                : null,
            memo:
              typeof ln["memo"] === "string" && ln["memo"].length > 0
                ? ln["memo"]
                : null,
          }))
        : [],
    };
    const parsed = ManualJournalEntryBody.safeParse(adapted);
    if (!parsed.success) {
      res.status(422).json({
        error: `Draft payload failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        code: "INVALID_PAYLOAD",
      });
      return;
    }
    const fingerprint = computeManualJeFingerprint({
      entryDate: parsed.data.entryDate,
      memo: parsed.data.memo,
      lines: parsed.data.lines.map((ln) => ({
        type: ln.type,
        amount: ln.amount,
        account_code: ln.account_code,
        program: ln.program ?? null,
        fund: ln.fund ?? null,
        memo: ln.memo ?? null,
      })),
    });
    // Deterministic per-draft idempotency key. A retried /post call for
    // the same approved draft hits the Task 25A fast-path inside the
    // service and returns the same JE id — never a duplicate row. The
    // partial unique index on journal_entries.manual_draft_id is the
    // database-level guarantee.
    const idempotencyKey = `manual-draft-${existing.id}`;
    const result = await postManualJournalEntry(
      {
        entryDate: parsed.data.entryDate,
        memo: parsed.data.memo,
        lines: parsed.data.lines,
        idempotencyKey,
        fingerprint,
        manualDraftId: existing.id,
      },
      toPostingActor(req),
    );
    switch (result.kind) {
      case "ok": {
        // Mark the draft posted and link the JE. We do this AFTER the
        // service call returns so a posting failure leaves the draft in
        // 'approved' (retryable). On idempotent replay we still want
        // status='posted' / postedJournalEntryId set in case the prior
        // attempt died between insert and this update.
        const [updatedDraft] = await db
          .update(manualJournalEntryDraftsTable)
          .set({
            status: "posted",
            postedJournalEntryId: result.journalEntry.id,
            updatedAt: new Date(),
          })
          .where(eq(manualJournalEntryDraftsTable.id, existing.id))
          .returning();
        if (!result.idempotent) {
          await logDraftActivity(
            "manual_je_draft_posted",
            existing.id,
            user,
            `${actorLabel(user)} posted manual JE draft #${existing.id} as ${result.journalEntry.entryNo}`,
          );
        }
        res.status(result.idempotent ? 200 : 201).json({
          draft: serializeDraft(updatedDraft!),
          journalEntry: serializeJournalEntry(
            result.journalEntry,
            result.lines,
          ),
          idempotent: result.idempotent,
        });
        return;
      }
      case "idempotency_conflict":
        // Should be unreachable for the per-draft key (same key always
        // implies same draft → same payload), but surface clearly if it
        // ever happens (e.g. someone manually edited the JE row).
        res.status(409).json({
          error:
            "Posting key conflict: a previous post for this draft used a different payload. Investigate before retrying.",
          code: "IDEMPOTENCY_CONFLICT",
          existingJournalEntryId: result.existingJournalEntryId,
        });
        return;
      case "forbidden":
        res.status(403).json({ error: result.reason, code: "FORBIDDEN" });
        return;
      case "invalid_payload":
        res.status(422).json({ error: result.reason, code: "INVALID_PAYLOAD" });
        return;
      case "unbalanced":
        res.status(422).json({
          error: `Posting refused: debits (${(result.debitsCents / 100).toFixed(2)}) do not equal credits (${(result.creditsCents / 100).toFixed(2)}).`,
          code: "UNBALANCED",
          debitsCents: result.debitsCents,
          creditsCents: result.creditsCents,
        });
        return;
      case "invalid_account": {
        const reasonText =
          result.reason === "unknown_account"
            ? `account '${result.account}' is not in the chart of accounts`
            : result.reason === "archived_account"
              ? `account '${result.account}' is archived`
              : `account '${result.account}' is not allowed for manual posting`;
        res.status(400).json({
          error: `Posting refused: line ${result.lineNo} — ${reasonText}.`,
          code: "INVALID_ACCOUNT",
          lineNo: result.lineNo,
          account: result.account,
          reason: result.reason,
        });
        return;
      }
      case "period_locked":
        res.status(409).json({
          error: `Posting refused: ${result.entryDate} falls in ${result.periodLabel ? `closed period '${result.periodLabel}'` : "no open accounting period"}.`,
          code: "PERIOD_LOCKED",
          entryDate: result.entryDate,
          periodLabel: result.periodLabel,
        });
        return;
    }
  },
);

// --- Accounting periods management ----------------------------------------
router.get("/accounting/periods", async (req, res): Promise<void> => {
  const role = req.authUser?.role;
  if (role !== "admin" && role !== "approver") {
    res.status(403).json({ error: "Admins or approvers only" });
    return;
  }
  const rows = await db
    .select()
    .from(accountingPeriodsTable)
    .orderBy(desc(accountingPeriodsTable.periodStart));
  res.json({ periods: rows });
});

router.post("/accounting/periods", async (req, res): Promise<void> => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  const Body = z.object({
    label: z.string().min(1).max(100),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(["open", "closed"]).optional(),
  });
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }
  if (parsed.data.periodEnd < parsed.data.periodStart) {
    res
      .status(400)
      .json({ error: "periodEnd must be on or after periodStart" });
    return;
  }
  try {
    const [row] = await db
      .insert(accountingPeriodsTable)
      .values({
        label: parsed.data.label,
        periodStart: parsed.data.periodStart,
        periodEnd: parsed.data.periodEnd,
        status: parsed.data.status ?? "open",
      })
      .returning();
    res.status(201).json({ period: row });
  } catch (err) {
    req.log?.error({ err }, "create period failed");
    res.status(409).json({
      error: "Could not create period (label may already exist).",
    });
  }
});

router.post(
  "/accounting/periods/:id/close",
  async (req, res): Promise<void> => {
    if (req.authUser?.role !== "admin") {
      res.status(403).json({ error: "Admins only" });
      return;
    }
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Take the same row lock that postingService.findCoveringPeriod takes
    // (FOR UPDATE inside the posting tx). This guarantees that any in-flight
    // posting transaction either commits before this UPDATE runs (in which
    // case the JE is part of the now-closed period's history — accepted),
    // or it blocks here until the close commits and then *fails* its own
    // findCoveringPeriod check on retry. Without this lock the close could
    // commit while a posting tx is mid-flight and still allow the post to
    // commit — i.e., a closed-period bypass.
    const closedRow = await db.transaction(async (tx) => {
      const lockResult = (await tx.execute(sql`
        SELECT id FROM accounting_periods WHERE id = ${id} FOR UPDATE
      `)) as unknown as { rows: Array<{ id: number }> };
      if (lockResult.rows.length === 0) return null;
      const [updated] = await tx
        .update(accountingPeriodsTable)
        .set({
          status: "closed",
          closedAt: new Date(),
          closedByUserId: req.authUser!.id,
        })
        .where(eq(accountingPeriodsTable.id, id))
        .returning();
      return updated ?? null;
    });
    if (!closedRow) {
      res.status(404).json({ error: "Period not found" });
      return;
    }
    res.json({ period: closedRow });
  },
);

// Admin diagnostics — preview a single tool without invoking the model.
// This endpoint is TRULY non-mutating: it forces dryRun=true so the three
// side-effecting tools (escalate_to_human, create_followup_task, draft_memo)
// short-circuit and return a structured "what would have happened" preview
// without writing any rows. Read tools execute as normal. Calls are still
// logged to copilot_tool_calls for traceability, with status="preview".
router.post(
  "/accounting/diagnostics/tool-preview",
  async (req, res): Promise<void> => {
    if (req.authUser?.role !== "admin") {
      res.status(403).json({ error: "Admins only" });
      return;
    }
    const Body = z
      .object({
        threadId: z.number().int().positive(),
        toolName: z.string().min(1),
        arguments: z.unknown().optional(),
        pageContext: PageContextSchema.optional(),
      })
      .strict();
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const { threadId, toolName, arguments: args, pageContext } = parsed.data;
    const thread = await loadOwnedThread(threadId, req.authUser!.id);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const t0 = Date.now();
    const result = await runTool(toolName, args ?? {}, {
      user: req.authUser!,
      pageContext: (pageContext ?? null) as PageContextLike | null,
      threadId,
      retrievedSnippets: new Map(),
      dryRun: true,
    });
    const latencyMs = Date.now() - t0;
    // Step 7: even though this endpoint requires admin, runTool still goes
    // through the role-scope check; mirror the denied/error/preview classification
    // so the audit trail is consistent with the chat path.
    const isDenied = !result.ok && result.denied === true;
    const status: "preview" | "denied" | "error" = result.ok
      ? "preview"
      : isDenied
        ? "denied"
        : "error";
    const [logRow] = await db
      .insert(copilotToolCallsTable)
      .values({
        threadId,
        userId: req.authUser!.id,
        toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
        result: result.ok
          ? (result.data as Record<string, unknown>)
          : isDenied
            ? { denied: true, error: result.error }
            : { error: result.error },
        status,
        errorMessage: result.ok ? null : result.error,
        deniedReason: isDenied ? result.error : null,
        latencyMs,
      })
      .returning();
    res.json({ result, logRow, dryRun: true });
  },
);

// ---------------------------------------------------------------------------
// Document ingest (Step 5) — admin only. Documents are chunked and stored
// for full-text search via search_internal_policies.
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

function chunkText(content: string): Array<{
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
}> {
  const out: Array<{
    chunkIndex: number;
    content: string;
    charStart: number;
    charEnd: number;
  }> = [];
  if (content.length === 0) return out;
  let start = 0;
  let idx = 0;
  while (start < content.length) {
    let end = Math.min(start + CHUNK_SIZE, content.length);
    if (end < content.length) {
      // try to break at a paragraph or sentence boundary within the last 200 chars
      const tail = content.slice(end - 200, end);
      const breakRe = /[\n.!?]\s/g;
      let lastBreak = -1;
      let m: RegExpExecArray | null;
      while ((m = breakRe.exec(tail))) lastBreak = m.index + m[0].length;
      if (lastBreak > 0) end = end - 200 + lastBreak;
    }
    const slice = content.slice(start, end).trim();
    if (slice.length > 0) {
      out.push({
        chunkIndex: idx++,
        content: slice,
        charStart: start,
        charEnd: end,
      });
    }
    if (end >= content.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
}

router.post("/accounting/documents", async (req, res): Promise<void> => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  const Body = z
    .object({
      title: z.string().min(1).max(300),
      sourceType: z.string().min(1).max(40).default("policy"),
      sourceUrl: z.string().max(1000).optional().nullable(),
      content: z.string().min(20).max(500_000),
    })
    .strict();
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const chunks = chunkText(parsed.data.content);
  if (chunks.length === 0) {
    res.status(400).json({ error: "Document produced zero usable chunks." });
    return;
  }
  const [doc] = await db
    .insert(copilotDocumentsTable)
    .values({
      title: parsed.data.title,
      sourceType: parsed.data.sourceType,
      sourceUrl: parsed.data.sourceUrl ?? null,
      content: parsed.data.content,
      createdBy: req.authUser!.id,
    })
    .returning();
  await db.insert(copilotDocumentChunksTable).values(
    chunks.map((c) => ({
      documentId: doc!.id,
      chunkIndex: c.chunkIndex,
      content: c.content,
      charStart: c.charStart,
      charEnd: c.charEnd,
    })),
  );
  res.status(201).json({
    document: {
      id: doc!.id,
      title: doc!.title,
      sourceType: doc!.sourceType,
      sourceUrl: doc!.sourceUrl,
      isActive: doc!.isActive,
      createdAt: doc!.createdAt,
      chunkCount: chunks.length,
    },
  });
});

router.get("/accounting/documents", async (req, res): Promise<void> => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  const docs = await db
    .select({
      id: copilotDocumentsTable.id,
      title: copilotDocumentsTable.title,
      sourceType: copilotDocumentsTable.sourceType,
      sourceUrl: copilotDocumentsTable.sourceUrl,
      isActive: copilotDocumentsTable.isActive,
      createdAt: copilotDocumentsTable.createdAt,
      updatedAt: copilotDocumentsTable.updatedAt,
      chunkCount: sql<number>`(SELECT count(*)::int FROM copilot_document_chunks c WHERE c.document_id = ${copilotDocumentsTable.id})`,
    })
    .from(copilotDocumentsTable)
    .orderBy(desc(copilotDocumentsTable.createdAt));
  res.json({ documents: docs });
});

router.delete("/accounting/documents/:id", async (req, res): Promise<void> => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Soft-delete: keep the document row so historical citations on past
  // assistant messages still resolve, but exclude it from future searches.
  const [updated] = await db
    .update(copilotDocumentsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(copilotDocumentsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ ok: true, id, isActive: updated.isActive });
});

// Admin diagnostics — explicit ping only, never auto-pinged.
router.post("/accounting/diagnostics/ping", async (req, res): Promise<void> => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  if (!apiKey) {
    res.json({ status: "key_missing", detail: "OPENAI_API_KEY is not set." });
    return;
  }
  if (!openai) {
    res.json({ status: "unknown_error", detail: "OpenAI client not initialized." });
    return;
  }
  try {
    const r = await openai.responses.create({
      model: AGENT_MODEL,
      instructions: "Reply with exactly the word: PONG",
      input: [{ role: "user", content: "ping" }],
      max_output_tokens: 16,
      store: false,
    });
    res.json({
      status: "healthy",
      detail: `Model ${r.model} responded.`,
    });
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err && typeof err.status === "number"
        ? err.status
        : null;
    const message = err instanceof Error ? err.message : "Unknown error";
    let key: string;
    if (status === 401 || status === 403) key = "key_invalid";
    else if (status === 429) key = "billing_inactive";
    else if (status === 404) key = "model_unavailable";
    else key = "unknown_error";
    res.json({ status: key, detail: message });
  }
});

export default router;
