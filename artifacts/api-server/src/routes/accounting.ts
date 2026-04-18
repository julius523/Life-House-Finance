import { Router, type IRouter } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  copilotThreadsTable,
  copilotMessagesTable,
  type CopilotMessageRow,
  type CopilotThreadRow,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";

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
4. You currently have NO access to internal Life House documents, policies, chart of accounts, or transaction data. The "why" field must therefore reflect general accounting reasoning only — do NOT cite internal sources, file names, or document ids. Do NOT pretend to have looked anything up.
5. Be conservative and audit-ready.
6. If the question affects filed financials, taxes, payroll, external reporting, bank movement, or final journal posting, set "human_review_needed" to true.
7. If a user asks for a classification decision without enough detail, ask for the missing facts in "missing_information".
8. Prefer internal consistency, documentation, and traceability over speed.
9. Note when nonprofit treatment may differ from for-profit presentation.
10. When the user provides page context describing what they are currently looking at, treat it as authoritative read-only background — do not invent details beyond what is provided.

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
  ],
  properties: {
    answer: { type: "string", minLength: 1 },
    why: { type: "string" },
    missing_information: { type: "string" },
    risk_flags: { type: "string" },
    recommended_next_step: { type: "string" },
    human_review_needed: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
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
  res.json({
    thread: serializeThread(thread),
    messages: messages.map(serializeMessage),
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
    try {
      const response = await openai.responses.create({
        model: AGENT_MODEL,
        instructions: AGENT_INSTRUCTIONS,
        input,
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
        res.status(502).json({
          userMessage: serializeMessage(userMessage!),
          assistantMessage: serializeMessage(assistantRow!),
          error: "The copilot returned an unexpected response. Please retry.",
        });
        return;
      }

      const [assistantRow] = await db
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

      await db
        .update(copilotThreadsTable)
        .set({ updatedAt: new Date() })
        .where(eq(copilotThreadsTable.id, threadId));

      res.json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: serializeMessage(assistantRow!),
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
      res.status(cls.status).json({
        userMessage: serializeMessage(userMessage!),
        assistantMessage: serializeMessage(assistantRow!),
        error: cls.user,
      });
    }
  },
);

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
