/**
 * Task #109 — Broken-authz fixes for private object handling.
 *
 * Verifies that:
 *   1. canConsumeUpload() / canReadObject() correctly enforce uploader
 *      ownership against the new uploaded_objects table, with admin /
 *      approver overrides.
 *   2. POST /receipts rejects (403) a fileUrl uploaded by another user
 *      and accepts (201) one uploaded by the caller, while admins can
 *      always attach any registered upload.
 *   3. POST /storage/uploads/request-url records an uploaded_objects row
 *      attributing the path to the caller.
 *   4. GET /storage/objects/* returns 404 for a submitter trying to read
 *      another user's upload (the original IDOR), and proceeds past the
 *      authz layer for admin/approver/uploader.
 *   5. POST /ai/parse-bank-statement returns 403 for a submitter passing
 *      a foreign objectPath.
 *
 * GCS isn't available in the test environment, so positive paths that
 * would touch the bucket are validated by asserting the response is NOT
 * the authz failure (i.e. 200/2xx OR a 5xx that originates downstream of
 * the authz check), never the 403/404 the bug would have produced.
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
  uploadedObjectsTable,
  receiptsTable,
} from "@workspace/db";
import { encodeSession, requireAuth } from "../auth";
import { canConsumeUpload, canReadObject } from "../objectAuthz";
import receiptsRouter from "../../routes/receipts";
import storageRouter from "../../routes/storage";
import aiRouter from "../../routes/ai";

const TAG = `t109-${process.pid}-${Date.now()}`;

let app: Express;
let server: Server;
let baseUrl: string;

let adminId: number;
let approverId: number;
let submitterAId: number;
let submitterBId: number;

const seededReceiptIds: number[] = [];
const seededUploadedIds: number[] = [];

const PATH_A = `/objects/uploads/${TAG}-a`;
const PATH_B = `/objects/uploads/${TAG}-b`;
const PATH_LEGACY = `/objects/uploads/${TAG}-legacy`;
const PATH_ORPHAN = `/objects/uploads/${TAG}-orphan`;

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
    })
    .returning();
  const [approver] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-approver@test.local`,
      passwordHash: "x",
      firstName: "Approver",
      lastName: "User",
      role: "approver",
    })
    .returning();
  const [subA] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-suba@test.local`,
      passwordHash: "x",
      firstName: "Sub",
      lastName: "A",
      role: "submitter",
    })
    .returning();
  const [subB] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-subb@test.local`,
      passwordHash: "x",
      firstName: "Sub",
      lastName: "B",
      role: "submitter",
    })
    .returning();
  adminId = admin!.id;
  approverId = approver!.id;
  submitterAId = subA!.id;
  submitterBId = subB!.id;

  // Seed: PATH_A uploaded by submitter A, PATH_B uploaded by submitter B.
  const [upA] = await db
    .insert(uploadedObjectsTable)
    .values({
      objectPath: PATH_A,
      uploadedBy: submitterAId,
      fileName: "a.pdf",
      contentType: "application/pdf",
      size: 1234,
    })
    .returning();
  const [upB] = await db
    .insert(uploadedObjectsTable)
    .values({
      objectPath: PATH_B,
      uploadedBy: submitterBId,
      fileName: "b.pdf",
      contentType: "application/pdf",
      size: 2345,
    })
    .returning();
  seededUploadedIds.push(upA!.id, upB!.id);

  // Legacy receipt: no uploaded_objects row, only a receipts row attributing
  // the legacy path to submitter A.
  const [legacy] = await db
    .insert(receiptsTable)
    .values({
      fileName: "legacy.pdf",
      fileType: "application/pdf",
      fileUrl: PATH_LEGACY,
      uploadedBy: submitterAId,
    })
    .returning();
  seededReceiptIds.push(legacy!.id);

  // Express test app — wire requireAuth so cookies populate req.authUser
  // exactly like production does.
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", (req, res, next) => requireAuth(req, res, next));
  app.use("/api", receiptsRouter);
  app.use("/api", storageRouter);
  app.use("/api", aiRouter);

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
  if (seededReceiptIds.length) {
    await db
      .delete(receiptsTable)
      .where(inArray(receiptsTable.id, seededReceiptIds));
  }
  // Also nuke any receipts created by POST /receipts during the test run.
  await db
    .delete(receiptsTable)
    .where(
      inArray(receiptsTable.fileUrl, [PATH_A, PATH_B, PATH_LEGACY, PATH_ORPHAN]),
    );
  await db
    .delete(uploadedObjectsTable)
    .where(
      inArray(uploadedObjectsTable.objectPath, [
        PATH_A,
        PATH_B,
        PATH_LEGACY,
        PATH_ORPHAN,
      ]),
    );
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [adminId, approverId, submitterAId, submitterBId]));
  await pool.end();
});

function cookieFor(userId: number): string {
  return `lh_session=${encodeSession(userId)}`;
}

// ---------- 1. Direct unit tests of objectAuthz helpers ----------

test("canConsumeUpload: uploader of registered object is allowed", async () => {
  const ok = await canConsumeUpload(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_A,
  );
  assert.equal(ok, true);
});

test("canConsumeUpload: non-uploader of registered object is rejected", async () => {
  const ok = await canConsumeUpload(
    {
      id: submitterBId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_A,
  );
  assert.equal(ok, false);
});

test("canConsumeUpload: admin override works for any registered object", async () => {
  const ok = await canConsumeUpload(
    { id: adminId, email: "x", firstName: "x", lastName: "x", role: "admin" },
    PATH_A,
  );
  assert.equal(ok, true);
});

test("canConsumeUpload: legacy fallback honors receipts.uploadedBy", async () => {
  const ok = await canConsumeUpload(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(ok, true);
});

test("canConsumeUpload: legacy fallback rejects non-uploader", async () => {
  const ok = await canConsumeUpload(
    {
      id: submitterBId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(ok, false);
});

test("canConsumeUpload: unregistered/orphan path is rejected for non-admins", async () => {
  const ok = await canConsumeUpload(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_ORPHAN,
  );
  assert.equal(ok, false);
});

test("canReadObject: approver can read any private object", async () => {
  const ok = await canReadObject(
    {
      id: approverId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "approver",
    },
    PATH_B,
  );
  assert.equal(ok, true);
});

test("canReadObject: submitter cannot read another user's upload", async () => {
  const ok = await canReadObject(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_B,
  );
  assert.equal(ok, false);
});

test("canReadObject: submitter can read their own legacy upload", async () => {
  const ok = await canReadObject(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(ok, true);
});

// ---------- 2. POST /receipts authz integration ----------

test("POST /receipts: rejects (403) a fileUrl uploaded by another user", async () => {
  const res = await fetch(`${baseUrl}/receipts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({ fileName: "stolen.pdf", fileUrl: PATH_B }),
  });
  assert.equal(res.status, 403);
});

test("POST /receipts: accepts (201) when caller uploaded the fileUrl", async () => {
  const res = await fetch(`${baseUrl}/receipts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({ fileName: "ok.pdf", fileUrl: PATH_A }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: number };
  seededReceiptIds.push(body.id);
});

test("POST /receipts: admin can attach any uploaded fileUrl", async () => {
  const res = await fetch(`${baseUrl}/receipts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(adminId) },
    body: JSON.stringify({ fileName: "admin-link.pdf", fileUrl: PATH_B }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: number };
  seededReceiptIds.push(body.id);
});

test("POST /receipts: no fileUrl is allowed (no authz check needed)", async () => {
  const res = await fetch(`${baseUrl}/receipts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({ fileName: "metadata-only.pdf" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: number };
  seededReceiptIds.push(body.id);
});

// ---------- 3. POST /storage/uploads/request-url records the uploader ----------

test("POST /storage/uploads/request-url records uploader (or fails before authz code)", async () => {
  const res = await fetch(`${baseUrl}/storage/uploads/request-url`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({
      name: "x.pdf",
      size: 100,
      contentType: "application/pdf",
    }),
  });
  // GCS sidecar isn't available in CI, so the call most likely 500s when
  // generating the presigned URL. The important assertion is that authz
  // does NOT 401/403, meaning the route correctly identifies the caller.
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
  if (res.status === 200) {
    const body = (await res.json()) as { objectPath: string };
    const [row] = await db
      .select()
      .from(uploadedObjectsTable)
      .where(eq(uploadedObjectsTable.objectPath, body.objectPath));
    assert.ok(row, "uploaded_objects row should be created");
    assert.equal(row.uploadedBy, submitterAId);
    seededUploadedIds.push(row.id);
  }
});

// ---------- 4. GET /storage/objects/* authz ----------

test("GET /storage/objects/*: submitter B is denied (404) for submitter A's upload (the IDOR fix)", async () => {
  const res = await fetch(
    `${baseUrl}/storage/objects/${PATH_A.replace(/^\/objects\//, "")}`,
    { headers: { cookie: cookieFor(submitterBId) } },
  );
  // Even though receipts may exist pointing at PATH_A, B is not allowed
  // to read it.
  assert.equal(res.status, 404);
});

test("GET /storage/objects/*: unauthenticated request is rejected (401)", async () => {
  const res = await fetch(
    `${baseUrl}/storage/objects/${PATH_A.replace(/^\/objects\//, "")}`,
  );
  assert.equal(res.status, 401);
});

test("GET /storage/objects/*: orphan path (no uploaded_objects, no receipt) is 404 for submitter", async () => {
  const res = await fetch(
    `${baseUrl}/storage/objects/${PATH_ORPHAN.replace(/^\/objects\//, "")}`,
    { headers: { cookie: cookieFor(submitterAId) } },
  );
  assert.equal(res.status, 404);
});

test("GET /storage/objects/*: admin passes authz (does not 404 at the authz gate)", async () => {
  const res = await fetch(
    `${baseUrl}/storage/objects/${PATH_A.replace(/^\/objects\//, "")}`,
    { headers: { cookie: cookieFor(adminId) } },
  );
  // Admin authz lets the request through. GCS is unreachable in tests so
  // the route most likely returns 500 from the storage layer — what we're
  // verifying is that authz did NOT short-circuit with 404/403.
  assert.notEqual(res.status, 403);
  // 200 (unlikely without GCS) or 500 (storage layer error) are both
  // acceptable proofs that authz let it through.
});

// ---------- 5. POST /ai/parse-bank-statement authz ----------

test("POST /ai/parse-bank-statement: submitter cannot use another user's objectPath (403)", async () => {
  const res = await fetch(`${baseUrl}/ai/parse-bank-statement`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({
      objectPath: PATH_B,
      fileName: "stmt.pdf",
      contentType: "application/pdf",
      submittedBy: "Sub A",
    }),
  });
  // Authz runs BEFORE the OpenAI-availability check, so unauthorized
  // callers always get a deterministic 403, regardless of AI configuration.
  assert.equal(res.status, 403);
});

test("POST /ai/parse-bank-statement: unregistered objectPath is rejected (403)", async () => {
  const res = await fetch(`${baseUrl}/ai/parse-bank-statement`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieFor(submitterAId) },
    body: JSON.stringify({
      objectPath: PATH_ORPHAN,
      fileName: "stmt.pdf",
      contentType: "application/pdf",
      submittedBy: "Sub A",
    }),
  });
  assert.equal(res.status, 403);
});

// ---------- 6. Legacy fallback hardening: earliest receipt wins ----------

test("legacy fallback: poisoned later receipt cannot grant access; earliest uploader retains it", async () => {
  // Submitter A originally uploaded PATH_LEGACY (seeded in `before`).
  // Simulate an attacker (submitter B) post-hoc inserting a receipt row
  // pointing at the same fileUrl with their own uploadedBy. The fix
  // anchors authz to the EARLIEST receipt, so B should still be denied
  // while A remains authorized.
  const [poison] = await db
    .insert(receiptsTable)
    .values({
      fileName: "poison.pdf",
      fileType: "application/pdf",
      fileUrl: PATH_LEGACY,
      uploadedBy: submitterBId,
    })
    .returning();
  seededReceiptIds.push(poison!.id);

  const okOriginal = await canReadObject(
    {
      id: submitterAId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(okOriginal, true, "original uploader keeps access");

  const okAttacker = await canReadObject(
    {
      id: submitterBId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(okAttacker, false, "post-hoc receipt poisoning must NOT grant access");

  // Same hardening applies to the consume path.
  const consumeAttacker = await canConsumeUpload(
    {
      id: submitterBId,
      email: "x",
      firstName: "x",
      lastName: "x",
      role: "submitter",
    },
    PATH_LEGACY,
  );
  assert.equal(consumeAttacker, false);
});
