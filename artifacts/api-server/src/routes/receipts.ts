import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import { db } from "@workspace/db";
import { receiptsTable, vendorsTable, expensesTable, billsTable } from "@workspace/db";
import { eq, and, desc, count, sql, ilike, or } from "drizzle-orm";
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
    uploadedBy: r.uploadedBy ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

// Statuses where the linked expense/bill is still mutable enough that the
// uploader is allowed to remove their own attachment.
const MUTABLE_STATUSES = new Set([
  "draft",
  "submitted",
  "needs_correction",
]);

router.get("/receipts", async (req, res): Promise<void> => {
  const parsed = ListReceiptsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { search, vendorId, linked, linkedExpenseId, linkedBillId, page = 1 } =
    parsed.data;
  const pageSize = 20;

  const conditions = [];
  if (vendorId) conditions.push(eq(receiptsTable.vendorId, vendorId));
  if (linkedExpenseId)
    conditions.push(eq(receiptsTable.linkedExpenseId, linkedExpenseId));
  if (linkedBillId)
    conditions.push(eq(receiptsTable.linkedBillId, linkedBillId));
  if (search && search.trim().length > 0) {
    const term = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(receiptsTable.fileName, term),
        ilike(receiptsTable.ocrText, term),
      )!,
    );
  }
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

router.post("/receipts", requireRole("admin", "approver", "submitter"), async (req, res): Promise<void> => {
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
      linkedExpenseId: data.linkedExpenseId,
      linkedBillId: data.linkedBillId,
      uploadedBy: req.authUser?.id,
    })
    .returning();

  if (!receipt) {
    res.status(500).json({ error: "Failed to create receipt" });
    return;
  }

  // Append the receipt to the linked expense's receiptIds array so it no
  // longer shows up in the missing-receipts report.
  if (data.linkedExpenseId) {
    await db
      .update(expensesTable)
      .set({
        receiptIds: sql`array_append(coalesce(${expensesTable.receiptIds}, ARRAY[]::integer[]), ${receipt.id})`,
        updatedAt: new Date(),
      })
      .where(eq(expensesTable.id, data.linkedExpenseId));
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
      sql`(${expensesTable.receiptIds} is null or array_length(${expensesTable.receiptIds}, 1) is null)`
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
      status: e.status as
        | "draft"
        | "submitted"
        | "approved"
        | "reimbursed"
        | "rejected"
        | "needs_correction",
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
  const user = req.authUser;
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [existing] = await db
    .select()
    .from(receiptsTable)
    .where(eq(receiptsTable.id, parsed.data.id));
  if (!existing) {
    res.status(204).send();
    return;
  }

  // Permission model: admins can always delete. Otherwise, the uploader of the
  // receipt may delete it as long as it is unlinked or the linked
  // expense/bill is still in a mutable state (draft / submitted /
  // needs_correction). Approvers without those criteria are not granted
  // blanket delete rights anymore — deletion is ownership-based.
  const isAdmin = user.role === "admin";
  let allowed = isAdmin;
  if (!allowed && existing.uploadedBy === user.id) {
    if (existing.linkedExpenseId) {
      const [exp] = await db
        .select({ status: expensesTable.status })
        .from(expensesTable)
        .where(eq(expensesTable.id, existing.linkedExpenseId));
      allowed = !!exp && MUTABLE_STATUSES.has(exp.status);
    } else if (existing.linkedBillId) {
      const [bill] = await db
        .select({ status: billsTable.status })
        .from(billsTable)
        .where(eq(billsTable.id, existing.linkedBillId));
      allowed = !!bill && MUTABLE_STATUSES.has(bill.status);
    } else {
      // Unlinked receipt — uploader can clean up their own upload.
      allowed = true;
    }
  }
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(receiptsTable).where(eq(receiptsTable.id, parsed.data.id));
  // Remove the receipt id from any linked expense's receiptIds array so it
  // disappears from the attached-receipts list immediately.
  if (existing.linkedExpenseId) {
    await db
      .update(expensesTable)
      .set({
        receiptIds: sql`array_remove(${expensesTable.receiptIds}, ${existing.id})`,
        updatedAt: new Date(),
      })
      .where(eq(expensesTable.id, existing.linkedExpenseId));
  }
  res.status(204).send();
});

export default router;
