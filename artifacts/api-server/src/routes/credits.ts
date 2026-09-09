import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, creditsTable, programsTable, CREDIT_STATUSES } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import {
  AUTOMATION_DISPLAY_NAME,
  isServiceCreatedRecord,
  readApiSource,
} from "../lib/apiKey";

const router: IRouter = Router();

// Service role can read /credits & /credit-summary and POST /credits
// (handled by the per-route gate below). DELETE and PUT remain
// admin-only and are explicitly gated below — service callers fall
// through the requireRole gate and receive 403.
router.use("/credits", requireAuth, requireRole("admin", "approver", "service"));
router.use("/credit-summary", requireAuth, requireRole("admin", "approver", "service"));
// PUT is intentionally NOT role-gated at the router level (unlike DELETE
// below) — a service caller is allowed to update a credit, but only one
// it created itself (isServiceCreatedRecord, checked inside the handler
// against the target row). admin/approver may update any credit, same as
// before. See the handler for the actual ownership check.
router.delete("/credits/:id", requireRole("admin"));

const StatusEnum = z.enum(CREDIT_STATUSES);

const CreateCreditBody = z.object({
  source: z.string().min(1),
  programId: z.number().int().nullable().optional(),
  amount: z.coerce.number(),
  expectedDate: z.string().optional().nullable(),
  receivedDate: z.string().optional().nullable(),
  status: StatusEnum.default("pipeline"),
  notes: z.string().optional().nullable(),
  submittedBy: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
});

function formatCredit(
  c: typeof creditsTable.$inferSelect,
  programName?: string | null,
) {
  // entrySource lets the UI filter automation-created rows from manual
  // ones. Derived from the submittedBy marker that POST /credits sets
  // for service-account callers (see the "Automation: <source>" prefix
  // there); legacy/manual rows return "manual".
  const entrySource: "automation" | "manual" = isServiceCreatedRecord({
    submittedBy: c.submittedBy,
  })
    ? "automation"
    : "manual";
  return {
    id: c.id,
    source: c.source,
    programId: c.programId ?? null,
    programName: programName ?? null,
    amount: parseFloat(c.amount),
    expectedDate: c.expectedDate ?? null,
    receivedDate: c.receivedDate ?? null,
    status: c.status,
    notes: c.notes ?? null,
    submittedBy: c.submittedBy ?? null,
    externalRef: c.externalRef ?? null,
    entrySource,
    createdAt: c.createdAt.toISOString(),
  };
}

async function programNameMap(): Promise<Map<number, string>> {
  const rows = await db.select({ id: programsTable.id, name: programsTable.name }).from(programsTable);
  return new Map(rows.map((r) => [r.id, r.name]));
}

router.get("/credits", async (req, res): Promise<void> => {
  const statusParam = req.query["status"];
  const where = typeof statusParam === "string" && (CREDIT_STATUSES as readonly string[]).includes(statusParam)
    ? eq(creditsTable.status, statusParam)
    : undefined;
  const rows = where
    ? await db.select().from(creditsTable).where(where).orderBy(desc(creditsTable.createdAt))
    : await db.select().from(creditsTable).orderBy(desc(creditsTable.createdAt));
  const names = await programNameMap();
  res.json({
    credits: rows.map((c) => formatCredit(c, c.programId ? names.get(c.programId) ?? null : null)),
  });
});

