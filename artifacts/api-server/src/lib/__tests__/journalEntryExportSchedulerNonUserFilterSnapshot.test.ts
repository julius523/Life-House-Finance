/**
 * Task #97 — non-user filter context snapshotted onto each send-log row.
 *
 * Task #89 already pinned the resolved posted-by / approver labels onto
 * each send-log row so historical entries stay auditable when the
 * schedule's user filters change. The same drift exists for the
 * schedule's other filters (status, source, cadence, includeLines): an
 * admin editing them silently rewrites how older runs are interpreted.
 *
 * This suite locks the end-to-end behavior:
 *
 *   1. `runSchedule` writes a send-log row with the status / source /
 *      cadence / includeLines values that were active at run time, even
 *      after the schedule itself is later mutated.
 *
 *   2. The GET /:id/log endpoint surfaces those snapshotted columns so
 *      the management page can render historical context without
 *      re-resolving anything against the (now stale) schedule row.
 *
 *   3. A schedule with no status / source filter records null (not the
 *      literal string "all") so the UI owns the friendly fallback and
 *      the column stays distinguishable from a hypothetical real value.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

import {
  db,
  pool,
  usersTable,
  journalEntryExportSchedulesTable,
  journalEntryExportSendLogTable,
} from "@workspace/db";
import { runSchedule } from "../journalEntryExportScheduler";
import { encodeSession } from "../auth";
import scheduleRouter from "../../routes/journal-entry-export-schedules";

const TAG = `t97-${process.pid}-${Date.now()}`;

let adminUserId: number;
let app: Express;
let server: Server;
let baseUrl: string;
let adminCookie: string;

const insertedScheduleIds: number[] = [];

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "T97",
      lastName: "Admin",
      role: "admin",
    })
    .returning();
  adminUserId = admin!.id;

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
  if (insertedScheduleIds.length > 0) {
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
  if (typeof adminUserId === "number") {
    await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  }
  await pool.end();
});

test("Task #97 — runSchedule snapshots status / source / cadence / includeLines onto the send-log row, surviving later edits", async () => {
  const [schedule] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-snapshot-context`,
      enabled: true,
      cadence: "weekly",
      recipients: [`${TAG}-recipient@test.local`],
      filterStatus: "posted",
      filterSource: "expense",
      includeLines: true,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(schedule!.id);

  await runSchedule(schedule!, {
    triggeredBy: "manual",
    triggeredByUserId: adminUserId,
  });

  // Mutate every snapshotted field on the schedule. The pre-existing
  // send-log row must continue to describe the run as it was actually
  // configured — not what the schedule says today.
  await db
    .update(journalEntryExportSchedulesTable)
    .set({
      cadence: "daily",
      filterStatus: "reversed",
      filterSource: "manual",
      includeLines: false,
    })
    .where(eq(journalEntryExportSchedulesTable.id, schedule!.id));

  const rows = await db
    .select()
    .from(journalEntryExportSendLogTable)
    .where(eq(journalEntryExportSendLogTable.scheduleId, schedule!.id));
  assert.equal(rows.length, 1, "expected exactly one send-log row");
  assert.equal(rows[0]!.cadence, "weekly");
  assert.equal(rows[0]!.filterStatus, "posted");
  assert.equal(rows[0]!.filterSource, "expense");
  assert.equal(rows[0]!.includeLines, true);

  // The /:id/log endpoint must surface the snapshotted fields so the
  // management page can render historical context without re-fetching
  // the (now-edited) schedule.
  const res = await fetch(
    `${baseUrl}/journal-entry-export-schedules/${schedule!.id}/log`,
    { headers: { Cookie: adminCookie } },
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    entries: Array<{
      cadence: string | null;
      filterStatus: string | null;
      filterSource: string | null;
      includeLines: boolean | null;
    }>;
  };
  assert.equal(json.entries.length, 1);
  assert.equal(json.entries[0]!.cadence, "weekly");
  assert.equal(json.entries[0]!.filterStatus, "posted");
  assert.equal(json.entries[0]!.filterSource, "expense");
  assert.equal(json.entries[0]!.includeLines, true);
});

test("Task #97 — schedule with no status/source filter records null snapshots, not 'all' strings", async () => {
  const [schedule] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-no-filters-context`,
      enabled: true,
      cadence: "monthly",
      recipients: [`${TAG}-recipient@test.local`],
      filterStatus: null,
      filterSource: null,
      includeLines: false,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(schedule!.id);

  await runSchedule(schedule!, {
    triggeredBy: "manual",
    triggeredByUserId: adminUserId,
  });
  const rows = await db
    .select()
    .from(journalEntryExportSendLogTable)
    .where(eq(journalEntryExportSendLogTable.scheduleId, schedule!.id));
  assert.equal(rows.length, 1);
  // Null (not "all") — the UI owns the friendly fallback and the column
  // stays distinguishable from a hypothetical literal "all" value.
  assert.equal(rows[0]!.filterStatus, null);
  assert.equal(rows[0]!.filterSource, null);
  assert.equal(rows[0]!.cadence, "monthly");
  assert.equal(rows[0]!.includeLines, false);
});
