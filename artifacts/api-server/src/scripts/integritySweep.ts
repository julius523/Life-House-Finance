/**
 * Task #103 — CLI entry point for the Integrity Sweep service.
 *
 * Runs the same read-only sweep used by GET /api/admin/integrity/sweep,
 * prints a human-readable summary on stderr, and emits the locked
 * {@link IntegritySweepReport} JSON to stdout so the output can be
 * piped/redirected.
 *
 * Exit codes:
 *   0 — sweep ran successfully (regardless of whether findings exist)
 *   1 — runtime / DB / config failure
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run integrity:sweep
 *   pnpm --filter @workspace/api-server run integrity:sweep > report.json
 */
import { pool } from "@workspace/db";
import { runIntegritySweep } from "../lib/integritySweepService";

function printSummary(report: Awaited<ReturnType<typeof runIntegritySweep>>): void {
  const lines: string[] = [];
  lines.push(`Integrity Sweep — generated ${report.generatedAt}`);
  lines.push(
    `${report.failingChecks}/${report.totalChecks} checks with findings (${report.ok ? "ALL OK" : "FINDINGS"}).`,
  );
  for (const c of report.checks) {
    const status = c.count === 0 ? "OK" : "FINDING";
    const samples =
      c.sampleRefs.length > 0
        ? ` — sample ${c.sampleRefs[0]!.kind} ids: ${c.sampleRefs
            .slice(0, 5)
            .map((r: { id: string }) => r.id)
            .join(", ")}${c.sampleRefs.length > 5 ? ", …" : ""}`
        : "";
    lines.push(
      `  [${status.padEnd(7)}] ${c.key.padEnd(38)} count=${String(
        c.count,
      ).padStart(4)} (${c.severity}/${c.category})${samples}`,
    );
  }
  process.stderr.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  let report: Awaited<ReturnType<typeof runIntegritySweep>>;
  try {
    report = await runIntegritySweep();
  } catch (err) {
    process.stderr.write(
      `Integrity sweep failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
  printSummary(report);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  await pool.end().catch(() => undefined);
  // Exit 0 even when findings exist — the CLI reports successfully.
  process.exit(0);
}

void main();
