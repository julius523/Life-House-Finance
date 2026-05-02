/**
 * Task #103 — admin-only Integrity Sweep endpoint.
 * Task #131 — adds the guided repair endpoint and recent-repairs feed.
 *
 * GET /api/admin/integrity/sweep
 *   Runs the read-only sweep service on demand and returns the locked
 *   {@link IntegritySweepReport} shape. No side effects of any kind.
 *
 * GET /api/admin/integrity/repair-registry
 *   Returns the safe-set of repairable checks the UI should expose
 *   "Repair…" affordances for. Read-only — discovery surface for the
 *   client. Excludes the `fn` callback itself.
 *
 * POST /api/admin/integrity/sweep/repair
 *   Dispatches a repair from the typed registry. Body:
 *     { checkKey: string, ids: number[] }
 *   Validates the checkKey is in the safe-set (else 400) and returns
 *   { repaired: number[], skipped: { id, reason }[] }.
 *
 * GET /api/admin/integrity/repairs
 *   Recent integrity_repair activity log entries — backs the audit-log
 *   review path on the Findings page (one extra "filter chip" surface
 *   without grafting a chip onto an unrelated viewer).
 *
 * Auth: reuses the same admin gate as the rest of /admin/*.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, activityLogTable, usersTable } from "@workspace/db";
import { requireAuth, requireRole, type AuthUser } from "../lib/auth";
import { runIntegritySweep } from "../lib/integritySweepService";
import {
  describeRegistry,
  getRepairDescriptor,
  INTEGRITY_REPAIR_ACTIVITY_TYPE,
} from "../lib/integrityRepairService";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use("/admin/integrity", requireAuth, requireRole("admin"));

router.get("/admin/integrity/sweep", async (_req, res): Promise<void> => {
  try {
    const report = await runIntegritySweep();
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Integrity sweep failed");
    res.status(500).json({
      error: "Integrity sweep failed (see server logs for details)",
    });
  }
});

router.get(
  "/admin/integrity/repair-registry",
  async (_req, res): Promise<void> => {
    res.json({ items: describeRegistry() });
  },
);

const RepairBody = z.object({
  checkKey: z.string().min(1),
  ids: z.array(z.number().int().positive()).min(1).max(500),
});

router.post(
  "/admin/integrity/sweep/repair",
  async (req, res): Promise<void> => {
    const parsed = RepairBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid body",
      });
      return;
    }
    const descriptor = getRepairDescriptor(parsed.data.checkKey);
    if (!descriptor) {
      res.status(400).json({
        error: `Check '${parsed.data.checkKey}' is not in the safe-set repair registry`,
      });
      return;
    }
    const me = (req as typeof req & { authUser?: AuthUser }).authUser;
    if (!me) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const outcome = await descriptor.fn(parsed.data.ids, {
        id: me.id,
        display:
          `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim() ||
          me.email ||
          `user#${me.id}`,
      });
      res.json({
        checkKey: descriptor.checkKey,
        repaired: outcome.repaired,
        skipped: outcome.skipped,
      });
    } catch (err) {
      logger.error(
        { err, checkKey: parsed.data.checkKey },
        "Integrity repair failed",
      );
      res.status(500).json({
        error: "Integrity repair failed (see server logs for details)",
      });
    }
  },
);

router.get("/admin/integrity/repairs", async (req, res): Promise<void> => {
  const limitRaw = Number(req.query["limit"] ?? 25);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
    : 25;
  const rows = await db
    .select({
      id: activityLogTable.id,
      type: activityLogTable.type,
      description: activityLogTable.description,
      actor: activityLogTable.actor,
      actorUserId: activityLogTable.actorUserId,
      referenceType: activityLogTable.referenceType,
      referenceId: activityLogTable.referenceId,
      metadata: activityLogTable.metadata,
      createdAt: activityLogTable.createdAt,
      actorEmail: usersTable.email,
    })
    .from(activityLogTable)
    .leftJoin(usersTable, eq(activityLogTable.actorUserId, usersTable.id))
    .where(eq(activityLogTable.type, INTEGRITY_REPAIR_ACTIVITY_TYPE))
    .orderBy(desc(activityLogTable.createdAt))
    .limit(limit);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      actor: r.actor,
      actorUserId: r.actorUserId ?? null,
      actorEmail: r.actorEmail ?? null,
      referenceType: r.referenceType ?? null,
      referenceId: r.referenceId ?? null,
      metadata: r.metadata ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
