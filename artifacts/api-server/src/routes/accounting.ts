import { Router, type IRouter } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use("/accounting", requireAuth);

const AGENT_INSTRUCTIONS = `You are the internal accounting copilot for Life House Reentry.

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
2. If evidence is missing, say: "I don't have enough evidence to answer that safely."
3. Never invent GAAP rules, ASC references, balances, vendors, receipts, approvals, journal entries, or financial statement results.
4. Separate clearly:
   - facts from user-provided data
   - general accounting reasoning
   - items needing CPA/controller review
5. Be conservative and audit-ready.
6. If the question affects filed financials, taxes, payroll, external reporting, bank movement, or final journal posting, say it needs human accounting review before action.
7. If a user asks for a classification decision without enough detail, ask for the missing facts.
8. Prefer internal consistency, documentation, and traceability over speed.
9. Assume Life House Reentry is a nonprofit organization and note when nonprofit treatment may differ from for-profit presentation.
10. Keep answers practical and organized.

Always format your answer in these sections:

Answer:
Why:
Missing information:
Risk flags:
Recommended next step:`;

const AGENT_MODEL = process.env["ACCOUNTING_AGENT_MODEL"] ?? "gpt-5.4";

const apiKey = process.env["OPENAI_API_KEY"];
const openai = apiKey ? new OpenAI({ apiKey }) : null;

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
});

const ChatBody = z.object({
  message: z.string().min(1).max(20_000),
  history: z.array(ChatMessageSchema).max(40).default([]),
});

router.post("/accounting/chat", async (req, res): Promise<void> => {
  if (!openai) {
    res.status(503).json({
      error:
        "OPENAI_API_KEY is not configured on this server. Please add it as a secret to enable the accounting copilot.",
    });
    return;
  }

  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }

  const { message, history } = parsed.data;

  const MAX_TOTAL_CHARS = 60_000;
  const trimmed: typeof history = [];
  let total = message.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (total + item.content.length > MAX_TOTAL_CHARS) break;
    total += item.content.length;
    trimmed.unshift(item);
  }

  const input = [
    ...trimmed.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: message },
  ];

  try {
    const response = await openai.responses.create({
      model: AGENT_MODEL,
      instructions: AGENT_INSTRUCTIONS,
      input,
      reasoning: { effort: "low", summary: "auto" },
      store: true,
      metadata: {
        agent_name: "Life House GAAP Copilot",
        user_id: String(req.authUser?.id ?? ""),
      },
    });

    const text = (response.output_text ?? "").trim();
    if (!text) {
      res.status(502).json({ error: "Empty response from copilot." });
      return;
    }

    res.json({ reply: text });
  } catch (err) {
    req.log.error({ err }, "Accounting copilot run failed");
    const status =
      err && typeof err === "object" && "status" in err && typeof err.status === "number"
        ? err.status
        : null;
    const userMessage =
      status === 429
        ? "The copilot is temporarily unavailable (rate or quota limit). Please try again shortly."
        : status === 401 || status === 403
          ? "The copilot is not configured correctly. Please contact an administrator."
          : "The copilot could not respond. Please try again.";
    res.status(502).json({ error: userMessage });
  }
});

export default router;
