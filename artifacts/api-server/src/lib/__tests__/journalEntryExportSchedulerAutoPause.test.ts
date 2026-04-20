/**
 * Task #78 — Auto-pause + re-enable behavior for scheduled CSV exports.
 *
 * The auto-pause logic added in Task #68 lives in two places that must
 * stay in lockstep:
 *
 *   1. `applyRunOutcome` in journalEntryExportScheduler.ts — bumps the
 *      consecutive-failure counter on failed runs, resets it on
 *      sent / empty, and once the counter hits MAX_CONSECUTIVE_FAILURES
 *      pauses the schedule + notifies admins. Shared by the scheduler
 *      tick and the manual "Run now" admin action so both observe the
 *      identical pause threshold (an admin spamming "Run now" against a
 *      broken send must not be able to bypass auto-pause).
 *
 *   2. The PATCH route in routes/journal-entry-export-schedules.ts —
 *      when an admin re-enables a row (whether previously admin-disabled
 *      or auto-paused) the failure counter, `auto_paused_at`,
 *      `auto_paused_reason`, and `last_run_error` must all clear so the
 *      next failure starts a fresh run-of-three toward auto-pause. Without
 *      this an auto-paused row would re-pause itself after a single
 *      failure post-revival.
 *
 * Both are pure server-side branches with no UI assertion in CI today;
 * an off-by-one on the threshold or a forgotten reset would silently
 * regress in production. This suite locks the behavior end-to-end:
 * applyRunOutcome is tested directly (cheap, deterministic) and the
 * re-enable path is tested through the actual Express router so the SQL
 * the route writes is exercised, not paraphrased.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
  journalEntryExportSchedulesTable,
  journalEntryExportSendLogTable,
  notificationsTable,
  activityLogTable,
  type JournalEntryExportSchedule,
} from "@workspace/db";
import {
  applyRunOutcome,
  MAX_CONSECUTIVE_FAILURES,
  runSchedule,
} from "../journalEntryExportScheduler";
import { encodeSession } from "../auth";
import scheduleRouter from "../../routes/journal-entry-export-schedules";

const TAG = `t78-${process.pid}-${Date.now()}`;

let adminUserId: number;
let secondAdminUserId: number;
let nonAdminUserId: number;
let app: Express;
let server: Server;
let baseUrl: string;
let adminCookie: string;

const insertedScheduleIds: number[] = [];

// Snapshot env vars we mutate so cross-test coupling is impossible if the
// test runner ever shifts to in-process scheduling. Restored in `after`.
const ORIGINAL_SENDGRID_API_KEY = process.env["SENDGRID_API_KEY"];
const ORIGINAL_NOTIFICATION_FROM_EMAIL = process.env["NOTIFICATION_FROM_EMAIL"];

/**
 * Insert a fresh schedule row at the requested starting state. Each test
 * uses its own row so failure-counter mutations from one test cannot
 * leak into the next; the row id is tracked for cleanup in `after`.
 */
