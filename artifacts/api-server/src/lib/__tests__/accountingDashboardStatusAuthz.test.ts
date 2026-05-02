/**
 * Task #126 — Accounting Dashboard-Status Authorization Regression
 *
 * Verifies that GET /accounting/dashboard-status enforces the
 * admin/approver boundary introduced in Task #126:
 *
 *   - Submitters receive 403 (not the org-wide accounting metadata).
 *   - Unauthenticated requests receive 401.
 *   - Admin and approver receive 200 with the expected shape.
 *
 * The test spins up a real Express server backed by the live database so
 * the full middleware stack (requireAuth → requireAdminOrApprover) runs
 * identically to production. No mocks are used for the auth layer.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "node:http";
import { inArray } from "drizzle-orm";

import { db, pool, usersTable } from "@workspace/db";
import { encodeSession } from "../auth";
import coaRouter from "../../routes/coa";

const TAG = `t126-${process.pid}-${Date.now()}`;

let app: Express;
let server: Server;
let baseUrl: string;

let adminId: number;
let approverId: number;
let submitterId: number;

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "Admin",
      lastName: "T126",
      role: "admin",
    })
    .returning();
  const [approver] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-approver@test.local`,
      passwordHash: "x",
      firstName: "Approver",
      lastName: "T126",
      role: "approver",
    })
    .returning();
  const [submitter] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-submitter@test.local`,
      passwordHash: "x",
      firstName: "Submitter",
      lastName: "T126",
      role: "submitter",
    })
    .returning();

  adminId = admin!.id;
  approverId = approver!.id;
  submitterId = submitter!.id;

  app = express();
  app.use(cookieParser());
  app.use(express.json());

  const noop = (): void => undefined;
  const stubLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  } as unknown as Express["request"]["log"];
  app.use("/api", (req, _res, next) => {
    if (!req.log) (req as { log: typeof stubLogger }).log = stubLogger;
    next();
  });

  app.use("/api", coaRouter);

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
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [adminId, approverId, submitterId]));
  await pool.end();
});

function cookieFor(userId: number): string {
  return `lh_session=${encodeSession(userId)}`;
}

// ---------------------------------------------------------------------------
// 1. Submitter must be denied (403).
// ---------------------------------------------------------------------------

test("GET /accounting/dashboard-status: submitter receives 403", async () => {
  const res = await fetch(`${baseUrl}/accounting/dashboard-status`, {
    headers: { cookie: cookieFor(submitterId) },
  });
  assert.equal(
    res.status,
    403,
    `Expected 403 for submitter but got ${res.status}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Unauthenticated requests must be denied (401).
// ---------------------------------------------------------------------------

test("GET /accounting/dashboard-status: unauthenticated receives 401", async () => {
  const res = await fetch(`${baseUrl}/accounting/dashboard-status`);
  assert.equal(
    res.status,
    401,
    `Expected 401 for unauthenticated but got ${res.status}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Admin and approver must receive 200 with the expected payload shape.
// ---------------------------------------------------------------------------

for (const [label, getId] of [
  ["admin", () => adminId],
  ["approver", () => approverId],
] as const) {
  test(`GET /accounting/dashboard-status: ${label} receives 200 with expected shape`, async () => {
    const res = await fetch(`${baseUrl}/accounting/dashboard-status`, {
      headers: { cookie: cookieFor(getId()) },
    });
    assert.equal(
      res.status,
      200,
      `Expected 200 for ${label} but got ${res.status}`,
    );
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(
      "openPeriod" in body,
      "Response missing 'openPeriod' field",
    );
    assert.ok(
      "unpostedDrafts" in body,
      "Response missing 'unpostedDrafts' field",
    );
    assert.ok(
      "trialBalanceStatus" in body,
      "Response missing 'trialBalanceStatus' field",
    );
    assert.ok(
      "lastClosedPeriod" in body,
      "Response missing 'lastClosedPeriod' field",
    );
  });
}
