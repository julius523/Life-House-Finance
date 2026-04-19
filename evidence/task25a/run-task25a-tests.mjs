#!/usr/bin/env node
/**
 * Task 25A — Idempotency hardening acceptance.
 *
 * Tests POST /api/accounting/journal-entries against:
 *   25A-1  missing key          → 400 IDEMPOTENCY_KEY_REQUIRED
 *   25A-2  malformed key        → 400 IDEMPOTENCY_KEY_INVALID
 *   25A-3  same key + same payload (sequential)  → 200 idempotent, same JE id
 *   25A-4  same key + different payload          → 409 IDEMPOTENCY_CONFLICT
 *   25A-5  parallel identical requests, same key → exactly one JE created
 *   25A-6  parallel identical requests, different keys → two JEs (sanity)
 *   25A-7  evidence_snapshot.idempotency.{key,fingerprint} populated
 */
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.API_BASE ?? "http://localhost:8080";
const results = [];

function log(...a) {
  console.log(...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))));
}
function record(id, desc, ok, evidence) {
  results.push({ id, desc, pass: !!ok, evidence: evidence ?? null });
  log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${desc}`, evidence ?? {});
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} → ${r.status} ${await r.text()}`);
  return { cookie: r.headers.get("set-cookie").split(";")[0] };
}

