import { Router, type IRouter } from "express";
import { requireRole } from "../lib/auth";
import { isPrivilegedRead } from "../lib/recordAuthz";
import { z } from "zod";
import { db } from "@workspace/db";
import { vendorsTable, vendorContactsTable, billsTable, expensesTable } from "@workspace/db";
import { eq, ilike, sql, asc } from "drizzle-orm";
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

/**
 * Task #107 — submitters need vendor IDs/names to fill in the bill and
 * expense forms (the vendor picker), but they should NOT see vendor
 * PII (email, phone, address), tax ID, payment terms, or org-wide
 * spend. Return the picker-safe shape for submitters; admins/approvers
 * still get the full payload.
 */
function formatVendorRedacted(v: typeof vendorsTable.$inferSelect) {
  return {
    id: v.id,
    name: v.name,
    isActive: v.isActive,
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

  if (!isPrivilegedRead(req)) {
    // Submitter — picker-safe shape only. Skip the per-vendor totalSpend
    // round trips entirely so submitters cannot infer org-wide spend.
    res.json(ListVendorsResponse.parse(vendors.map(formatVendorRedacted)));
    return;
  }

  const items = await Promise.all(
    vendors.map(async (v) => {
      const totalSpend = await getVendorTotalSpend(v.id);
      return formatVendor(v, totalSpend);
    })
  );

  res.json(ListVendorsResponse.parse(items));
});

// Task #107 — vendor writes are restricted to admin/approver. Submitters
// keep read access (they need the picker when filing bills/expenses) but
// must not be able to create, edit, or attach contacts to vendors.
router.post("/vendors", requireRole("admin", "approver"), async (req, res): Promise<void> => {
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
  if (!isPrivilegedRead(req)) {
    // Picker-safe shape — no contact PII, tax ID, payment terms, or
    // org-wide spend leak to a submitter who happens to know an id.
    res.json(GetVendorResponse.parse(formatVendorRedacted(vendor)));
    return;
  }
  const totalSpend = await getVendorTotalSpend(vendor.id);
  res.json(GetVendorResponse.parse(formatVendor(vendor, totalSpend)));
});

router.put("/vendors/:id", requireRole("admin", "approver"), async (req, res): Promise<void> => {
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

// --- Delete vendor -----------------------------------------------------

router.delete("/vendors/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Block delete if vendor is referenced by bills or expenses
  const [billRef] = await db
    .select({ c: sql<number>`count(*)` })
    .from(billsTable)
    .where(eq(billsTable.vendorId, id));
  const [expRef] = await db
    .select({ c: sql<number>`count(*)` })
    .from(expensesTable)
    .where(eq(expensesTable.vendorId, id));
  if (Number(billRef?.c ?? 0) > 0 || Number(expRef?.c ?? 0) > 0) {
    res.status(409).json({
      error:
        "This vendor is used by existing bills or expenses. Remove or reassign those records first.",
    });
    return;
  }
  const [deleted] = await db.delete(vendorsTable).where(eq(vendorsTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Vendor contacts ---------------------------------------------------

const ContactBody = z.object({
  name: z.string().min(1),
  role: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  phone: z.string().optional().nullable(),
  isPrimary: z.boolean().optional(),
});

function formatContact(c: typeof vendorContactsTable.$inferSelect) {
  return {
    id: c.id,
    vendorId: c.vendorId,
    name: c.name,
    role: c.role ?? undefined,
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    isPrimary: c.isPrimary,
    createdAt: c.createdAt.toISOString(),
  };
}

// Task #107 — vendor contacts include email/phone PII. Reads, like
// writes, are restricted to admin/approver. Submitters do not need to
// see contact details to file bills/expenses.
router.get("/vendors/:id/contacts", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(vendorContactsTable)
    .where(eq(vendorContactsTable.vendorId, id))
    .orderBy(asc(vendorContactsTable.id));
  res.json({ contacts: rows.map(formatContact) });
});

router.post("/vendors/:id/contacts", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = ContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const [created] = await db
    .insert(vendorContactsTable)
    .values({
      vendorId: id,
      name: parsed.data.name,
      role: parsed.data.role || null,
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
      isPrimary: parsed.data.isPrimary ?? false,
    })
    .returning();
  if (!created) {
    res.status(500).json({ error: "Failed to create contact" });
    return;
  }
  res.status(201).json({ contact: formatContact(created) });
});

router.put("/vendor-contacts/:contactId", requireRole("admin", "approver"), async (req, res): Promise<void> => {
  const cid = Number(req.params["contactId"]);
  if (!Number.isInteger(cid)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = ContactBody.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates["name"] = parsed.data.name;
  if (parsed.data.role !== undefined) updates["role"] = parsed.data.role || null;
  if (parsed.data.email !== undefined) updates["email"] = parsed.data.email || null;
  if (parsed.data.phone !== undefined) updates["phone"] = parsed.data.phone || null;
  if (parsed.data.isPrimary !== undefined) updates["isPrimary"] = parsed.data.isPrimary;
  const [updated] = await db
    .update(vendorContactsTable)
    .set(updates)
    .where(eq(vendorContactsTable.id, cid))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ contact: formatContact(updated) });
});

router.delete("/vendor-contacts/:contactId", requireRole("admin"), async (req, res): Promise<void> => {
  const cid = Number(req.params["contactId"]);
  if (!Number.isInteger(cid)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [deleted] = await db
    .delete(vendorContactsTable)
    .where(eq(vendorContactsTable.id, cid))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
