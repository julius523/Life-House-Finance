import { Router, type IRouter } from "express";
import { getAutomationUserId, requireRole } from "../lib/auth";
import { isServiceCreatedRecord } from "../lib/apiKey";
import { canConsumeUpload } from "../lib/objectAuthz";
import { isAllowedMimeType } from "../lib/allowedMimeTypes";
import {
  canReadReceipt,
  isOwnExpense,
  isOwnBill,
  canMutateExpense,
  canMutateBill,
} from "../lib/recordAuthz";
import { db } from "@workspace/db";
import { receiptsTable, vendorsTable, expensesTable, billsTable, usersTable } from "@workspace/db";
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

async function getUploaderName(uploadedBy: number | null | undefined): Promise<string> {
  if (!uploadedBy) return "Unknown";
  const [u] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, uploadedBy));
  if (!u) return "Unknown";
  return `${u.firstName} ${u.lastName}`.trim() || "Unknown";
}

function formatReceipt(
  r: typeof receiptsTable.$inferSelect,
  vendorName?: string,
  uploadedByName?: string,
  automationUserId?: number | null,
) {
  // entrySource lets the UI badge automation-uploaded receipts (e.g.
  // "auto" pill) without exposing the raw service-account user id.
  // Resolves via the cached automation user id; if that lookup ever
  // fails (fresh DB before seedUsers ran) we fall back to "manual",
  // which is the safe default — automation rows can't exist without a
  // seeded service account.
  const entrySource: "automation" | "manual" = isServiceCreatedRecord({
    uploadedByUserId: r.uploadedBy,
    automationUserId: automationUserId ?? null,
  })
    ? "automation"
    : "manual";
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
    uploadedByName: uploadedByName ?? "Unknown",
    entrySource,
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

  // Task #107 — submitters only see receipts they uploaded. Admins and
  // approvers retain full visibility (approvers need it to review the
  // attached evidence on any submission).
  const user = req.authUser!;
  if (user.role === "submitter") {
    conditions.push(eq(receiptsTable.uploadedBy, user.id));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        receipt: receiptsTable,
        vendorName: vendorsTable.name,
        uploaderFirst: usersTable.firstName,
        uploaderLast: usersTable.lastName,
      })
      .from(receiptsTable)
      .leftJoin(vendorsTable, eq(vendorsTable.id, receiptsTable.vendorId))
      .leftJoin(usersTable, eq(usersTable.id, receiptsTable.uploadedBy))
      .where(where)
      .orderBy(desc(receiptsTable.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ cnt: count() }).from(receiptsTable).where(where),
  ]);

  const automationUserId = await getAutomationUserId();
  const items = rows.map(({ receipt, vendorName, uploaderFirst, uploaderLast }) => {
    const uploadedByName = uploaderFirst || uploaderLast
      ? `${uploaderFirst ?? ""} ${uploaderLast ?? ""}`.trim()
      : "Unknown";
    return formatReceipt(receipt, vendorName ?? undefined, uploadedByName, automationUserId);
  });

  res.json(ListReceiptsResponse.parse({ items, total: totalResult[0]?.cnt ?? 0, page }));
});

router.post("/receipts", requireRole("admin", "approver", "submitter", "service"), async (req, res): Promise<void> => {
  const user = req.authUser!;
  const parsed = CreateReceiptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;

  // Reject any receipt whose fileType is not on the safe allowlist to
  // prevent active-content types (HTML, SVG, etc.) from being stored
  // and later embedded or linked in the reviewer UI.
  if (data.fileType && !isAllowedMimeType(data.fileType)) {
    res.status(400).json({ error: "Unsupported file type" });
    return;
  }

  // Authz: a fileUrl must reference an object the caller actually uploaded
  // (or the caller must be admin). Without this guard, any user could attach
  // another user's private object to one of their own receipts and read it
  // back through GET /storage/objects/*.
  if (data.fileUrl) {
    const allowed = await canConsumeUpload(user, data.fileUrl);
    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  // Task #107 — when the caller links the receipt to an existing expense
  // or bill, verify they have mutate-rights on that target. Without this,
  // a submitter could attach a fabricated receipt to anyone else's
  // expense/bill (and even nudge it out of the missing-receipts report).
  if (data.linkedExpenseId !== undefined && data.linkedExpenseId !== null) {
    const [target] = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.id, data.linkedExpenseId));
    if (!target) {
      res.status(400).json({ error: "Linked expense not found" });
      return;
    }
    if (user.role === "submitter" && !isOwnExpense(user, target)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!canMutateExpense(user, target)) {
      res
        .status(403)
        .json({ error: "Linked expense is locked from edits at its current status" });
      return;
    }
  }
  if (data.linkedBillId !== undefined && data.linkedBillId !== null) {
    const [target] = await db
      .select()
      .from(billsTable)
      .where(eq(billsTable.id, data.linkedBillId));
    if (!target) {
      res.status(400).json({ error: "Linked bill not found" });
      return;
    }
    if (user.role === "submitter" && !isOwnBill(user, target)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!canMutateBill(user, target)) {
      res
        .status(403)
        .json({ error: "Linked bill is locked from edits at its current status" });
      return;
    }
  }

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

  const [vendorName, uploadedByName, automationUserId] = await Promise.all([
    getVendorName(receipt.vendorId),
    getUploaderName(receipt.uploadedBy),
    getAutomationUserId(),
  ]);
  res.status(201).json(GetReceiptResponse.parse(formatReceipt(receipt, vendorName, uploadedByName, automationUserId)));
});

router.get("/receipts/missing-report", async (req, res): Promise<void> => {
  const now = new Date();

  // Task #107 — submitters only see missing-receipt rows for their own
  // expenses. Admins / approvers retain the full org-wide report needed
  // for follow-up.
  const user = req.authUser!;
  const baseConditions = [
    sql`(${expensesTable.receiptIds} is null or array_length(${expensesTable.receiptIds}, 1) is null)`,
  ];
  if (user.role === "submitter") {
    // Authorize only by the unique email identifier. Display-name matching was
    // removed because names are not unique and could grant access to another
    // user's legacy rows.
    baseConditions.push(eq(expensesTable.submittedByEmail, user.email));
  }

  const expenses = await db
    .select()
    .from(expensesTable)
    .where(and(...baseConditions));

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
  // Task #107 — gate single-receipt reads. Admins/approvers can always
  // view; submitters can view only receipts they uploaded. Use 404 (not
  // 403) so we don't reveal which ids exist.
  if (!canReadReceipt(req.authUser!, receipt)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [vendorName, uploadedByName, automationUserId] = await Promise.all([
    getVendorName(receipt.vendorId),
    getUploaderName(receipt.uploadedBy),
    getAutomationUserId(),
  ]);
  res.json(GetReceiptResponse.parse(formatReceipt(receipt, vendorName, uploadedByName, automationUserId)));
});

router.delete("/receipts/:id", requireRole("admin", "approver", "submitter"), async (req, res): Promise<void> => {
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
