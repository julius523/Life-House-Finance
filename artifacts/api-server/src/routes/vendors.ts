import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { vendorsTable, billsTable, expensesTable } from "@workspace/db";
import { eq, ilike, sql } from "drizzle-orm";
import {
  ListVendorsQueryParams,
  ListVendorsResponse,
  CreateVendorBody,
  GetVendorParams,
  GetVendorResponse,
  UpdateVendorParams,
  UpdateVendorBody,
  UpdateVendorResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getVendorTotalSpend(vendorId: number): Promise<number> {
  const [billSum] = await db
    .select({ total: sql<string>`coalesce(sum(${billsTable.amount}), 0)` })
    .from(billsTable)
    .where(eq(billsTable.vendorId, vendorId));
  return parseFloat(billSum?.total ?? "0");
}

function formatVendor(v: typeof vendorsTable.$inferSelect, totalSpend?: number) {
  return {
    id: v.id,
    name: v.name,
    contactName: v.contactName ?? undefined,
    email: v.email ?? undefined,
    phone: v.phone ?? undefined,
    address: v.address ?? undefined,
    category: v.category ?? undefined,
    taxId: v.taxId ?? undefined,
    paymentTerms: v.paymentTerms ?? undefined,
    isActive: v.isActive,
    totalSpend,
    createdAt: v.createdAt.toISOString(),
  };
}

router.get("/vendors", async (req, res): Promise<void> => {
  const parsed = ListVendorsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }
  const { search } = parsed.data;

  const vendors = search
    ? await db.select().from(vendorsTable).where(ilike(vendorsTable.name, `%${search}%`))
    : await db.select().from(vendorsTable);

  const items = await Promise.all(
    vendors.map(async (v) => {
      const totalSpend = await getVendorTotalSpend(v.id);
      return formatVendor(v, totalSpend);
    })
  );

  res.json(ListVendorsResponse.parse(items));
});

router.post("/vendors", async (req, res): Promise<void> => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [vendor] = await db.insert(vendorsTable).values(parsed.data).returning();
  if (!vendor) {
    res.status(500).json({ error: "Failed to create vendor" });
    return;
  }
  res.status(201).json(GetVendorResponse.parse(formatVendor(vendor, 0)));
});

router.get("/vendors/:id", async (req, res): Promise<void> => {
  const parsed = GetVendorParams.safeParse({ id: Number(req.params["id"]) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, parsed.data.id));
  if (!vendor) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const totalSpend = await getVendorTotalSpend(vendor.id);
  res.json(GetVendorResponse.parse(formatVendor(vendor, totalSpend)));
});

router.put("/vendors/:id", async (req, res): Promise<void> => {
  const idParsed = UpdateVendorParams.safeParse({ id: Number(req.params["id"]) });
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const bodyParsed = UpdateVendorBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [vendor] = await db
    .update(vendorsTable)
    .set(bodyParsed.data)
    .where(eq(vendorsTable.id, idParsed.data.id))
    .returning();
  if (!vendor) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const totalSpend = await getVendorTotalSpend(vendor.id);
  res.json(UpdateVendorResponse.parse(formatVendor(vendor, totalSpend)));
});

export default router;
