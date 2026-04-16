import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { expensesTable, activityLogTable } from "@workspace/db";
import {
  ParseBankStatementBody,
  ParseBankStatementResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { z } from "zod";

const router: IRouter = Router();

// Strict schema for the AI response. Anything that doesn't match this exact
// shape is rejected before we touch the database.
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

const SYSTEM_PROMPT = `You are a meticulous bookkeeping assistant. You will be given the contents of a bank or credit card statement (as text or as an image). Extract every line item that represents a debit (money going out / expense). Ignore credits (deposits, refunds, payments to the card), running balances, fees that are interest charges, and headers/footers.

Return ONLY a JSON object of the form:
{ "items": [ { "date": "YYYY-MM-DD", "description": "string", "amount": 12.34, "type": "debit", "merchant": "string" } ] }

Rules:
- "amount" must be a positive number (no currency symbols).
- "type" must be "debit" for expenses.
- "date" must be ISO YYYY-MM-DD. If the year is missing, infer it from context or use the most plausible recent year.
- "merchant" is the cleaned up vendor name when one is identifiable (e.g. "STARBUCKS #1234 SEATTLE WA" -> "Starbucks"). If unclear, omit.
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

  // Pull the file from object storage.
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

  // Build the OpenAI message. Images are sent as base64 data URLs; everything
  // else (CSV, plain text, PDF) is decoded as text. PDF text extraction here
  // is best-effort: many digital PDFs include extractable text in the bytes.
  let userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[];
  if (isImage) {
    const dataUrl = `data:${data.contentType};base64,${buffer.toString("base64")}`;
    userContent = [
      {
        type: "text",
        text: `Extract all expense line items from this bank or credit-card statement image (${data.fileName}).`,
      },
      { type: "image_url", image_url: { url: dataUrl } },
    ];
  } else {
    const text = buffer
      .toString("utf8")
      // Trim huge files so we stay well under the context window.
      .slice(0, 60_000);
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
    // Validate each item independently so a single bad row doesn't sink the
    // whole import — invalid rows are dropped and surfaced via skippedCount.
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

  // Filter to debits only.
  const debits = parsedItems.filter((it) => it.type !== "credit");

  if (debits.length === 0) {
    res.json(
      ParseBankStatementResponse.parse({
        createdCount: 0,
        skippedCount: parsedItems.length,
        expenses: [],
      })
    );
    return;
  }

  // Insert all as draft expenses.
  const inserted = await db
    .insert(expensesTable)
    .values(
      debits.map((it) => ({
        submittedBy: data.submittedBy,
        expenseDate: it.date,
        merchant: it.merchant?.trim() || it.description.slice(0, 80),
        description: it.description.slice(0, 500),
        amount: String(it.amount.toFixed(2)),
        paymentMethod: data.defaultPaymentMethod ?? "credit_card",
        programId: data.defaultProgramId,
        status: "draft",
      }))
    )
    .returning();

  if (inserted.length > 0) {
    await db.insert(activityLogTable).values({
      type: "transaction_imported",
      description: `${inserted.length} draft expense${inserted.length === 1 ? "" : "s"} imported from ${data.fileName}`,
      actor: data.submittedBy,
      amount: String(
        debits.reduce((sum, it) => sum + it.amount, 0).toFixed(2)
      ),
      referenceType: "expense",
    });
  }

  const expensesPayload = inserted.map((e) => ({
    id: e.id,
    submittedBy: e.submittedBy,
    submittedByEmail: e.submittedByEmail ?? undefined,
    expenseDate: e.expenseDate,
    merchant: e.merchant,
    description: e.description,
    amount: parseFloat(e.amount),
    paymentMethod: e.paymentMethod as
      | "cash"
      | "check"
      | "credit_card"
      | "debit_card"
      | "bank_transfer"
      | "other",
    programId: e.programId ?? undefined,
    status: e.status as
      | "draft"
      | "submitted"
      | "approved"
      | "rejected"
      | "reimbursed"
      | "needs_correction",
    receiptIds: e.receiptIds ?? undefined,
    rejectionReason: e.rejectionReason ?? undefined,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }));

  res.json(
    ParseBankStatementResponse.parse({
      createdCount: inserted.length,
      skippedCount: parsedItems.length - inserted.length,
      expenses: expensesPayload,
    })
  );
});

export default router;