router.post("/credits", async (req, res): Promise<void> => {
  const parsed = CreateCreditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;
  // When the request is authenticated as the service account, force the
  // submittedBy column to a recognisable marker derived from the
  // X-API-Source header (default "Automation"). Manual UI submitters
  // are unaffected.
  const callerRole = req.authUser?.role;
  const submittedBy =
    callerRole === "service"
      ? `${AUTOMATION_DISPLAY_NAME}: ${readApiSource(req)}`
      : (d.submittedBy || null);

  // Upsert-by-externalRef: an automation caller re-syncing the same
  // logical record (e.g. a claim whose status just changed) updates the
  // credit it already created instead of piling up a duplicate on every
  // sync. Only meaningful for service-role callers with a ref — manual UI
  // submissions never send one.
  if (d.externalRef) {
    const [existing] = await db.select().from(creditsTable).where(eq(creditsTable.externalRef, d.externalRef));
    if (existing) {
      if (!isServiceCreatedRecord(existing)) {
        res.status(409).json({ error: "externalRef already used by a manually-entered credit" });
        return;
      }
      const [updated] = await db
        .update(creditsTable)
        .set({
          source: d.source,
          programId: d.programId ?? null,
          amount: String(d.amount),
          expectedDate: d.expectedDate || null,
          receivedDate: d.receivedDate || null,
          status: d.status,
          notes: d.notes || null,
        })
        .where(eq(creditsTable.id, existing.id))
        .returning();
      const names = await programNameMap();
      res.json({
        credit: formatCredit(updated!, updated!.programId ? names.get(updated!.programId) ?? null : null),
      });
      return;
    }
  }

  const [created] = await db
    .insert(creditsTable)
    .values({
      source: d.source,
      programId: d.programId ?? null,
      amount: String(d.amount),
      expectedDate: d.expectedDate || null,
      receivedDate: d.receivedDate || null,
      status: d.status,
      notes: d.notes || null,
      submittedBy,
      externalRef: d.externalRef || null,
    })
    .returning();
  if (!created) {
    res.status(500).json({ error: "Failed to create credit" });
    return;
  }
  const names = await programNameMap();
  res.status(201).json({
    credit: formatCredit(created, created.programId ? names.get(created.programId) ?? null : null),
  });
});

router.put("/credits/:id", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = CreateCreditBody.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const d = parsed.data;

  // A service caller may only update a credit it created itself — never
  // one entered manually by staff. admin/approver may update any credit,
  // unchanged from before this check existed.
  if (req.authUser?.role === "service") {
    const [existing] = await db.select().from(creditsTable).where(eq(creditsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!isServiceCreatedRecord(existing)) {
      res.status(403).json({ error: "Service role may only update credits it created" });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (d.source !== undefined) updates["source"] = d.source;
  if (d.programId !== undefined) updates["programId"] = d.programId;
  if (d.amount !== undefined) updates["amount"] = String(d.amount);
  if (d.expectedDate !== undefined) updates["expectedDate"] = d.expectedDate || null;
  if (d.receivedDate !== undefined) updates["receivedDate"] = d.receivedDate || null;
  if (d.status !== undefined) updates["status"] = d.status;
  if (d.notes !== undefined) updates["notes"] = d.notes || null;
  if (d.submittedBy !== undefined) updates["submittedBy"] = d.submittedBy || null;
  const [updated] = await db.update(creditsTable).set(updates).where(eq(creditsTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const names = await programNameMap();
  res.json({
    credit: formatCredit(updated, updated.programId ? names.get(updated.programId) ?? null : null),
  });
});

router.delete("/credits/:id", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [deleted] = await db.delete(creditsTable).where(eq(creditsTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/credit-summary", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      status: creditsTable.status,
      total: sql<string>`coalesce(sum(${creditsTable.amount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(creditsTable)
    .groupBy(creditsTable.status);

  const byStatus: Record<string, { amount: number; count: number }> = {};
  for (const s of CREDIT_STATUSES) byStatus[s] = { amount: 0, count: 0 };
  for (const r of rows) {
    if (r.status in byStatus) {
      byStatus[r.status] = { amount: parseFloat(r.total), count: Number(r.count) };
    }
  }
  const realized = byStatus["received"]!.amount;
  // Potential excludes write-off (lost) and excludes already received
  const potential =
    byStatus["pipeline"]!.amount +
    byStatus["delayed"]!.amount +
    byStatus["opportunity"]!.amount;
  res.json({
    realized,
    potential,
    writeOff: byStatus["write-off"]!.amount,
    byStatus: CREDIT_STATUSES.map((s) => ({
      status: s,
      amount: byStatus[s]!.amount,
      count: byStatus[s]!.count,
    })),
  });
});

export default router;
