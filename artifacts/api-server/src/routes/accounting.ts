import { Router, type IRouter } from "express";
import { z } from "zod";
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
  type CopilotMessageRow,
  type CopilotThreadRow,
  type CopilotToolCallRow,
  type CopilotMessageSourceRow,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  getOpenAIToolDefinitions,
  runTool,
  type CopilotToolContext,
  type PageContextLike,
  type RetrievedSnippet,
} from "../lib/copilotTools";

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOTAL_TOOL_CALLS = 12;

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
   e. Never reference a chart of accounts as if Life House had one — there is no formal CoA configured.
5. Be conservative and audit-ready.
6. If the question affects filed financials, taxes, payroll, external reporting, bank movement, or final journal posting, set "human_review_needed" to true.
7. If a user asks for a classification decision without enough detail, ask for the missing facts in "missing_information".
8. Prefer internal consistency, documentation, and traceability over speed.
9. Note when nonprofit treatment may differ from for-profit presentation.
10. When the user provides page context describing what they are currently looking at, treat it as authoritative read-only background — do not invent details beyond what is provided.
11. You have read-only tools to inspect Life House records (current page record, programs, vendors, open approvals, missing receipts, reconciliation status, search). Call them whenever the user's question depends on actual Life House data — do NOT guess at what records exist. Tool results are the only authoritative internal data source you currently have.
12. For policy / procedure / memo questions, ALWAYS call search_internal_policies first. Cite the snippets you actually used in "sources". If nothing relevant comes back, say so in "missing_information" and do not pretend to have internal sources.
13a. There is no formal chart of accounts integration yet. search_chart_of_accounts returns no_formal_chart_of_accounts=true with related internal mappings (programs) for context only. Programs are NOT GL accounts. State the limitation explicitly in "missing_information".
13b. Use escalate_to_human only when human accountant judgment, oversight, or sign-off is genuinely required. Use create_followup_task to leave the current user an actionable reminder. Use draft_memo to produce a draft document the user can copy — never claim a memo was sent or saved.
14. Tool side effects are limited to creating notification records (escalations / follow-ups). Tools cannot post journal entries, change balances, change approval status, send email externally, or alter any record.

You MUST respond with a single JSON object that strictly matches the response schema. Use the literal string "None" in any narrative field that genuinely does not apply. Do not use Markdown headings inside fields — the UI provides the structure.`;

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
    .where(sql`${copilotToolCallsTable.id} = ANY(${toolCallIds})`);
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
  const [toolCalls, sources] = await Promise.all([
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
  res.json({
    thread: serializeThread(thread),
    messages: messages.map((m) => ({
      ...serializeMessage(m),
      toolCalls: (callsByMsg.get(m.id) ?? []).map(serializeToolCall),
      sources: (sourcesByMsg.get(m.id) ?? []).map(serializeSource),
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
    const retrievedSnippets = new Map<string, RetrievedSnippet>();
    const toolCtx: CopilotToolContext = {
      user: req.authUser!,
      pageContext: (pageContext ?? null) as PageContextLike | null,
      threadId,
      retrievedSnippets,
    };
    try {
      let response = await openai.responses.create({
        model: AGENT_MODEL,
        instructions: AGENT_INSTRUCTIONS,
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

          const [logRow] = await db
            .insert(copilotToolCallsTable)
            .values({
              threadId,
              userId,
              toolName: name,
              arguments: parsedArgs as Record<string, unknown>,
              result: toolResult.ok
                ? (toolResult.data as Record<string, unknown>)
                : { error: toolResult.error },
              status: toolResult.ok ? "ok" : "error",
              errorMessage: toolResult.ok ? null : toolResult.error,
              latencyMs: latency,
            })
            .returning({ id: copilotToolCallsTable.id });
          if (logRow) toolCallLogIds.push(logRow.id);

          toolOutputs.push({
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(
              toolResult.ok ? toolResult.data : { error: toolResult.error },
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
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
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
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
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
          })
          .returning();
        await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
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

      const [linkedToolCalls, linkedSources] = await Promise.all([
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
        },
      });
    } catch (err) {
      req.log.error({ err }, "Accounting copilot run failed");
      const latencyMs = Date.now() - startedAt;
      const cls = classifyError(err);
      const [assistantRow] = await db
        .insert(copilotMessagesTable)
        .values({
          threadId,
          role: "assistant",
          status: "error",
          errorCode: cls.code,
          modelName: AGENT_MODEL,
          latencyMs,
        })
        .returning();
      await linkToolCallsToMessage(toolCallLogIds, assistantRow!.id);
      res.status(cls.status).json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: serializeMessage(assistantRow!),
        error: cls.user,
      });
    }
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
    const [logRow] = await db
      .insert(copilotToolCallsTable)
      .values({
        threadId,
        userId: req.authUser!.id,
        toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
        result: result.ok
          ? (result.data as Record<string, unknown>)
          : { error: result.error },
        status: result.ok ? "preview" : "error",
        errorMessage: result.ok ? null : result.error,
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
