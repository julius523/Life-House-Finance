import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import { db } from "@workspace/db";
import { billsTable, vendorsTable, programsTable, activityLogTable, transactionsTable } from "@workspace/db";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { createNotification, findUserByEmail } from "../lib/notifications";
import {
  ListBillsQueryParams,
  ListBillsResponse,
  CreateBillBody,
  GetBillParams,
  GetBillResponse,
  UpdateBillParams,
  UpdateBillBody,
  UpdateBillResponse,
  ApproveBillParams,
  ApproveBillBody,
  ApproveBillResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getVendorName(vendorId: number): Promise<string> {
  const [v] = await db.select({ name: vendorsTable.name }).from(vendorsTable).where(eq(vendorsTable.id, vendorId));
  return v?.name ?? "Unknown Vendor";
}

async function getProgramName(programId: number | null | undefined): Promise<string | undefined> {
  if (!programId) return undefined;
  const [p] = await db.select({ name: programsTable.name }).from(programsTable).where(eq(programsTable.id, programId));
  return p?.name;
}

function formatBill(b: typeof billsTable.$inferSelect, vendorName: string, programName?: string) {
  return {
    id: b.id,
    vendorId: b.vendorId,
    vendorName,
    invoiceNumber: b.invoiceNumber ?? undefined,
    invoiceDate: b.invoiceDate ?? undefined,
    dueDate: b.dueDate,
    amount: parseFloat(b.amount),
    description: b.description ?? undefined,
    programId: b.programId ?? undefined,
    programName,
    status: b.status as "draft" | "submitted" | "approved" | "paid" | "overdue" | "rejected" | "needs_correction",
    approvedBy: b.approvedBy ?? undefined,
    rejectionReason: b.rejectionReason ?? undefined,
    paidDate: b.paidDate ?? undefined,
    receiptIds: b.receiptIds ?? undefined,
    submittedBy: b.submittedBy ?? undefined,
    submittedByEmail: b.submittedByEmail ?? undefined,
    createdAt: b.createdAt.toISOString(),
  };
}

router.get("/bills", async (req, res): Promise<void> => {
  const parsed = ListBillsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { status, vendorId, programId, submittedBy, submittedByEmail } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(billsTable.status, status));
  if (vendorId) conditions.push(eq(billsTable.vendorId, vendorId));
  if (programId) conditions.push(eq(billsTable.programId, programId));
  if (submittedBy) conditions.push(eq(billsTable.submittedBy, submittedBy));
  if (submittedByEmail)
    conditions.push(eq(billsTable.submittedByEmail, submittedByEmail));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const bills = await db.select().from(billsTable).where(where).orderBy(desc(billsTable.createdAt));

  const items = await Promise.all(
    bills.map(async (b) => {
      const vendorName = await getVendorName(b.vendorId);
      const programName = await getProgramName(b.programId);
      return formatBill(b, vendorName, programName);
    })
  );

  res.json(ListBillsResponse.parse(items));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = parsed.data;
  const submittedBy =
    (req.body && typeof req.body.submittedBy === "string"
      ? req.body.submittedBy.trim()
      : "") ||
    (req.authUser
      ? `${req.authUser.firstName} ${req.authUser.lastName}`
      : "Unknown");
  const submittedByEmail = req.authUser?.email ?? null;
  const [bill] = await db
    .insert(billsTable)
    .values({
      vendorId: data.vendorId,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      dueDate: data.dueDate,
      amount: String(data.amount),
      description: data.description,
      programId: data.programId,
      receiptIds: data.receiptIds,
      status: "submitted",
      submittedBy,
      submittedByEmail,
    })
    .returning();

  if (!bill) {
    res.status(500).json({ error: "Failed to create bill" });
    return;
  }

  const vendorName = await getVendorName(bill.vendorId);
  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill created for ${vendorName}`,
    actor: "Finance Staff",
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const programName = await getProgramName(bill.programId);
  res.status(201).json(GetBillResponse.parse(formatBill(bill, vendorName, programName)));
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const parsed = GetBillParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [bill] = await db.select().from(billsTable).where(eq(billsTable.id, parsed.data.id));
  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const vendorName = await getVendorName(bill.vendorId);
  const programName = await getProgramName(bill.programId);
  res.json(GetBillResponse.parse(formatBill(bill, vendorName, programName)));
});

router.put("/bills/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateBillParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateBillBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const data = bodyParsed.data;
  const updates: Record<string, unknown> = {};
  if (data.vendorId !== undefined) updates["vendorId"] = data.vendorId;
  if (data.invoiceNumber !== undefined) updates["invoiceNumber"] = data.invoiceNumber;
  if (data.invoiceDate !== undefined) updates["invoiceDate"] = data.invoiceDate;
  if (data.dueDate !== undefined) updates["dueDate"] = data.dueDate;
  if (data.amount !== undefined) updates["amount"] = String(data.amount);
  if (data.description !== undefined) updates["description"] = data.description;
  if (data.programId !== undefined) updates["programId"] = data.programId;
  if (data.receiptIds !== undefined) updates["receiptIds"] = data.receiptIds;

  const [bill] = await db
    .update(billsTable)
    .set(updates as Parameters<typeof db.update>[0] extends unknown ? never : unknown)
    .where(eq(billsTable.id, idParsed.data.id))
    .returning();

  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const vendorName = await getVendorName(bill.vendorId);
  const programName = await getProgramName(bill.programId);
  res.json(UpdateBillResponse.parse(formatBill(bill, vendorName, programName)));
});

router.post("/bills/:id/approve", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const idParsed = ApproveBillParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = ApproveBillBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const [bill] = await db
    .update(billsTable)
    .set({ status: "approved", approvedBy: bodyParsed.data.approvedBy })
    .where(eq(billsTable.id, idParsed.data.id))
    .returning();

  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const vendorName = await getVendorName(bill.vendorId);
  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill approved by ${bodyParsed.data.approvedBy}`,
    actor: bodyParsed.data.approvedBy,
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const programName = await getProgramName(bill.programId);
  res.json(ApproveBillResponse.parse(formatBill(bill, vendorName, programName)));
});