async function insertSchedule(
  overrides: Partial<typeof journalEntryExportSchedulesTable.$inferInsert> = {},
): Promise<JournalEntryExportSchedule> {
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-${overrides["name"] ?? Math.random().toString(36).slice(2, 8)}`,
      enabled: true,
      cadence: "daily",
      recipients: [`${TAG}@test.local`],
      includeLines: false,
      // Default to a future next_run_at so the background scheduler tick
      // (if it ever ran in-process during tests) cannot claim the row.
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
      ...overrides,
    })
    .returning();
  assert.ok(row, "failed to insert fixture schedule");
  insertedScheduleIds.push(row!.id);
  return row!;
}

async function refetch(id: number): Promise<JournalEntryExportSchedule> {
  const [row] = await db
    .select()
    .from(journalEntryExportSchedulesTable)
    .where(eq(journalEntryExportSchedulesTable.id, id));
  assert.ok(row, `schedule ${id} vanished`);
  return row!;
}

before(async () => {
  // The auto-pause notification path tries to email admins. We unset the
  // SendGrid key so deliverEmail short-circuits to "not_attempted" rather
  // than calling out to the network — important so that runSchedule
  // produces a *deterministic* "failed" result in the manual-run-now
  // test below regardless of the host environment.
  delete process.env["SENDGRID_API_KEY"];
  delete process.env["NOTIFICATION_FROM_EMAIL"];

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin1@test.local`,
      passwordHash: "x",
      firstName: "T78",
      lastName: "AdminOne",
      role: "admin",
    })
    .returning();
  adminUserId = admin!.id;

  const [admin2] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin2@test.local`,
      passwordHash: "x",
      firstName: "T78",
      lastName: "AdminTwo",
      role: "admin",
    })
    .returning();
  secondAdminUserId = admin2!.id;

  // A non-admin so we can prove the auto-pause notification fan-out is
  // restricted to the admin role and doesn't spam every user in the system.
  const [other] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-other@test.local`,
      passwordHash: "x",
      firstName: "T78",
      lastName: "Submitter",
      role: "submitter",
    })
    .returning();
  nonAdminUserId = other!.id;

  // Mount the actual route module (not a paraphrase) on a throwaway
  // Express app. The router has its own requireAuth + requireRole inside;
  // we satisfy both by sending a real lh_session cookie minted with the
  // same encodeSession the production login route uses.
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", scheduleRouter);
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
  adminCookie = `lh_session=${encodeSession(adminUserId)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));

  // Restore env vars we mutated in `before` so this file is a polite
  // citizen if the test runner is ever changed to share a process across
  // files (today node --test isolates each file, but this is cheap insurance).
  if (ORIGINAL_SENDGRID_API_KEY === undefined) {
    delete process.env["SENDGRID_API_KEY"];
  } else {
    process.env["SENDGRID_API_KEY"] = ORIGINAL_SENDGRID_API_KEY;
  }
  if (ORIGINAL_NOTIFICATION_FROM_EMAIL === undefined) {
    delete process.env["NOTIFICATION_FROM_EMAIL"];
  } else {
    process.env["NOTIFICATION_FROM_EMAIL"] = ORIGINAL_NOTIFICATION_FROM_EMAIL;
  }

  if (insertedScheduleIds.length > 0) {
    // Send-log + notifications + activity-log rows fan out from these
    // schedules; clear them first so the schedule delete is unblocked
    // and the test database stays clean across runs.
    await db
      .delete(journalEntryExportSendLogTable)
      .where(
        inArray(
          journalEntryExportSendLogTable.scheduleId,
          insertedScheduleIds,
        ),
      );
    await db
      .delete(journalEntryExportSchedulesTable)
      .where(
        inArray(journalEntryExportSchedulesTable.id, insertedScheduleIds),
      );
  }

  const userIds = [adminUserId, secondAdminUserId, nonAdminUserId].filter(
    (id): id is number => typeof id === "number",
  );
  if (userIds.length > 0) {
    await db
      .delete(notificationsTable)
      .where(inArray(notificationsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }

  await pool.end();
});

// ---------------------------------------------------------------------------
// applyRunOutcome — failure counter, auto-pause threshold, notifications.
// ---------------------------------------------------------------------------

test("3 consecutive failures pause the schedule and notify every admin", async () => {
  const schedule = await insertSchedule({ name: "pause-after-3" });

  // First two failures bump the counter but must NOT pause — proves the
  // threshold is `>=` not `>`, and that we don't fire the notification
  // / clear next_run_at prematurely (the prior bug we're locking out).
  for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
    const before = await refetch(schedule.id);
    await applyRunOutcome(before, {
      status: "failed",
      error: `boom-${i}`,
    });
    const after = await refetch(schedule.id);
    assert.equal(
      after.consecutiveFailureCount,
      i,
      `failure ${i}: counter should advance one step at a time`,
    );
    assert.equal(
      after.enabled,
      true,
      `failure ${i}: schedule must remain enabled below the threshold`,
    );
    assert.equal(
      after.autoPausedAt,
      null,
      `failure ${i}: must not stamp auto_paused_at below the threshold`,
    );
    assert.equal(after.lastRunStatus, "failed");
    assert.equal(after.lastRunError, `boom-${i}`);
    assert.ok(
      after.nextRunAt,
      `failure ${i}: next_run_at must be preserved below the threshold`,
    );
  }

  // The threshold-crossing failure must pause + notify atomically.
  const beforeFinal = await refetch(schedule.id);
  await applyRunOutcome(beforeFinal, {
    status: "failed",
    error: "final-boom",
  });
  const paused = await refetch(schedule.id);

  assert.equal(
    paused.consecutiveFailureCount,
    MAX_CONSECUTIVE_FAILURES,
    "counter must reach the threshold exactly",
  );
  assert.equal(paused.enabled, false, "must auto-disable at the threshold");
  assert.equal(
    paused.nextRunAt,
    null,
    "must null out next_run_at so the scheduler stops claiming the row",
  );
  assert.ok(paused.autoPausedAt, "must stamp auto_paused_at");
  assert.equal(
    paused.autoPausedReason,
    "final-boom",
    "auto_paused_reason must capture the final error so the admin sees it",
  );

  // A notification row must exist for *each* admin in the system —
  // both `admin1` and `admin2` here. The non-admin must NOT receive one
  // (otherwise we'd spam reviewers/submitters with infra warnings).
  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.referenceId, schedule.id));
  const notifiedUserIds = new Set(notifications.map((n) => n.userId));
  assert.ok(
    notifiedUserIds.has(adminUserId),
    "first admin must be notified",
  );
  assert.ok(
    notifiedUserIds.has(secondAdminUserId),
    "second admin must be notified",
  );
  assert.ok(
    !notifiedUserIds.has(nonAdminUserId),
    "non-admin users must NOT be notified about auto-pause",
  );
  for (const n of notifications) {
    assert.equal(n.type, "journal_export_auto_paused");
    assert.equal(n.referenceType, "journal_entry_export_schedule");
  }

  // And an activity-log entry must exist so the audit trail records the
  // auto-pause without depending on email delivery succeeding.
  const activity = await db
    .select()
    .from(activityLogTable)
    .where(eq(activityLogTable.referenceId, schedule.id));
  const autoPauseEntries = activity.filter(
    (a) => a.type === "journal_export_auto_paused",
  );
  assert.equal(
    autoPauseEntries.length,
    1,
    "exactly one auto-pause activity log entry must be written",
  );
});

test("a successful run resets the consecutive-failure counter and clears the last error", async () => {
  // Start mid-streak (count=2) so we prove a single sent run wipes the
  // counter back to 0, not merely decrements it. Off-by-one in the
  // reset would let a single late success preserve a counter that then
  // tips into auto-pause on the next failure — the regression this guards.
  const schedule = await insertSchedule({
    name: "reset-on-sent",
    consecutiveFailureCount: 2,
    lastRunStatus: "failed",
    lastRunError: "stale error from a prior failure",
  });

  await applyRunOutcome(schedule, { status: "sent" });

  const after = await refetch(schedule.id);
  assert.equal(after.consecutiveFailureCount, 0, "sent must reset to 0");
  assert.equal(after.lastRunStatus, "sent");
  assert.equal(
    after.lastRunError,
    null,
    "sent must clear the stale failure error so the UI doesn't keep showing it",
  );
  assert.equal(
    after.autoPausedAt,
    null,
    "an enabled row's auto_paused_at must remain cleared on success",
  );
});

test("an empty (zero-row) run resets the counter the same as a successful send", async () => {
  // Empty weeks are *expected* (a slow accounting period legitimately has
  // no postings). They must be treated as success for failure-tracking
  // purposes — otherwise a quiet month would auto-pause the schedule.
  const schedule = await insertSchedule({
    name: "reset-on-empty",
    consecutiveFailureCount: 2,
    lastRunStatus: "failed",
    lastRunError: "previous transient error",
  });

  await applyRunOutcome(schedule, { status: "empty" });

  const after = await refetch(schedule.id);
  assert.equal(
    after.consecutiveFailureCount,
    0,
    "empty must reset the counter (zero-row weeks are not failures)",
  );
  assert.equal(after.lastRunStatus, "empty");
  assert.equal(after.lastRunError, null);
});

test("manual Run-now runs through the same applyRunOutcome path and can also push past the auto-pause threshold", async () => {
  // Pre-load the row at one failure away from the threshold so the
  // single manual run trips auto-pause. With SENDGRID unset, runSchedule
  // gets `not_attempted` from deliverEmail, which it maps to `failed` —
  // exactly the production failure mode an admin would hit when the
  // SendGrid key is wrong / revoked.
  const schedule = await insertSchedule({
    name: "manual-pause",
    consecutiveFailureCount: MAX_CONSECUTIVE_FAILURES - 1,
    lastRunStatus: "failed",
  });

  const result = await runSchedule(schedule, {
    triggeredBy: "manual",
    triggeredByUserId: adminUserId,
  });
  assert.equal(
    result.status,
    "failed",
    "no email config → runSchedule must report failed (not silently 'sent')",
  );

  // Apply the outcome through the same call the route does, and assert
  // the row paused. This is the property Task #68 is supposed to give us:
  // the manual button cannot circumvent auto-pause.
  await applyRunOutcome(schedule, result);
  const paused = await refetch(schedule.id);
  assert.equal(
    paused.enabled,
    false,
    "manual Run-now must respect the auto-pause threshold",
  );
  assert.equal(paused.consecutiveFailureCount, MAX_CONSECUTIVE_FAILURES);
  assert.ok(
    paused.autoPausedAt,
    "manual Run-now that crosses the threshold must stamp auto_paused_at",
  );
  assert.equal(
    paused.nextRunAt,
    null,
    "manual Run-now that crosses the threshold must null next_run_at",
  );
});

test("a successful run on a still-disabled row preserves auto_paused_at (admin must explicitly re-enable)", async () => {
  // Scenario: row was auto-paused; an admin clicks "Run now" to test
  // their fix without re-enabling first. The send succeeds. We must
  // reset the failure counter (the fix worked!) but we must NOT clear
  // the auto-pause marker — that's reserved for an explicit re-enable
  // so the banner keeps nagging until the admin acknowledges.
  const pausedAt = new Date(Date.now() - 60_000);
  const schedule = await insertSchedule({
    name: "manual-on-paused",
    enabled: false,
    nextRunAt: null,
    consecutiveFailureCount: MAX_CONSECUTIVE_FAILURES,
    autoPausedAt: pausedAt,
    autoPausedReason: "the prior reason",
    lastRunStatus: "failed",
    lastRunError: "the prior error",
  });

  await applyRunOutcome(schedule, { status: "sent" });

  const after = await refetch(schedule.id);
  assert.equal(
    after.consecutiveFailureCount,
    0,
    "the fix worked — counter must reset",
  );
  assert.equal(after.lastRunStatus, "sent");
  assert.equal(after.lastRunError, null);
  assert.equal(
    after.enabled,
    false,
    "the row must remain disabled until the admin re-enables it",
  );
  assert.ok(
    after.autoPausedAt,
    "auto_paused_at must NOT be cleared by a manual run on a paused row",
  );
  assert.equal(
    after.autoPausedReason,
    "the prior reason",
    "auto_paused_reason must NOT be cleared by a manual run on a paused row",
  );
});

// ---------------------------------------------------------------------------
// PATCH /journal-entry-export-schedules/:id — re-enable clears the
// failure tracking. Exercised through the real router (not a paraphrase)
// so the SQL the route actually writes is what's under test.
// ---------------------------------------------------------------------------

test("PATCH enabled:true on an auto-paused row clears the counter, auto_paused_at, auto_paused_reason, and last_run_error", async () => {
  const schedule = await insertSchedule({
    name: "patch-re-enable",
    enabled: false,
    nextRunAt: null,
    consecutiveFailureCount: MAX_CONSECUTIVE_FAILURES,
    autoPausedAt: new Date(Date.now() - 60_000),
    autoPausedReason: "SendGrid quota exhausted",
    lastRunStatus: "failed",
    lastRunError: "SendGrid quota exhausted",
  });

  const res = await fetch(
    `${baseUrl}/journal-entry-export-schedules/${schedule.id}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({ enabled: true }),
    },
  );
  const rawBody = await res.text();
  assert.equal(res.status, 200, rawBody);
  const body = JSON.parse(rawBody) as { schedule: JournalEntryExportSchedule };
  // Sanity-check the response envelope mirrors the DB write — the UI
  // optimistically re-renders from this payload, so any drift here
  // would briefly show a stale "auto-paused" badge after re-enable.
  assert.equal(body.schedule.enabled, true);
  assert.equal(body.schedule.consecutiveFailureCount, 0);
  assert.equal(body.schedule.autoPausedAt, null);
  assert.equal(body.schedule.autoPausedReason, null);
  assert.equal(body.schedule.lastRunError, null);

  const persisted = await refetch(schedule.id);
  assert.equal(persisted.enabled, true);
  assert.equal(
    persisted.consecutiveFailureCount,
    0,
    "re-enable must zero the counter so the next failure starts a fresh run-of-three",
  );
  assert.equal(persisted.autoPausedAt, null);
  assert.equal(persisted.autoPausedReason, null);
  assert.equal(persisted.lastRunError, null);
  assert.ok(
    persisted.nextRunAt,
    "re-enable must compute a fresh next_run_at so the scheduler picks the row up again",
  );
  assert.ok(
    persisted.nextRunAt!.getTime() > Date.now(),
    "the freshly computed next_run_at must be in the future",
  );
});

test("PATCH enabled:true on a row that was already enabled is a no-op for failure tracking", async () => {
  // Defensive: the reset branch must only fire on the false→true
  // transition (admin actually re-enabling). If it fired on every PATCH
  // an unrelated edit (e.g. updating recipients) that incidentally sent
  // `enabled: true` would wipe in-progress failure tracking and
  // indefinitely defer auto-pause.
  const schedule = await insertSchedule({
    name: "patch-already-enabled",
    enabled: true,
    consecutiveFailureCount: 2,
    lastRunStatus: "failed",
    lastRunError: "still investigating",
  });

  const res = await fetch(
    `${baseUrl}/journal-entry-export-schedules/${schedule.id}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        enabled: true,
        recipients: [`${TAG}-new@test.local`],
      }),
    },
  );
  assert.equal(res.status, 200);

  const persisted = await refetch(schedule.id);
  assert.equal(
    persisted.consecutiveFailureCount,
    2,
    "no false→true transition → counter must be preserved",
  );
  assert.equal(
    persisted.lastRunError,
    "still investigating",
    "no false→true transition → lastRunError must be preserved",
  );
  assert.deepEqual(persisted.recipients, [`${TAG}-new@test.local`]);
});
