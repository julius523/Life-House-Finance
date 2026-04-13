import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { billsTable, vendorsTable, programsTable, activityLogTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
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
    status: b.status as "draft" | "submitted" | "approved" | "paid" | "overdue",
    approvedBy: b.approvedBy ?? undefined,
    paidDate: b.paidDate ?? undefined,
    receiptIds: b.receiptIds ?? undefined,
    createdAt: b.createdAt.toISOString(),
  };
}

router.get("/bills", async (req, res): Promise<void> => {
  const parsed = ListBillsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { status, vendorId, programId } = parsed.data;

  const conditions = [];
  if (status) conditions.push(eq(billsTable.status, status));
  if (vendorId) conditions.push(eq(billsTable.vendorId, vendorId));
  if (programId) conditions.push(eq(billsTable.programId, programId));

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

router.post("/bills/:id/approve", async (req, res): Promise<void> => {
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

export default router;