router.post("/bills/:id/reject", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const action = req.body?.action === "send_back" ? "send_back" : "close";
  if (reason.length < 3) {
    res.status(400).json({ error: "Rejection reason is required" });
    return;
  }
  const newStatus = action === "send_back" ? "needs_correction" : "rejected";
  const rejectedBy = req.authUser
    ? `${req.authUser.firstName} ${req.authUser.lastName}`
    : "Finance User";

  const [bill] = await db
    .update(billsTable)
    .set({ status: newStatus, rejectionReason: reason })
    .where(eq(billsTable.id, id))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "bill_created",
    description:
      action === "send_back"
        ? `Bill sent back for correction: ${reason}`
        : `Bill rejected: ${reason}`,
    actor: rejectedBy,
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const vendorName = await getVendorName(bill.vendorId);

  if (action === "send_back" && bill.submittedByEmail) {
    const submitter = await findUserByEmail(bill.submittedByEmail);
    if (submitter) {
      await createNotification({
        userId: submitter.id,
        type: "bill_needs_correction",
        title: `Bill #${bill.id} needs your attention`,
        body: `Your bill for ${vendorName} ($${Number(bill.amount).toFixed(2)}) was sent back by ${rejectedBy}. Reason: ${reason}`,
        link: `/bills/${bill.id}`,
        referenceType: "bill",
        referenceId: bill.id,
      });
    }
  }

  const programName = await getProgramName(bill.programId);
  res.json(formatBill(bill, vendorName, programName));
});

router.post("/bills/:id/resubmit", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(billsTable).where(eq(billsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (existing.status !== "needs_correction") {
    res.status(409).json({ error: "Only bills needing correction can be resubmitted" });
    return;
  }
  const isAdmin = req.authUser?.role === "admin";
  const callerEmail = req.authUser?.email?.toLowerCase() ?? null;
  const ownerEmail = existing.submittedByEmail?.toLowerCase() ?? null;
  // Prefer matching on the immutable email captured at submission time. For
  // legacy bills that pre-date the email column, fall back to the display
  // name match so they can still be resubmitted.
  const isOwnerByEmail =
    callerEmail !== null && ownerEmail !== null && callerEmail === ownerEmail;
  const submitterName = req.authUser
    ? `${req.authUser.firstName} ${req.authUser.lastName}`
    : null;
  const isOwnerByName =
    ownerEmail === null &&
    submitterName !== null &&
    existing.submittedBy === submitterName;
  if (!isAdmin && !isOwnerByEmail && !isOwnerByName) {
    res.status(403).json({ error: "Only the original submitter can resubmit this bill" });
    return;
  }
  const actorName =
    submitterName ?? existing.submittedBy ?? "Submitter";

  const [bill] = await db
    .update(billsTable)
    .set({ status: "submitted", rejectionReason: null })
    .where(eq(billsTable.id, id))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const vendorName = await getVendorName(bill.vendorId);
  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill resubmitted for ${vendorName}`,
    actor: actorName,
    amount: String(bill.amount),
    referenceId: bill.id,
    referenceType: "bill",
  });

  const programName = await getProgramName(bill.programId);
  res.json(GetBillResponse.parse(formatBill(bill, vendorName, programName)));
});

router.delete("/bills/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Unlink any bank transactions pointing at this bill so we don't leave
  // dangling matchedBillId references after delete. Reset status to
  // "unmatched" only for transactions that have no other link (no matched
  // expense), otherwise keep them as "matched" via the expense link.
  await db
    .update(transactionsTable)
    .set({ matchedBillId: null, status: "unmatched" })
    .where(
      and(
        eq(transactionsTable.matchedBillId, id),
        isNull(transactionsTable.matchedExpenseId),
      ),
    );
  await db
    .update(transactionsTable)
    .set({ matchedBillId: null })
    .where(eq(transactionsTable.matchedBillId, id));

  const [deleted] = await db.delete(billsTable).where(eq(billsTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.insert(activityLogTable).values({
    type: "bill_created",
    description: `Bill #${id} deleted`,
    actor: req.authUser
      ? `${req.authUser.firstName} ${req.authUser.lastName}`
      : "Finance User",
    amount: String(deleted.amount),
    referenceId: id,
    referenceType: "bill",
  });

  res.json({ ok: true });
});

export default router;
