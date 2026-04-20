/**
 * Task #81 — "Posted by" / "Approver" filter labels in send-log emails
 * and on the schedule list endpoint.
 *
 * Reviewers were seeing the raw user id (e.g. "Posted by filter: 7") in
 * both the outbound email body and on the schedules management page when
 * the actors-picker query had not yet loaded. This suite locks the new
 * behavior end-to-end:
 *
 *   1. `resolveUserLabels` returns "Display Name <email>" for a real
 *      user, the bare email when the name fields are empty, and a
 *      "User #<id>" placeholder for ids that point at a deleted row.
 *
 *   2. `runSchedule` composes the email body with the friendly label
 *      (not the raw id) for both posted-by and approver filters, and
 *      gracefully falls back to the placeholder if the user vanished
 *      between schedule creation and run time. We capture the email by
 *      monkey-patching deliverEmail's transport (SENDGRID_API_KEY +
 *      NOTIFICATION_FROM_EMAIL set, fetch stubbed) so the test reads the
 *      *exact* body the SendGrid HTTP request would carry.
 *
 *   3. The GET /journal-entry-export-schedules endpoint enriches each
 *      row with `filterPostedByUserLabel` / `filterApproverUserLabel`
 *      so the management page no longer needs the actors data to render
 *      a friendly name on the row.
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
import {
  resolveUserLabels,
  runSchedule,
} from "../journalEntryExportScheduler";
import { encodeSession } from "../auth";
import scheduleRouter from "../../routes/journal-entry-export-schedules";

const TAG = `t81-${process.pid}-${Date.now()}`;

let adminUserId: number;
let posterUserId: number;
let posterNoNameUserId: number;
let approverUserId: number;
let app: Express;
let server: Server;
let baseUrl: string;
let adminCookie: string;

const insertedScheduleIds: number[] = [];

const ORIGINAL_SENDGRID_API_KEY = process.env["SENDGRID_API_KEY"];
const ORIGINAL_NOTIFICATION_FROM_EMAIL = process.env["NOTIFICATION_FROM_EMAIL"];
const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedSend {
  subject: string;
  body: string;
}

const captured: CapturedSend[] = [];

before(async () => {
  // Stand up SendGrid env vars + a fetch stub so deliverEmail actually
  // attempts a send and we can read the composed body. Without these the
  // helper short-circuits to "not_attempted" and never builds the
  // payload we want to assert against.
  process.env["SENDGRID_API_KEY"] = "test-key";
  process.env["NOTIFICATION_FROM_EMAIL"] = "noreply@test.local";
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("sendgrid.com")) {
      const raw = init?.body;
      const json =
        typeof raw === "string"
          ? (JSON.parse(raw) as {
              subject?: string;
              content?: Array<{ type: string; value: string }>;
            })
          : { subject: "", content: [] };
      const text =
        json.content?.find((c) => c.type === "text/plain")?.value ?? "";
      captured.push({ subject: json.subject ?? "", body: text });
      return new Response("", { status: 202 });
    }
    // Anything else (e.g. the test's own HTTP calls into the throwaway
    // Express server) goes to the real fetch — only the SendGrid round-trip
    // needs interception so we can read the composed email body.
    return ORIGINAL_FETCH(input as RequestInfo, init);
  }) as typeof fetch;

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "T81",
      lastName: "Admin",
      role: "admin",
    })
    .returning();
  adminUserId = admin!.id;

  const [poster] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-poster@test.local`,
      passwordHash: "x",
      firstName: "Posty",
      lastName: "McPostFace",
      role: "submitter",
    })
    .returning();
  posterUserId = poster!.id;

  const [posterNoName] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-noname@test.local`,
      passwordHash: "x",
      firstName: "",
      lastName: "",
      role: "submitter",
    })
    .returning();
  posterNoNameUserId = posterNoName!.id;

  const [approver] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-approver@test.local`,
      passwordHash: "x",
      firstName: "Apple",
      lastName: "Prover",
      role: "reviewer",
    })
    .returning();
  approverUserId = approver!.id;

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
  globalThis.fetch = ORIGINAL_FETCH;
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
  const userIds = [
    adminUserId,
    posterUserId,
    posterNoNameUserId,
    approverUserId,
  ].filter((id): id is number => typeof id === "number");
  if (userIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await pool.end();
});

test("resolveUserLabels formats present users and falls back to a placeholder for missing ids", async () => {
  // Pick a sentinel id that cannot collide with real rows. usersTable.id
  // is a serial; a value 9 orders of magnitude past anything seeded is a
  // safer choice than `Number.MAX_SAFE_INTEGER` (which exceeds int4).
  const missingId = 2_000_000_000;
  const labels = await resolveUserLabels([
    posterUserId,
    posterNoNameUserId,
    approverUserId,
    missingId,
    posterUserId, // duplicate — must collapse to one row in the map
  ]);
  assert.equal(
    labels.get(posterUserId),
    `Posty McPostFace <${TAG}-poster@test.local>`,
    "named user must render as 'First Last <email>'",
  );
  assert.equal(
    labels.get(posterNoNameUserId),
    `${TAG}-noname@test.local`,
    "user with empty name fields must fall back to bare email",
  );
  assert.equal(
    labels.get(approverUserId),
    `Apple Prover <${TAG}-approver@test.local>`,
  );
  assert.equal(
    labels.get(missingId),
    `User #${missingId}`,
    "deleted/missing ids must render as 'User #<id>' so the email body has *something* identifiable",
  );
});

test("runSchedule email body uses friendly labels for posted-by / approver filters", async () => {
  captured.length = 0;
  const [schedule] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-email-labels`,
      enabled: true,
      cadence: "daily",
      recipients: [`${TAG}-recipient@test.local`],
      filterPostedByUserId: posterUserId,
      filterApproverUserId: approverUserId,
      includeLines: false,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(schedule!.id);

  const result = await runSchedule(schedule!, {
    triggeredBy: "manual",
    triggeredByUserId: adminUserId,
  });
  // Even with zero matching JEs the email is sent (zero-row weeks are a
  // useful signal); we only care that the body composes correctly.
  assert.notEqual(result.status, "failed", `runSchedule should succeed: ${result.error}`);
  assert.equal(captured.length, 1, "exactly one outbound email expected");
  const body = captured[0]!.body;
  assert.ok(
    body.includes(`Posted by filter: Posty McPostFace <${TAG}-poster@test.local>`),
    `email body must surface the poster's name + email, not the raw id; got:\n${body}`,
  );
  assert.ok(
    body.includes(`Approver filter: Apple Prover <${TAG}-approver@test.local>`),
    `email body must surface the approver's name + email; got:\n${body}`,
  );
  assert.ok(
    !body.includes(`Posted by filter: ${posterUserId}`),
    "raw posted-by user id must not appear in the email body",
  );
});

test("runSchedule falls back to 'User #<id>' when the filtered user was deleted", async () => {
  captured.length = 0;
  // Insert a throwaway user, point a schedule at them, then delete the
  // user before running the schedule. The email must still send and the
  // body must show the placeholder rather than crash or print the raw id.
  const [ghost] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-ghost@test.local`,
      passwordHash: "x",
      firstName: "Ghost",
      lastName: "User",
      role: "submitter",
    })
    .returning();
  const ghostId = ghost!.id;
  const [schedule] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-ghost-labels`,
      enabled: true,
      cadence: "daily",
      recipients: [`${TAG}-recipient@test.local`],
      filterPostedByUserId: ghostId,
      filterApproverUserId: null,
      includeLines: false,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(schedule!.id);
  await db.delete(usersTable).where(eq(usersTable.id, ghostId));

  const result = await runSchedule(schedule!, {
    triggeredBy: "manual",
    triggeredByUserId: adminUserId,
  });
  assert.notEqual(result.status, "failed", `runSchedule should succeed even after the filter-target user was deleted: ${result.error}`);
  assert.equal(captured.length, 1);
  const body = captured[0]!.body;
  assert.ok(
    body.includes(`Posted by filter: User #${ghostId}`),
    `deleted-user fallback expected; got:\n${body}`,
  );
  assert.ok(
    body.includes("Approver filter: anyone"),
    "null filter must still render as 'anyone'",
  );
});

test("GET /journal-entry-export-schedules enriches rows with friendly user labels", async () => {
  // A schedule with both filters set, one with no filter, and one
  // pointing at a deleted user — three cases the management page must
  // render correctly without depending on the actors picker query.
  const [withFilters] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-list-with-filters`,
      enabled: true,
      cadence: "daily",
      recipients: [`${TAG}@test.local`],
      filterPostedByUserId: posterUserId,
      filterApproverUserId: approverUserId,
      includeLines: false,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  const [withoutFilters] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-list-without-filters`,
      enabled: true,
      cadence: "daily",
      recipients: [`${TAG}@test.local`],
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(withFilters!.id, withoutFilters!.id);

  const res = await fetch(`${baseUrl}/journal-entry-export-schedules`, {
    headers: { Cookie: adminCookie },
  });
  if (res.status !== 200) {
    const txt = await res.text();
    throw new Error(`GET schedules returned ${res.status}: ${txt}`);
  }
  const json = (await res.json()) as {
    schedules: Array<{
      id: number;
      filterPostedByUserId: number | null;
      filterApproverUserId: number | null;
      filterPostedByUserLabel: string | null;
      filterApproverUserLabel: string | null;
    }>;
  };
  const a = json.schedules.find((s) => s.id === withFilters!.id);
  const b = json.schedules.find((s) => s.id === withoutFilters!.id);
  assert.ok(a, "schedule with filters must appear in the list response");
  assert.ok(b, "schedule without filters must appear in the list response");
  assert.equal(
    a!.filterPostedByUserLabel,
    `Posty McPostFace <${TAG}-poster@test.local>`,
  );
  assert.equal(
    a!.filterApproverUserLabel,
    `Apple Prover <${TAG}-approver@test.local>`,
  );
  assert.equal(
    b!.filterPostedByUserLabel,
    null,
    "schedule with no posted-by filter must report a null label, not a placeholder",
  );
  assert.equal(b!.filterApproverUserLabel, null);
});
