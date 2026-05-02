/**
 * Schema parity gate.
 *
 * Compares the application's Drizzle schema (the source of truth in
 * code) against what's actually in the connected database. Exits 0 if
 * every table and column declared by Drizzle exists in the DB; exits
 * 1 with a list of drifted items otherwise.
 *
 * This is the "did drizzle-kit push actually run" check. The repo
 * does not ship per-migration files (schema changes are applied via
 * `drizzle-kit push` and Replit's publish-time diff), so this script
 * substitutes for the per-migration rollback annotation gate that a
 * migrations-based repo would have. Wired into `scripts/post-merge.sh`
 * AFTER the push step, so a publish that fails to apply the schema
 * change is loudly rejected instead of silently going live.
 *
 * Limitations: column types, defaults, nullability, and constraints
 * are not compared. Use `drizzle-kit check` (in @workspace/db) for the
 * stricter analysis when needed. This check is the catastrophic-drift
 * tier — the kind a human notices the morning after, not the kind
 * that requires diff-walking.
 */
import { db, pool } from "@workspace/db";
import * as dbExports from "@workspace/db";
import { sql, is, getTableName, getTableColumns } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

type Expected = { table: string; columns: string[] };

function buildExpected(): Expected[] {
  const out: Expected[] = [];
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

async function main(): Promise<number> {
  const expected = buildExpected();
  console.log(
    `schema-parity: checking ${expected.length} tables from Drizzle schema...`,
  );
  const rows = await db.execute<{ table_name: string; column_name: string }>(
    sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `,
  );
  const present = new Map<string, Set<string>>();
  for (const r of rows.rows) {
    let cols = present.get(r.table_name);
    if (!cols) {
      cols = new Set();
      present.set(r.table_name, cols);
    }
    cols.add(r.column_name);
  }
  const missing: string[] = [];
  for (const e of expected) {
    const live = present.get(e.table);
    if (!live) {
      missing.push(`table missing: ${e.table}`);
      continue;
    }
    for (const c of e.columns) {
      if (!live.has(c)) missing.push(`column missing: ${e.table}.${c}`);
    }
  }
  if (missing.length > 0) {
    console.error(
      `\nschema-parity: FAIL — ${missing.length} drift item(s):`,
    );
    for (const m of missing) console.error(`  - ${m}`);
    console.error(
      "\nLikely cause: `pnpm --filter db push` did not run, or failed silently.",
    );
    return 1;
  }
  console.log("schema-parity: OK");
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(2);
  });