async function post(s, body, headers = {}) {
  const r = await fetch(`${BASE}/api/accounting/journal-entries`, {
    method: "POST",
    headers: { Cookie: s.cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let data = null;
  const text = await r.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: r.status, data };
}

function buildPayload({ memo, amount } = {}) {
  return {
    entryDate: "2026-04-15",
    memo: memo ?? "T25A — idempotency probe",
    lines: [
      { type: "debit", amount: amount ?? 12.34, account_code: "1000" },
      { type: "credit", amount: amount ?? 12.34, account_code: "4000" },
    ],
  };
}

(async () => {
  log("---", "Task 25A — Idempotency hardening acceptance");

  const admin = await login("kai@lifehousereentry.com", "StepSevenTest!2026");

  // ------------------------------------------------------------------
  // 25A-1 missing key
  const noKey = await post(admin, buildPayload());
  record(
    "25A-1",
    "Missing Idempotency-Key header → 400 IDEMPOTENCY_KEY_REQUIRED",
    noKey.status === 400 && noKey.data?.code === "IDEMPOTENCY_KEY_REQUIRED",
    { status: noKey.status, code: noKey.data?.code },
  );

  // ------------------------------------------------------------------
  // 25A-2 malformed key
  const badKey = await post(admin, buildPayload(), { "Idempotency-Key": "not-a-uuid" });
  record(
    "25A-2",
    "Non-UUID Idempotency-Key → 400 IDEMPOTENCY_KEY_INVALID",
    badKey.status === 400 && badKey.data?.code === "IDEMPOTENCY_KEY_INVALID",
    { status: badKey.status, code: badKey.data?.code },
  );

  // ------------------------------------------------------------------
  // 25A-3 same key + same payload (sequential replay)
  const key3 = randomUUID();
  const body3 = buildPayload({ memo: `T25A-3 same-key replay ${key3}` });
  const first = await post(admin, body3, { "Idempotency-Key": key3 });
  const replay = await post(admin, body3, { "Idempotency-Key": key3 });
  record(
    "25A-3",
    "Same key + same payload → second request 200 idempotent, same JE id, no duplicate",
    first.status === 201 &&
      first.data?.idempotent === false &&
      replay.status === 200 &&
      replay.data?.idempotent === true &&
      replay.data?.journalEntry?.id === first.data?.journalEntry?.id,
    {
      first: { status: first.status, idempotent: first.data?.idempotent, jeId: first.data?.journalEntry?.id },
      replay: { status: replay.status, idempotent: replay.data?.idempotent, jeId: replay.data?.journalEntry?.id },
    },
  );

  // Verify list shows exactly ONE JE for this memo (no duplicate row).
  const listForKey3 = await fetch(`${BASE}/api/accounting/journal-entries?status=posted&limit=500`, {
    headers: { Cookie: admin.cookie },
  }).then((r) => r.json());
  const matchesK3 = (listForKey3.entries ?? []).filter((e) => e.memo === body3.memo);
  record(
    "25A-3-no-dup",
    "Replay must NOT create a second JE row for the same memo",
    matchesK3.length === 1,
    { matchCount: matchesK3.length, memo: body3.memo },
  );

  // ------------------------------------------------------------------
  // 25A-4 same key + different payload → 409
  const key4 = randomUUID();
  const bodyA = buildPayload({ memo: `T25A-4 first payload ${key4}`, amount: 10.0 });
  const bodyB = buildPayload({ memo: `T25A-4 DIFFERENT payload ${key4}`, amount: 99.99 });
  const okA = await post(admin, bodyA, { "Idempotency-Key": key4 });
  const conflictB = await post(admin, bodyB, { "Idempotency-Key": key4 });
  record(
    "25A-4",
    "Same key + different payload → 409 IDEMPOTENCY_CONFLICT and no second JE created",
    okA.status === 201 &&
      conflictB.status === 409 &&
      conflictB.data?.code === "IDEMPOTENCY_CONFLICT" &&
      conflictB.data?.existingJournalEntryId === okA.data?.journalEntry?.id,
    {
      first: { status: okA.status, jeId: okA.data?.journalEntry?.id },
      conflict: {
        status: conflictB.status,
        code: conflictB.data?.code,
        existingJeId: conflictB.data?.existingJournalEntryId,
      },
    },
  );
  // Confirm no JE was posted for bodyB
  const listAfter4 = await fetch(`${BASE}/api/accounting/journal-entries?status=posted&limit=500`, {
    headers: { Cookie: admin.cookie },
  }).then((r) => r.json());
  const dupForB = (listAfter4.entries ?? []).filter((e) => e.memo === bodyB.memo);
  record(
    "25A-4-no-leak",
    "Conflicted second payload must NOT create a JE",
    dupForB.length === 0,
    { foundForBMemo: dupForB.length },
  );

  // ------------------------------------------------------------------
  // 25A-5 parallel identical requests with same key → exactly one JE
  const key5 = randomUUID();
  const body5 = buildPayload({ memo: `T25A-5 parallel race ${key5}`, amount: 5.55 });
  const PARALLEL = 8;
  const parallelResponses = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      post(admin, body5, { "Idempotency-Key": key5 }),
    ),
  );
  const okOnes = parallelResponses.filter((r) => r.status === 201);
  const replayOnes = parallelResponses.filter((r) => r.status === 200);
  const jeIds = new Set(parallelResponses.map((r) => r.data?.journalEntry?.id).filter(Boolean));
  const listAfter5 = await fetch(`${BASE}/api/accounting/journal-entries?status=posted&limit=500`, {
    headers: { Cookie: admin.cookie },
  }).then((r) => r.json());
  const matches5 = (listAfter5.entries ?? []).filter((e) => e.memo === body5.memo);
  record(
    "25A-5",
    `${PARALLEL} parallel identical requests with same key → exactly one JE, all responses converge on same id`,
    okOnes.length === 1 &&
      replayOnes.length === PARALLEL - 1 &&
      jeIds.size === 1 &&
      matches5.length === 1,
    {
      parallel: PARALLEL,
      created201: okOnes.length,
      replay200: replayOnes.length,
      distinctJeIds: jeIds.size,
      jeRowsForMemo: matches5.length,
      statusBreakdown: parallelResponses.map((r) => r.status),
    },
  );

  // ------------------------------------------------------------------
  // 25A-6 sanity: parallel with DIFFERENT keys still posts 2 distinct JEs
  const body6 = buildPayload({ memo: `T25A-6 distinct keys ${randomUUID()}`, amount: 7.77 });
  const [r6a, r6b] = await Promise.all([
    post(admin, body6, { "Idempotency-Key": randomUUID() }),
    post(admin, body6, { "Idempotency-Key": randomUUID() }),
  ]);
  record(
    "25A-6",
    "Sanity: same payload, DIFFERENT keys → two distinct JEs (idempotency is keyed on the header, not on payload alone)",
    r6a.status === 201 &&
      r6b.status === 201 &&
      r6a.data?.journalEntry?.id !== r6b.data?.journalEntry?.id,
    { idA: r6a.data?.journalEntry?.id, idB: r6b.data?.journalEntry?.id },
  );

  // ------------------------------------------------------------------
  // 25A-7 evidence_snapshot.idempotency populated
  const detail = await fetch(
    `${BASE}/api/accounting/journal-entries/${first.data?.journalEntry?.id}`,
    { headers: { Cookie: admin.cookie } },
  ).then((r) => r.json());
  const idemp = detail?.journalEntry?.evidenceSnapshot?.idempotency;
  record(
    "25A-7",
    "evidence_snapshot.idempotency.{key,fingerprint} present and key matches the original request",
    !!idemp &&
      idemp.key === key3 &&
      typeof idemp.fingerprint === "string" &&
      idemp.fingerprint.length === 64,
    { storedKey: idemp?.key, fingerprintLen: idemp?.fingerprint?.length ?? 0 },
  );

  // ------------------------------------------------------------------
  const passes = results.filter((r) => r.pass).length;
  const failures = results.filter((r) => !r.pass);
  log("--- Task 25A summary:", {
    total: results.length,
    passes,
    failures: failures.length,
    failed: failures.map((f) => f.id),
  });
  const dir = path.resolve("evidence/task25a");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task25a-summary.json"), JSON.stringify({ results, passes, total: results.length }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
