import { Router, type IRouter } from "express";
import { z } from "zod";
import { Agent, Runner, withTrace, type AgentInputItem } from "@openai/agents";
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
const WORKFLOW_ID =
  process.env["ACCOUNTING_AGENT_WORKFLOW_ID"] ??
  "wf_69e3afbdffe4819087b733d793cfd9c40d20075cce2ac38a";

const lifeHouseGaapCopilot = new Agent({
  name: "Life House GAAP Copilot",
  instructions: AGENT_INSTRUCTIONS,
  model: AGENT_MODEL,
  modelSettings: {
    reasoning: {
      effort: "low",
      summary: "auto",
    },
    store: true,
  },
});

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
});

const ChatBody = z.object({
  message: z.string().min(1).max(20_000),
  history: z.array(ChatMessageSchema).max(40).default([]),
});

function buildConversation(
  history: z.infer<typeof ChatMessageSchema>[],
  userMessage: string,
): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      items.push({
        role: "user",
        content: [{ type: "input_text", text: msg.content }],
      });
    } else {
      items.push({
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: msg.content }],
      });
    }
  }
  items.push({
    role: "user",
    content: [{ type: "input_text", text: userMessage }],
  });
  return items;
}

router.post("/accounting/chat", async (req, res): Promise<void> => {
  if (!process.env["OPENAI_API_KEY"]) {
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
  const conversation = buildConversation(history, message);

  try {
    const result = await withTrace("Life House GAAP Copilot", async () => {
      const runner = new Runner({
        traceMetadata: {
          __trace_source__: "agent-builder",
          workflow_id: WORKFLOW_ID,
        },
      });
      return runner.run(lifeHouseGaapCopilot, conversation);
    });

    const text =
      typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput);

    if (!text) {
      res.status(502).json({ error: "Empty response from copilot." });
      return;
    }

    res.json({ reply: text });
  } catch (err) {
    req.log.error({ err }, "Accounting copilot run failed");
    const message =
      err instanceof Error ? err.message : "Unknown error from copilot";
    res.status(502).json({ error: message });
  }
});

export default router;
