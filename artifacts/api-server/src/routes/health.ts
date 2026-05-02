import { Router, type IRouter } from "express";
import { sql, getTableName, getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as dbExports from "@workspace/db";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { getSchedulerHealth } from "../lib/journalEntryExportScheduler";
import { getMissingRequiredEnvVars } from "../lib/envCheck";

const router: IRouter = Router();

/**
 * Build the expected schema fingerprint by walking every Drizzle
 * `pgTable` exported from `@workspace/db`. This means new tables and
 * columns are picked up automatically — we don't have to maintain a
 * hand-curated list (which was the weakness the code review flagged).
 */
type ExpectedTable = { table: string; columns: string[] };

function buildExpectedSchema(): ExpectedTable[] {
  const out: ExpectedTable[] = [];
  for (const v of Object.values(dbExports)) {
    if (!is(v as object, PgTable)) continue;
    const t = v as PgTable;
    const cols = getTableColumns(t);
    out.push({
      table: getTableName(t),
      columns: Object.values(cols).map((c) => c.name),
    });
  }
  return out;
}

const EXPECTED_SCHEMA: ExpectedTable[] = buildExpectedSchema();

/**
 * Scheduler is healthy if it is running AND has either ticked in the
 * last 5 minutes OR is still inside the post-boot grace window. The
 * 5-minute window is 5x the 60-second tick interval so a single
 * missed tick does not flap health.
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

/**
 * Schema-parity probe: every table the application's Drizzle schema
 * declares must exist in the live DB, with every expected column
 * present (by name). Catches a forgotten `drizzle-kit push` after a
 * schema change, an empty DB after an accidental restore, and most
 * cases where production has drifted away from the schema the code
 * was built against.
 *
 * NOT a full migration verifier: types, defaults, and constraints are
 * not compared (those are best handled by `drizzle-kit check`, which
 * the post-merge hook runs at deploy time). The intent here is the
 * "fail-fast on catastrophic drift" tier.
 */
async function probeSchema(): Promise<ProbeResult> {
  try {
    const result = await db.execute<{
      table_name: string;
      column_name: string;
    }>(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const present = new Map<string, Set<string>>();
    for (const row of result.rows) {
      let cols = present.get(row.table_name);
      if (!cols) {
        cols = new Set();
        present.set(row.table_name, cols);
      }
      cols.add(row.column_name);
    }
    const missing: string[] = [];
    for (const expected of EXPECTED_SCHEMA) {
      const live = present.get(expected.table);
      if (!live) {
        missing.push(`table:${expected.table}`);
        continue;
      }
      for (const col of expected.columns) {
        if (!live.has(col)) missing.push(`${expected.table}.${col}`);
      }
    }
    if (missing.length > 0) {
      // Cap the detail string so a totally-empty DB doesn't produce a
      // multi-KB response body.
      const head = missing.slice(0, 10).join(", ");
      const more = missing.length > 10 ? ` (+${missing.length - 10} more)` : "";
      return {
        ok: false,
        detail: `schema drift — missing: ${head}${more}`,
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
  // No tick has completed yet. Healthy ONLY during the brief grace
  // window after boot — beyond that, a null lastTickAt means the very
  // first tick is wedged or never fired and we must report degraded.
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
