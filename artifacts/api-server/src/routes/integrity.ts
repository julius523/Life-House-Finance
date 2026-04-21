/**
 * Task #103 — admin-only Integrity Sweep endpoint.
 *
 * GET /api/admin/integrity/sweep
 *   Runs the read-only sweep service on demand and returns the locked
 *   {@link IntegritySweepReport} shape. No side effects of any kind.
 *
 * Auth: reuses the same admin gate as the rest of /admin/*.
 */
import { Router, type IRouter } from "express";
import { requireAuth, requireRole } from "../lib/auth";
import { runIntegritySweep } from "../lib/integritySweepService";
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
      error:
        err instanceof Error
          ? err.message
          : "Integrity sweep failed",
    });
  }
});

export default router;
