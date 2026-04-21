/**
 * Task #103 — Integrity Sweep service + admin endpoint integration tests.
 *
 * Strategy:
 *   1. Insert a controlled set of violations across three categories
 *      (structural, status_mismatch, missing_bridge) plus seed rows that
 *      should NOT trip any check.
 *   2. Run runIntegritySweep() directly and assert each seeded violation
 *      surfaces with the expected category, severity, sample kind, and
 *      that the seeded IDs appear in the sampleRefs list.
 *   3. Mount the integrity router behind a stub auth middleware (mirrors
 *      the pattern in remediationPostedDialog.test.ts) and assert:
 *        - non-admin users get 403,
 *        - the route returns the same locked shape produced by the
 *          service for the same DB state (CLI / API parity).
 *   4. Cleanup leaves the DB exactly as we found it.
 *
 * The service contract guarantees `count` reflects the FULL affected
 * count even when other test residue lives in the DB, so the assertions
 * use "seeded ID ∈ sampleRefs" rather than exact counts wherever ambient
 * data could exist.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

import {
  db,
  pool,
  usersTable,
  expensesTable,
  vendorsTable,
  billsTable,
  accountingSourceLinksTable,
  INTEGRITY_CATEGORIES,
  INTEGRITY_SEVERITIES,
  INTEGRITY_SAMPLE_KINDS,
  INTEGRITY_SAMPLE_CAP,
  type IntegritySweepReport,
} from "@workspace/db";
import {
  runIntegritySweep,
  INTEGRITY_CHECK_KEYS,
} from "../integritySweepService";
import integrityRouter from "../../routes/integrity";
import { encodeSession } from "../auth";

const TAG = `t103-${process.pid}-${Date.now()}`;

let app: Express;
let server: Server;
let baseUrl: string;

let adminUserId: number;
let viewerUserId: number;

let cleanExpenseId: number;        // baseline, no violations
let blockedNoReasonExpenseId: number; // status_mismatch
let postedWithBlockExpenseId: number; // status_mismatch
let postedNoLinkExpenseId: number;    // missing_bridge
let draftNoLinkExpenseId: number;     // missing_bridge

let cleanBillId: number;              // baseline
let postedNoLinkBillAccrualId: number; // missing_bridge

let vendorId: number;

const seededAslIds: number[] = [];   // structural
let aslNoTargetsId: number;
let aslUnknownTypeId: number;
let aslExpenseMissingSourceId: number;
let aslExpenseBadEventId: number;

before(async () => {
  // --- Users ---------------------------------------------------------------
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "Sweep",
      lastName: "Admin",
      role: "admin",
    })
    .returning();
  adminUserId = admin!.id;
  const [viewer] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-viewer@test.local`,
      passwordHash: "x",
      firstName: "Sweep",
      lastName: "Viewer",
      role: "submitter",
    })
    .returning();
  viewerUserId = viewer!.id;

  // --- Vendor + bills ------------------------------------------------------
  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: `${TAG}-vendor` })
    .returning();
  vendorId = vendor!.id;

  const [cleanBill] = await db
    .insert(billsTable)
    .values({
      vendorId,
      dueDate: "2030-01-01",
      amount: "100.00",
      status: "draft",
      // accountingStatus left at default 'pending' — no violation expected.
    })
    .returning();
  cleanBillId = cleanBill!.id;

  // bill_accrual_posted_no_link — accountingStatus='posted' but no ASL link.
  const [postedNoLinkBill] = await db
    .insert(billsTable)
    .values({
      vendorId,
      dueDate: "2030-01-02",
      amount: "200.00",
      status: "approved",
      accountingStatus: "posted",
    })
    .returning();
  postedNoLinkBillAccrualId = postedNoLinkBill!.id;

  // --- Expenses ------------------------------------------------------------
  const [cleanExpense] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-clean`,
      expenseDate: "2030-01-01",
      merchant: "Clean",
      description: "clean",
      amount: "10.00",
      paymentMethod: "cash",
      status: "draft",
      // accountingStatus default 'pending'
    })
    .returning();
  cleanExpenseId = cleanExpense!.id;

  // expense_blocked_no_reason: status='blocked' AND block_reason IS NULL.
  const [blockedNoReason] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-blocked-no-reason`,
      expenseDate: "2030-01-02",
      merchant: "BlockedNoReason",
      description: "x",
      amount: "1.00",
      paymentMethod: "cash",
      status: "draft",
      accountingStatus: "blocked",
      // accountingBlockReason intentionally null
    })
    .returning();
  blockedNoReasonExpenseId = blockedNoReason!.id;

  // expense_posted_with_block: posted but still carries a block_reason.
  const [postedWithBlock] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-posted-with-block`,
      expenseDate: "2030-01-03",
      merchant: "PostedWithBlock",
      description: "x",
      amount: "2.00",
      paymentMethod: "cash",
      status: "approved",
      accountingStatus: "posted",
      accountingBlockReason: "stale_block_text",
    })
    .returning();
  postedWithBlockExpenseId = postedWithBlock!.id;

  // expense_posted_no_link: status='posted' but no ASL→JE row.
  const [postedNoLink] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-posted-no-link`,
      expenseDate: "2030-01-04",
      merchant: "PostedNoLink",
      description: "x",
      amount: "3.00",
      paymentMethod: "cash",
      status: "approved",
      accountingStatus: "posted",
    })
    .returning();
  postedNoLinkExpenseId = postedNoLink!.id;

  // expense_draft_no_link: status='draft_created' but no ASL→draft row.
  const [draftNoLink] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-draft-no-link`,
      expenseDate: "2030-01-05",
      merchant: "DraftNoLink",
      description: "x",
      amount: "4.00",
      paymentMethod: "cash",
      status: "draft",
      accountingStatus: "draft_created",
    })
    .returning();
  draftNoLinkExpenseId = draftNoLink!.id;

  // --- Source-link structural violations -----------------------------------
  // asl_no_targets: both targets null.
  const [aslNoTargets] = await db
    .insert(accountingSourceLinksTable)
    .values({
      sourceType: "expense",
      sourceId: cleanExpenseId,
      eventType: "primary",
      idempotencyKey: `${TAG}-asl-no-targets`,
      manualJournalEntryDraftId: null,
      journalEntryId: null,
      createdByUserId: adminUserId,
    })
    .returning();
  aslNoTargetsId = aslNoTargets!.id;
  seededAslIds.push(aslNoTargetsId);

  // asl_unknown_source_type: source_type not in (expense, bill).
  const [aslUnknownType] = await db
    .insert(accountingSourceLinksTable)
    .values({
      sourceType: "ghost",
      sourceId: 999_999_990,
      eventType: "primary",
      idempotencyKey: `${TAG}-asl-unknown`,
      manualJournalEntryDraftId: null,
      journalEntryId: null,
      createdByUserId: adminUserId,
    })
    .returning();
  aslUnknownTypeId = aslUnknownType!.id;
  seededAslIds.push(aslUnknownTypeId);

  // asl_expense_missing_source: source_type=expense but source_id doesn't exist.
  const [aslExpenseMissing] = await db
    .insert(accountingSourceLinksTable)
    .values({
      sourceType: "expense",
      sourceId: 999_999_991,
      eventType: "primary",
      idempotencyKey: `${TAG}-asl-exp-missing`,
      manualJournalEntryDraftId: null,
      journalEntryId: null,
      createdByUserId: adminUserId,
    })
    .returning();
  aslExpenseMissingSourceId = aslExpenseMissing!.id;
  seededAslIds.push(aslExpenseMissingSourceId);

  // asl_expense_bad_event: source_type=expense but event_type<>'primary'.
  const [aslExpenseBad] = await db
    .insert(accountingSourceLinksTable)
    .values({
      sourceType: "expense",
      sourceId: cleanExpenseId,
      eventType: "accrual",
      idempotencyKey: `${TAG}-asl-exp-bad-event`,
      manualJournalEntryDraftId: null,
      journalEntryId: null,
      createdByUserId: adminUserId,
    })
    .returning();
  aslExpenseBadEventId = aslExpenseBad!.id;
  seededAslIds.push(aslExpenseBadEventId);

  // --- Express test app ----------------------------------------------------
  // The integrity router has requireAuth + requireRole baked in, so we
  // must drive it with real lh_session cookies (encoded via the same
  // helper production uses) — same pattern as the remediation queue
  // route tests.
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", integrityRouter);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}/api`;
      }
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  // Clean up in reverse insertion order. ASLs first because they
  // reference the expenses by source_id (no FK, but logically owned).
  if (seededAslIds.length) {
    await db
      .delete(accountingSourceLinksTable)
      .where(inArray(accountingSourceLinksTable.id, seededAslIds));
  }
  const expenseIds = [
    cleanExpenseId,
    blockedNoReasonExpenseId,
    postedWithBlockExpenseId,
    postedNoLinkExpenseId,
    draftNoLinkExpenseId,
  ].filter(Boolean);
  if (expenseIds.length) {
    await db.delete(expensesTable).where(inArray(expensesTable.id, expenseIds));
  }
  const billIds = [cleanBillId, postedNoLinkBillAccrualId].filter(Boolean);
  if (billIds.length) {
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  if (vendorId) {
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  }
  if (adminUserId)
    await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  if (viewerUserId)
    await db.delete(usersTable).where(eq(usersTable.id, viewerUserId));
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCheck(
  report: IntegritySweepReport,
  key: string,
): IntegritySweepReport["checks"][number] {
  const c = report.checks.find((x) => x.key === key);
  assert.ok(c, `expected check '${key}' in report`);
  return c!;
}

function sampleIds(
  report: IntegritySweepReport,
  key: string,
): string[] {
  return findCheck(report, key).sampleRefs.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("report shape: locked enums + 32 checks present, no extras", async () => {
  const report = await runIntegritySweep();
  assert.equal(report.totalChecks, 32);
  assert.equal(report.checks.length, 32);
  assert.equal(report.checks.length, INTEGRITY_CHECK_KEYS.length);

  // All keys unique.
  const keys = new Set(report.checks.map((c) => c.key));
  assert.equal(keys.size, report.checks.length);

  for (const c of report.checks) {
    assert.ok(
      INTEGRITY_CATEGORIES.includes(c.category),
      `check ${c.key} has invalid category ${c.category}`,
    );
    assert.ok(
      INTEGRITY_SEVERITIES.includes(c.severity),
      `check ${c.key} has invalid severity ${c.severity}`,
    );
    assert.ok(c.sampleRefs.length <= INTEGRITY_SAMPLE_CAP);
    for (const r of c.sampleRefs) {
      assert.ok(
        INTEGRITY_SAMPLE_KINDS.includes(r.kind),
        `sampleRef on ${c.key} has invalid kind ${r.kind}`,
      );
      assert.equal(typeof r.id, "string");
    }
  }

  // generatedAt is a parseable ISO timestamp.
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));

  // failingChecks is consistent with `ok`.
  const computedFailing = report.checks.filter((c) => c.count > 0).length;
  assert.equal(report.failingChecks, computedFailing);
  assert.equal(report.ok, computedFailing === 0);
});

test("seeded violations surface with correct category + sample kind", async () => {
  const report = await runIntegritySweep();

  // ----- structural -------------------------------------------------------
  const noTargets = findCheck(report, "asl_no_targets");
  assert.equal(noTargets.category, "structural");
  assert.equal(noTargets.severity, "critical");
  assert.ok(
    sampleIds(report, "asl_no_targets").includes(String(aslNoTargetsId)),
    `expected asl_no_targets sampleRefs to include ${aslNoTargetsId}`,
  );
  for (const r of noTargets.sampleRefs) assert.equal(r.kind, "source_link");

  const unknownType = findCheck(report, "asl_unknown_source_type");
  assert.equal(unknownType.category, "structural");
  assert.ok(
    sampleIds(report, "asl_unknown_source_type").includes(
      String(aslUnknownTypeId),
    ),
  );

  const expMissing = findCheck(report, "asl_expense_missing_source");
  assert.equal(expMissing.category, "structural");
  assert.ok(
    sampleIds(report, "asl_expense_missing_source").includes(
      String(aslExpenseMissingSourceId),
    ),
  );

  const expBadEvent = findCheck(report, "asl_expense_bad_event");
  assert.equal(expBadEvent.category, "structural");
  assert.equal(expBadEvent.severity, "warning");
  assert.ok(
    sampleIds(report, "asl_expense_bad_event").includes(
      String(aslExpenseBadEventId),
    ),
  );

  // ----- status_mismatch --------------------------------------------------
  const blockedNoReason = findCheck(report, "expense_blocked_no_reason");
  assert.equal(blockedNoReason.category, "status_mismatch");
  assert.ok(
    sampleIds(report, "expense_blocked_no_reason").includes(
      String(blockedNoReasonExpenseId),
    ),
  );
  for (const r of blockedNoReason.sampleRefs)
    assert.equal(r.kind, "expense");

  const postedWithBlock = findCheck(report, "expense_posted_with_block");
  assert.equal(postedWithBlock.category, "status_mismatch");
  assert.ok(
    sampleIds(report, "expense_posted_with_block").includes(
      String(postedWithBlockExpenseId),
    ),
  );

  // ----- missing_bridge ---------------------------------------------------
  const postedNoLink = findCheck(report, "expense_posted_no_link");
  assert.equal(postedNoLink.category, "missing_bridge");
  assert.equal(postedNoLink.severity, "critical");
  assert.ok(
    sampleIds(report, "expense_posted_no_link").includes(
      String(postedNoLinkExpenseId),
    ),
  );

  const draftNoLink = findCheck(report, "expense_draft_no_link");
  assert.equal(draftNoLink.category, "missing_bridge");
  assert.ok(
    sampleIds(report, "expense_draft_no_link").includes(
      String(draftNoLinkExpenseId),
    ),
  );

  const billPostedNoLink = findCheck(report, "bill_accrual_posted_no_link");
  assert.equal(billPostedNoLink.category, "missing_bridge");
  assert.ok(
    sampleIds(report, "bill_accrual_posted_no_link").includes(
      String(postedNoLinkBillAccrualId),
    ),
  );
  for (const r of billPostedNoLink.sampleRefs) assert.equal(r.kind, "bill");

  // ----- ok flag must be false when any check has findings ----------------
  assert.equal(report.ok, false);
  assert.ok(report.failingChecks > 0);
});

test("count is the FULL affected count, never silently truncated", async () => {
  // Seed >25 expense_blocked_no_reason rows so the cap kicks in but the
  // count must still reflect the full population.
  const baselineReport = await runIntegritySweep();
  const baselineCount = findCheck(
    baselineReport,
    "expense_blocked_no_reason",
  ).count;

  const extras: Array<{ id: number }> = [];
  const NUM_EXTRA = 30;
  for (let i = 0; i < NUM_EXTRA; i++) {
    const [row] = await db
      .insert(expensesTable)
      .values({
        submittedBy: `${TAG}-cap-${i}`,
        expenseDate: "2030-02-01",
        merchant: `Cap-${i}`,
        description: "x",
        amount: "0.01",
        paymentMethod: "cash",
        status: "draft",
        accountingStatus: "blocked",
      })
      .returning({ id: expensesTable.id });
    extras.push({ id: row!.id });
  }

  try {
    const report = await runIntegritySweep();
    const c = findCheck(report, "expense_blocked_no_reason");
    assert.equal(c.count, baselineCount + NUM_EXTRA);
    assert.ok(
      c.sampleRefs.length <= INTEGRITY_SAMPLE_CAP,
      `sampleRefs must be capped at ${INTEGRITY_SAMPLE_CAP}, got ${c.sampleRefs.length}`,
    );
    // Cap actually engaged because we added > cap rows of just this kind.
    assert.equal(c.sampleRefs.length, INTEGRITY_SAMPLE_CAP);
  } finally {
    await db
      .delete(expensesTable)
      .where(
        inArray(
          expensesTable.id,
          extras.map((e) => e.id),
        ),
      );
  }
});

test("HTTP endpoint: admin gets the same shape the service returns", async () => {
  const direct = await runIntegritySweep();
  const adminCookie = `lh_session=${encodeSession(adminUserId)}`;
  const res = await fetch(`${baseUrl}/admin/integrity/sweep`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as IntegritySweepReport;
  assert.equal(body.totalChecks, direct.totalChecks);
  assert.equal(body.checks.length, direct.checks.length);
  assert.equal(body.ok, direct.ok);
  // Per-check parity (counts/categories/keys identical between two
  // back-to-back reads of the same DB state).
  const directByKey = new Map(direct.checks.map((c) => [c.key, c]));
  for (const c of body.checks) {
    const d = directByKey.get(c.key);
    assert.ok(d, `route returned unknown key ${c.key}`);
    assert.equal(c.count, d!.count, `count drift on ${c.key}`);
    assert.equal(c.category, d!.category);
    assert.equal(c.severity, d!.severity);
  }
});

test("HTTP endpoint: non-admin role is rejected with 403", async () => {
  const viewerCookie = `lh_session=${encodeSession(viewerUserId)}`;
  const res = await fetch(`${baseUrl}/admin/integrity/sweep`, {
    headers: { cookie: viewerCookie },
  });
  assert.equal(res.status, 403);
});

test("HTTP endpoint: anonymous request is rejected with 401", async () => {
  const res = await fetch(`${baseUrl}/admin/integrity/sweep`);
  assert.equal(res.status, 401);
});

test("all-OK shape contract: zero-count checks always have empty sampleRefs", async () => {
  // We can't fully reset the DB inside this suite (we ourselves seed
  // violations), but the all-OK contract is per-check: any check whose
  // count is 0 must present empty sampleRefs and contribute nothing to
  // failingChecks. This guarantees the "clean" rendering for each check
  // independently — exactly what the Findings UI in #104 needs.
  const report = await runIntegritySweep();
  let okChecks = 0;
  for (const c of report.checks) {
    if (c.count === 0) {
      okChecks += 1;
      assert.equal(
        c.sampleRefs.length,
        0,
        `check ${c.key} has count=0 but sampleRefs=${c.sampleRefs.length}`,
      );
    } else {
      assert.ok(
        c.sampleRefs.length > 0,
        `check ${c.key} has count=${c.count} but no sampleRefs`,
      );
      assert.ok(c.sampleRefs.length <= c.count);
    }
  }
  assert.equal(report.failingChecks + okChecks, report.totalChecks);
  // If, hypothetically, every check were at zero, the contract requires
  // ok=true. Verify the boolean derivation is consistent with the
  // current report rather than the (unreachable, given our seeding)
  // fully-clean state.
  assert.equal(report.ok, report.failingChecks === 0);
});

test("key mapping regression: service keys match sweep.sql 1:1", async () => {
  // Lock the sweep.sql → service key mapping so a future SQL edit that
  // adds, removes, or renames a check fails CI here instead of silently
  // drifting from the typed service.
  const sqlPath = path.resolve(
    process.cwd(),
    "../../scripts/integrity/sweep.sql",
  );
  const sqlText = readFileSync(sqlPath, "utf-8");
  const sqlKeys = Array.from(
    sqlText.matchAll(/SELECT '([a-z0-9_]+)'\s*,/g),
    (m) => m[1] as string,
  );
  // Sanity: sweep.sql should have at least the documented 32 checks.
  assert.equal(sqlKeys.length, 32, "sweep.sql key count drifted from 32");
  const sqlSet = new Set(sqlKeys);
  const serviceSet = new Set(INTEGRITY_CHECK_KEYS);
  const missingFromService = [...sqlSet].filter((k) => !serviceSet.has(k));
  const extraInService = [...serviceSet].filter((k) => !sqlSet.has(k));
  assert.deepEqual(
    missingFromService,
    [],
    `service is missing checks present in sweep.sql: ${missingFromService.join(", ")}`,
  );
  assert.deepEqual(
    extraInService,
    [],
    `service has checks not in sweep.sql: ${extraInService.join(", ")}`,
  );
});

test("all-OK contract: with seeded violations removed, sweep returns ok=true / count=0 / sampleRefs=[] for every check", async () => {
  // Deliberately mutate the DB into a fully-clean state by removing
  // EVERY violation row this suite seeded, then run the sweep and
  // assert the locked all-OK presentation. We restore the rows
  // afterwards so the rest of the suite + after() cleanup stays
  // consistent. This is the only honest way to assert ok=true given
  // that node:test's `before()` runs once for the file and we need
  // seeded violations for the rest of the suite.

  // Snapshot full row data so we can re-insert with the exact same IDs
  // (preserving the IDs other tests already captured).
  const seededAslRows = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(inArray(accountingSourceLinksTable.id, seededAslIds));
  const seededExpenseIds = [
    blockedNoReasonExpenseId,
    postedWithBlockExpenseId,
    postedNoLinkExpenseId,
    draftNoLinkExpenseId,
  ];
  const seededExpenseRows = await db
    .select()
    .from(expensesTable)
    .where(inArray(expensesTable.id, seededExpenseIds));
  const seededBillRows = await db
    .select()
    .from(billsTable)
    .where(inArray(billsTable.id, [postedNoLinkBillAccrualId]));

  // Tear down (ASLs first — they reference expenses by source_id).
  await db
    .delete(accountingSourceLinksTable)
    .where(inArray(accountingSourceLinksTable.id, seededAslIds));
  await db
    .delete(expensesTable)
    .where(inArray(expensesTable.id, seededExpenseIds));
  await db
    .delete(billsTable)
    .where(inArray(billsTable.id, [postedNoLinkBillAccrualId]));

  try {
    const report = await runIntegritySweep();
    // The locked all-OK presentation:
    assert.equal(report.ok, true, "report.ok must be true on a clean DB");
    assert.equal(report.failingChecks, 0);
    assert.equal(report.totalChecks, 32);
    assert.equal(report.checks.length, 32);
    for (const c of report.checks) {
      assert.equal(c.count, 0, `check ${c.key} should have count=0 on clean DB`);
      assert.deepEqual(
        c.sampleRefs,
        [],
        `check ${c.key} should have empty sampleRefs on clean DB`,
      );
    }

    // CLI exit-code parity on a clean DB: still exit 0.
    const scriptPath = path.resolve(
      process.cwd(),
      "src/scripts/integritySweep.ts",
    );
    const cliResult = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn("pnpm", ["exec", "tsx", scriptPath], {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf-8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
      },
    );
    assert.equal(cliResult.code, 0);
    const cliReport = JSON.parse(cliResult.stdout) as IntegritySweepReport;
    assert.equal(cliReport.ok, true);
    assert.equal(cliReport.failingChecks, 0);
  } finally {
    // Restore the seeded rows so the rest of the suite + after()
    // cleanup keep working. Re-insert in dependency order: parents
    // first (expenses, bills) so ASLs can reference them again.
    if (seededExpenseRows.length) {
      await db.insert(expensesTable).values(seededExpenseRows);
    }
    if (seededBillRows.length) {
      await db.insert(billsTable).values(seededBillRows);
    }
    if (seededAslRows.length) {
      await db.insert(accountingSourceLinksTable).values(seededAslRows);
    }
  }
});

test("CLI runner: stdout is parseable JSON matching the locked report shape; exits 0", async () => {
  // Spawn the CLI as a real subprocess so we exercise the bundled
  // contract: human summary → stderr, locked JSON → stdout, exit 0
  // even with findings present.
  const scriptPath = path.resolve(
    process.cwd(),
    "src/scripts/integritySweep.ts",
  );
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", scriptPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf-8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `CLI exit non-zero. stderr:\n${result.stderr}`);
  // stderr should carry the human summary header.
  assert.match(result.stderr, /Integrity Sweep — generated /);
  // stdout must be a single JSON document matching the locked shape.
  const parsed = JSON.parse(result.stdout) as IntegritySweepReport;
  assert.equal(parsed.totalChecks, 32);
  assert.equal(parsed.checks.length, 32);
  assert.equal(typeof parsed.generatedAt, "string");
  assert.equal(typeof parsed.ok, "boolean");
  assert.equal(typeof parsed.failingChecks, "number");
  for (const c of parsed.checks) {
    assert.equal(typeof c.key, "string");
    assert.equal(typeof c.count, "number");
    assert.ok(Array.isArray(c.sampleRefs));
  }
  // CLI/API parity: same DB state should produce identical per-check
  // counts (drop generatedAt, which is wall-clock).
  const direct = await runIntegritySweep();
  const directByKey = new Map(direct.checks.map((c) => [c.key, c]));
  for (const c of parsed.checks) {
    const d = directByKey.get(c.key);
    assert.ok(d, `CLI emitted unknown key ${c.key}`);
    assert.equal(c.category, d!.category);
    assert.equal(c.severity, d!.severity);
    // Counts may shift only if other suites mutate state between runs;
    // this suite's own seeded rows are stable, so equality is expected.
    assert.equal(c.count, d!.count, `CLI/API count drift on ${c.key}`);
  }
});
