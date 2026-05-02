import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { getSchedulerHealth } from "../lib/journalEntryExportScheduler";
import { getMissingRequiredEnvVars } from "../lib/envCheck";

const router: IRouter = Router();

/**
 * Tables that MUST exist for the application to function. Used as a
 * cheap schema-parity smoke test — if any of these are missing the
 * deployment is fundamentally broken (e.g. drizzle-kit push didn't run,
 * or someone restored an empty DB) and we should fail health.
 *
 * Not exhaustive: this is a smoke test, not a full schema diff.
 */
const REQUIRED_TABLES = [
  "users",
  "expenses",
  "bills",
  "receipts",
  "vendors",
  "programs",
  "journal_entries",
  "chart_of_accounts",
  "activity_log",
];

/**
 * Scheduler is considered live if it is running AND has either ticked
 * in the last 5 minutes OR has not been started long enough to have
 * ticked yet. The 5-minute window is 5x the 60-second tick interval
 * so a single missed tick does not flap health.
 */
const SCHEDULER_STALE_MS = 5 * 60 * 1000;

type ProbeResult = {
  ok: boolean;
  detail?: string;
};

async function probeDatabase(): Promise<ProbeResult> {
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "DB ping failed",
    };
  }
}

async function probeSchema(): Promise<ProbeResult> {
  try {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `);
    const present = new Set(result.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `missing required tables: ${missing.join(", ")}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "schema probe failed",
    };
  }
}

function probeScheduler(): ProbeResult {
  const h = getSchedulerHealth();
  if (!h.running) return { ok: false, detail: "scheduler timer not running" };
  if (h.lastTickAt) {
    const age = Date.now() - h.lastTickAt.getTime();
    if (age > SCHEDULER_STALE_MS) {
      return { ok: false, detail: `scheduler last ticked ${age}ms ago` };
    }
    return { ok: true };
  }
  // No tick has completed yet. That is healthy ONLY during a brief
  // grace window after boot — beyond that, a null lastTickAt means the
  // very first tick is wedged (or never fired) and we must report
  // degraded so this is not silently green forever.
  if (h.startedAt) {
    const age = Date.now() - h.startedAt.getTime();
    if (age > SCHEDULER_STALE_MS) {
      return {
        ok: false,
        detail: `scheduler started ${age}ms ago but has never completed a tick`,
      };
    }
    return { ok: true };
  }
  return { ok: false, detail: "scheduler started but startedAt is null" };
}

router.get("/healthz", async (_req, res): Promise<void> => {
  const [dbProbe, schemaProbe] = await Promise.all([
    probeDatabase(),
    probeSchema(),
  ]);
  const schedulerProbe = probeScheduler();
  const missingEnv = getMissingRequiredEnvVars();
  const envProbe: ProbeResult =
    missingEnv.length === 0
      ? { ok: true }
      : { ok: false, detail: `missing env vars: ${missingEnv.join(", ")}` };

  const allOk =
    dbProbe.ok && schemaProbe.ok && schedulerProbe.ok && envProbe.ok;

  const body = {
    status: allOk ? "ok" : "degraded",
    db: dbProbe,
    schema: schemaProbe,
    scheduler: schedulerProbe,
    env: envProbe,
  };

  if (!allOk) {
    logger.warn({ body }, "/healthz returning 503");
    res.status(503).json(body);
    return;
  }
  res.json(body);
});

export default router;
