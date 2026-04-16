import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { transactionsTable, activityLogTable } from "@workspace/db";
import {
  ParseBankStatementBody,
  ParseBankStatementResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { z } from "zod";

const router: IRouter = Router();

const ParsedLineItemSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  description: z.string().min(1).max(2000),
  amount: z.number().finite().positive(),
  type: z.enum(["debit", "credit"]),
  merchant: z.string().min(1).max(200).optional(),
});
const AiResponseSchema = z.object({
  items: z.array(z.unknown()).default([]),
});
type ParsedLineItem = z.infer<typeof ParsedLineItemSchema>;

const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

const openai = baseURL && apiKey ? new OpenAI({ baseURL, apiKey }) : null;
const objectStorage = new ObjectStorageService();

const SYSTEM_PROMPT = `You are a meticulous bookkeeping assistant. You will be given the contents of a bank or credit card statement (as text or as an image). Extract every line item, both money out (debits / expenses / withdrawals / charges) and money in (credits / deposits / refunds / payments received). Ignore running balances and headers/footers.

Return ONLY a JSON object of the form:
{ "items": [ { "date": "YYYY-MM-DD", "description": "string", "amount": 12.34, "type": "debit" | "credit", "merchant": "string" } ] }

Rules:
- "amount" must always be a positive number (no currency symbols, no minus signs).
- "type" must be "debit" for money leaving the account or "credit" for money entering it.
- "date" must be ISO YYYY-MM-DD. If the year is missing, infer it from context or use the most plausible recent year.
- "merchant" is the cleaned up vendor or payer name when one is identifiable (e.g. "STARBUCKS #1234 SEATTLE WA" -> "Starbucks"). If unclear, omit.
- Do not include any text outside the JSON object.`;

router.post("/ai/parse-bank-statement", async (req, res): Promise<void> => {
  if (!openai) {
    res
      .status(503)
      .json({ error: "AI integration is not configured on this server." });
    return;
  }

  const parsed = ParseBankStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;

  let buffer: Buffer;
  try {
    const file = await objectStorage.getObjectEntityFile(data.objectPath);
    const [contents] = await file.download();
    buffer = contents;
  } catch (err) {
    req.log.error({ err }, "Failed to load uploaded statement");
    res.status(400).json({ error: "Could not load uploaded file" });
    return;
  }

  const isImage = data.contentType.startsWith("image/");

  let userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[];
  if (isImage) {
    const dataUrl = `data:${data.contentType};base64,${buffer.toString("base64")}`;
    userContent = [
      {
        type: "text",
        text: `Extract all debit and credit line items from this bank or credit-card statement image (${data.fileName}).`,
      },
      { type: "image_url", image_url: { url: dataUrl } },
    ];
  } else {
    const text = buffer.toString("utf8").slice(0, 60_000);
    userContent = [
      {
        type: "text",
        text: `Statement file: ${data.fileName} (${data.contentType}).\n\nContents:\n${text}`,
      },
    ];
  }

  let parsedItems: ParsedLineItem[] = [];
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const envelope = AiResponseSchema.safeParse(JSON.parse(raw));
    if (!envelope.success) {
      throw new Error("AI response did not match expected shape");
    }
    parsedItems = envelope.data.items.flatMap((candidate) => {
      const r = ParsedLineItemSchema.safeParse(candidate);
      return r.success ? [r.data] : [];
    });
  } catch (err) {
    req.log.error({ err }, "OpenAI bank statement parse failed");
    res
      .status(502)
      .json({ error: "Could not extract line items from this statement." });
    return;
  }

  if (parsedItems.length === 0) {
    res.json(
      ParseBankStatementResponse.parse({
        createdCount: 0,
        skippedCount: 0,
        transactions: [],
      })
    );
    return;
  }

  const inserted = await db
    .insert(transactionsTable)
    .values(
      parsedItems.map((it) => ({
        transactionDate: it.date,
        description: (it.merchant?.trim()
          ? `${it.merchant.trim()} — ${it.description}`
          : it.description
        ).slice(0, 500),
        amount: String(it.amount.toFixed(2)),
        type: it.type,
        status: "unmatched",
        bankAccountName: data.fileName,
      }))
    )
    .returning();

  if (inserted.length > 0) {
    const total = parsedItems.reduce(
      (sum, it) => sum + (it.type === "credit" ? it.amount : -it.amount),
      0
    );
    await db.insert(activityLogTable).values({
      type: "transaction_imported",
      description: `${inserted.length} transaction${inserted.length === 1 ? "" : "s"} imported from ${data.fileName}`,
      actor: data.submittedBy,
      amount: String(Math.abs(total).toFixed(2)),
      referenceType: "transaction",
    });
  }

  const transactionsPayload = inserted.map((t) => ({
    id: t.id,
    externalId: t.externalId ?? undefined,
    bankAccountId: t.bankAccountId ?? undefined,
    bankAccountName: t.bankAccountName ?? undefined,
    transactionDate: t.transactionDate,
    description: t.description,
    amount: parseFloat(t.amount),
    type: t.type as "debit" | "credit",
    status: t.status as "unmatched" | "matched" | "reconciled",
    matchedExpenseId: t.matchedExpenseId ?? undefined,
    matchedBillId: t.matchedBillId ?? undefined,
    matchedProgramId: t.matchedProgramId ?? undefined,
    notes: t.notes ?? undefined,
    importedAt: t.importedAt.toISOString(),
  }));

  res.json(
    ParseBankStatementResponse.parse({
      createdCount: inserted.length,
      skippedCount: 0,
      transactions: transactionsPayload,
    })
  );
});

export default router;
