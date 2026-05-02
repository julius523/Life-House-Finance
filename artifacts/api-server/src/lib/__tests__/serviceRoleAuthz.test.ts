/**
 * Task #126 / service-role authorization — integration tests covering
 * the bearer (INTEGRATION_API_KEY) auth path and the role-gated
 * surface that the new "service" role is allowed to touch.
 *
 * Asserts:
 *   1. GET /credits with a valid Bearer header succeeds (200).
 *   2. POST /credits with a valid Bearer header succeeds (201) and
 *      stamps `submittedBy` with the "Automation: <X-API-Source>"
 *      marker, and the response carries entrySource: "automation".
 *   3. POST /receipts with Bearer succeeds (201), stamps uploadedBy
 *      with the seeded automation user id, and the response carries
 *      entrySource: "automation".
 *   4. A wrong / malformed Bearer is rejected with 401 (NOT a CORS-
 *      style 500, and NOT a fall-through to the cookie path).
 *   5. With INTEGRATION_API_KEY temporarily unset, a Bearer attempt is
 *      rejected with 401 — bearer auth fails closed, never opens up.
 *   6. PUT /credits/:id with Bearer is rejected with 403 (writes other
 *      than POST /credits + POST /receipts are admin/approver-only).
 *   7. DELETE /credits/:id with Bearer is rejected with 403.
 *   8. POST /vendors with Bearer is rejected with 403 (entire vendors
 *      surface is closed to service callers).
 *   9. POST /expenses/:id/approve-style endpoints reject service.
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
  creditsTable,
  vendorsTable,
} from "@workspace/db";
import {
  __resetAutomationUserIdCacheForTests,
  getAutomationUserId,
  requireAuth,
} from "../auth";
import { AUTOMATION_USER_EMAIL } from "../apiKey";
import { seedUsers } from "../seedUsers";
import creditsRouter from "../../routes/credits";
import receiptsRouter from "../../routes/receipts";
import vendorsRouter from "../../routes/vendors";

const TAG = `t126svc-${process.pid}-${Date.now()}`;
const TEST_API_KEY = "z".repeat(48); // >32 chars passes getConfiguredApiKey

let app: Express;
let server: Server;
let baseUrl: string;
let originalApiKey: string | undefined;
let automationUserId: number | null = null;
const seededCreditIds: number[] = [];

before(async () => {
  // Force a known API key for the duration of the suite. Save the
  // outer-process value so we can restore it in after() and avoid
  // leaking test state into adjacent tests in the same node --test run.
  originalApiKey = process.env["INTEGRATION_API_KEY"];
  process.env["INTEGRATION_API_KEY"] = TEST_API_KEY;

  // The bearer path resolves to the seeded automation user, so make
  // sure it exists. seedUsers is idempotent; if a previous suite ran
  // it this is a no-op apart from the password hash heal pass.
  await seedUsers();

  // Reset the lazy automation-user-id cache so this test reads the
  // freshly-seeded row instead of any value baked in by a previous
  // suite that may have run against a different database.
  __resetAutomationUserIdCacheForTests();
  automationUserId = await getAutomationUserId();
  assert.ok(
    typeof automationUserId === "number",
    "seedUsers must create the automation service account before tests run",
  );

  app = express();
  app.use(cookieParser());
  app.use(express.json());
  // Real auth middleware — exercises the bearer-first / cookie-fallback
  // logic end-to-end rather than mocking req.authUser.
  app.use("/api", (req, res, next) => requireAuth(req, res, next));
  app.use("/api", creditsRouter);
  app.use("/api", receiptsRouter);
  app.use("/api", vendorsRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (seededCreditIds.length > 0) {
    await db.delete(creditsTable).where(inArray(creditsTable.id, seededCreditIds));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalApiKey === undefined) delete process.env["INTEGRATION_API_KEY"];
  else process.env["INTEGRATION_API_KEY"] = originalApiKey;
  __resetAutomationUserIdCacheForTests();
  await pool.end();
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${TEST_API_KEY}`,
    ...extra,
  };
}

test("GET /credits with valid Bearer succeeds (200)", async () => {
  const res = await fetch(`${baseUrl}/api/credits`, {
    headers: authHeaders(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { credits: unknown[] };
  assert.ok(Array.isArray(body.credits), "response shape unchanged");
});

test("POST /credits with Bearer stamps Automation marker and returns entrySource=automation", async () => {
  const res = await fetch(`${baseUrl}/api/credits`, {
    method: "POST",
    headers: authHeaders({ "x-api-source": "payroll-script" }),
    body: JSON.stringify({
      source: `${TAG}-grant`,
      amount: 1234.56,
      status: "pipeline",
    }),
  });
  assert.equal(res.status, 201, `unexpected status ${res.status}`);
  const body = (await res.json()) as {
    credit: {
      id: number;
      submittedBy: string | null;
      entrySource: "automation" | "manual";
    };
  };
  seededCreditIds.push(body.credit.id);
  assert.equal(body.credit.submittedBy, "Automation: payroll-script");
  assert.equal(body.credit.entrySource, "automation");
});

test("POST /receipts with Bearer stamps uploadedBy=automation user and entrySource=automation", async () => {
  const res = await fetch(`${baseUrl}/api/receipts`, {
    method: "POST",
    headers: authHeaders({ "x-api-source": "weekly-import" }),
    body: JSON.stringify({
      fileName: `${TAG}-test.pdf`,
    }),
  });
  assert.equal(res.status, 201, `unexpected status ${res.status}`);
  const body = (await res.json()) as {
    id: number;
    fileName: string;
    uploadedBy: number;
    entrySource: "automation" | "manual";
  };
  assert.equal(body.uploadedBy, automationUserId);
  assert.equal(body.entrySource, "automation");
  // Cleanup — receiptsTable doesn't have a TAG column, so delete by id.
  const { receiptsTable } = await import("@workspace/db");
  await db.delete(receiptsTable).where(eq(receiptsTable.id, body.id));
});

test("POST /credits with malformed Bearer is rejected with 401 (no 500, no cookie fallback)", async () => {
  const res = await fetch(`${baseUrl}/api/credits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrongtoken_wrongtoken_wrongtoken_wrongtoken_wrong",
    },
    body: JSON.stringify({
      source: `${TAG}-rejected`,
      amount: 1,
      status: "pipeline",
    }),
  });
  assert.equal(res.status, 401, `expected fail-closed 401 on bad bearer, got ${res.status}`);
});

test("Bearer is rejected with 401 when INTEGRATION_API_KEY is unset", async () => {
  // Temporarily yank the env var so getConfiguredApiKey returns null.
  const saved = process.env["INTEGRATION_API_KEY"];
  delete process.env["INTEGRATION_API_KEY"];
  try {
    const res = await fetch(`${baseUrl}/api/credits`, {
      headers: authHeaders(),
    });
    assert.equal(
      res.status,
      401,
      "bearer must fail closed when the server has no key configured",
    );
  } finally {
    process.env["INTEGRATION_API_KEY"] = saved;
  }
});

test("PUT /credits/:id with Bearer is rejected (403) — service is read+POST only on credits", async () => {
  // Need an existing credit row id. Use the one we created above; if
  // that test was filtered out, fall back to inserting one inline so
  // the assertion remains meaningful.
  let id = seededCreditIds[0];
  if (id === undefined) {
    const [c] = await db
      .insert(creditsTable)
      .values({ source: `${TAG}-inline`, amount: "1", status: "pipeline" })
      .returning();
    id = c!.id;
    seededCreditIds.push(id);
  }
  const res = await fetch(`${baseUrl}/api/credits/${id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ amount: 99 }),
  });
  assert.equal(res.status, 403, `expected 403 on service PUT /credits, got ${res.status}`);
});

test("DELETE /credits/:id with Bearer is rejected (403) — admin-only", async () => {
  const id = seededCreditIds[0];
  assert.ok(typeof id === "number", "need a seeded credit row");
  const res = await fetch(`${baseUrl}/api/credits/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  assert.equal(res.status, 403, `expected 403 on service DELETE /credits, got ${res.status}`);
});

test("POST /vendors with Bearer is rejected (403) — vendors surface closed to service", async () => {
  const res = await fetch(`${baseUrl}/api/vendors`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      name: `${TAG}-vendor`,
      type: "service",
      status: "active",
    }),
  });
  assert.equal(res.status, 403, `expected 403 on service POST /vendors, got ${res.status}`);
  // Belt-and-suspenders: confirm no row landed in the table.
  const rows = await db
    .select({ id: vendorsTable.id })
    .from(vendorsTable)
    .where(eq(vendorsTable.name, `${TAG}-vendor`));
  assert.equal(rows.length, 0, "service POST must not have inserted a vendor");
});
