import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { receiptsTable, vendorsTable, expensesTable } from "@workspace/db";
import { eq, ilike, and, desc, count, sql, isNull, isNotNull } from "drizzle-orm";
import {
  ListReceiptsQueryParams,
  ListReceiptsResponse,
  CreateReceiptBody,
  GetReceiptParams,
  GetReceiptResponse,
  DeleteReceiptParams,
  GetMissingReceiptsReportResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getVendorName(vendorId: number | null | undefined): Promise<string | undefined> {
  if (!vendorId) return undefined;
  const [v] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, vendorId));
  return v?.name;
}

function formatReceipt(r: typeof receiptsTable.$inferSelect, vendorName?: string) {
  return {
    id: r.id,
    fileName: r.fileName,
    fileType: r.fileType ?? undefined,
    fileUrl: r.fileUrl ?? undefined,
    ocrText: r.ocrText ?? undefined,
    vendorId: r.vendorId ?? undefined,
    vendorName,
    amount: r.amount ? parseFloat(r.amount) : undefined,
    receiptDate: r.receiptDate ?? undefined,
    tags: r.tags ?? undefined,
    linkedExpenseId: r.linkedExpenseId ?? undefined,
    linkedBillId: r.linkedBillId ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

router.get("/receipts", async (req, res): Promise<void> => {
  const parsed = ListReceiptsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { search, vendorId, linked, page = 1 } = parsed.data;
  const pageSize = 20;

  const conditions = [];
  if (vendorId) conditions.push(eq(receiptsTable.vendorId, vendorId));
  if (linked === true) {
    conditions.push(
      sql`(${receiptsTable.linkedExpenseId} is not null or ${receiptsTable.linkedBillId} is not null)`
    );
  } else if (linked === false) {
    conditions.push(
      sql`(${receiptsTable.linkedExpenseId} is null and ${receiptsTable.linkedBillId} is null)`
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [receipts, totalResult] = await Promise.all([
    db.select().from(receiptsTable).where(where).orderBy(desc(receiptsTable.createdAt)).limit(pageSize).offset(offset),
    db.select({ cnt: count() }).from(receiptsTable).where(where),
  ]);

  const items = await Promise.all(
    receipts.map(async (r) => {
      const vendorName = await getVendorName(r.vendorId);
      return formatReceipt(r, vendorName);
    })
  );

  res.json(ListReceiptsResponse.parse({ items, total: totalResult[0]?.cnt ?? 0, page }));
});

router.post("/receipts", async (req, res): Promise<void> => {
  const parsed = CreateReceiptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;
  const [receipt] = await db
    .insert(receiptsTable)
    .values({
      fileName: data.fileName,
      fileType: data.fileType,
      fileUrl: data.fileUrl,
      ocrText: data.ocrText,
      vendorId: data.vendorId,
      amount: data.amount !== undefined ? String(data.amount) : undefined,
      receiptDate: data.receiptDate,
      tags: data.tags,
    })
    .returning();

  if (!receipt) {
    res.status(500).json({ error: "Failed to create receipt" });
    return;
  }
  const vendorName = await getVendorName(receipt.vendorId);
  res.status(201).json(GetReceiptResponse.parse(formatReceipt(receipt, vendorName)));
});

router.get("/receipts/missing-report", async (_req, res): Promise<void> => {
  const now = new Date();
  const expenses = await db
    .select()
    .from(expensesTable)
    .where(
      sql`(${expensesTable.receiptIds} is null or array_length(${expensesTable.receiptIds}, 1) is null) and ${expensesTable.status} in ('submitted', 'approved')`
    );

  const items = expenses.map((e) => {
    const submittedDate = new Date(e.createdAt);
    const diffMs = now.getTime() - submittedDate.getTime();
    const daysSinceSubmission = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return {
      expenseId: e.id,
      submittedBy: e.submittedBy,
      merchant: e.merchant,
      amount: parseFloat(e.amount),
      expenseDate: e.expenseDate,
      daysSinceSubmission,
    };
  });

  res.json(GetMissingReceiptsReportResponse.parse(items));
});

router.get("/receipts/:id", async (req, res): Promise<void> => {
  const parsed = GetReceiptParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [receipt] = await db.select().from(receiptsTable).where(eq(receiptsTable.id, parsed.data.id));
  if (!receipt) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const vendorName = await getVendorName(receipt.vendorId);
  res.json(GetReceiptResponse.parse(formatReceipt(receipt, vendorName)));
});

router.delete("/receipts/:id", async (req, res): Promise<void> => {
  const parsed = DeleteReceiptParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(receiptsTable).where(eq(receiptsTable.id, parsed.data.id));
  res.status(204).send();
});

export default router;
