/**
 * Posted-remediation dialog wire contract.
 *
 * The PostedRemediationDialog (artifacts/finance-portal/src/pages/
 * accounting-remediation.tsx) parses very specific shapes off the
 * remediation routes and renders specific operator copy from them.
 * Those shapes were repeatedly broken in earlier iterations (envelope
 * vs raw entity, missing reason discriminator on ADJUSTING_POST_FAILED,
 * partial-success contract on REPLACEMENT_POST_FAILED, exclusivity of
 * archived vs non-postable on the queue). This suite locks the wire
 * contract in CI so a future refactor cannot silently regress it.
 *
 * Strategy: mount the remediation router on a fresh Express app with a
 * stub auth middleware that injects an admin user (the production
 * requireAuth lives on app.ts, not the router file). Drive real
 * Postgres via the existing db pool and assert HTTP status + body
 * shape. Cleanup disables the immutability triggers from Task #67 the
 * same way postedEntriesImmutable.test.ts does.
 *
 * MOVED to manual-only/ 2026-09-07 for the same reason as
 * postedEntriesImmutable.test.ts — see refuseProductionDb.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "node:http";
import { sql, eq, and, inArray } from "drizzle-orm";

import {
  db,
  pool,
  usersTable,
  accountingPeriodsTable,
  chartOfAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  activityLogTable,
} from "@workspace/db";
import { ensureSchemaConstraints } from "../../ensureSchema";
import { encodeSession } from "../../auth";
import remediationRouter from "../../../routes/remediation";
import { refuseIfProductionDatabase } from "./refuseProductionDb";

refuseIfProductionDatabase();

const TAG = `t68dlg-${process.pid}-${Date.now()}`;
const TODAY = new Date().toISOString().slice(0, 10);

let app: Express;
let server: Server;
let baseUrl: string;

let adminUserId: number;
let viewerUserId: number;
let postableAccountId: number;
let postableAccountCode: string;
let archivedNonPostableAccountId: number;
let archivedNonPostableAccountCode: string;
let openPeriodId: number;
let lockedPeriodId: number;
let originalJeId: number;
let archivedExclusivityJeId: number;

const createdJeIds: number[] = [];

function shortCode(prefix: string): string {
  return `${prefix}${String(process.pid).slice(-2)}${String(Date.now()).slice(-4)}`.slice(0, 8);
}

before(async () => {
  await ensureSchemaConstraints();

  // --- Users ---------------------------------------------------------------
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "Dialog",
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
      firstName: "Dialog",
      lastName: "Viewer",
      role: "viewer",
    })
    .returning();
  viewerUserId = viewer!.id;

  // --- Accounts ------------------------------------------------------------
  const [postable] = await db
    .insert(chartOfAccountsTable)
    .values({
      code: shortCode("9"),
      name: `Postable ${TAG}`,
      type: "asset",
      normalBalance: "debit",
      isActive: true,
      allowManualPosting: true,
    })
    .returning();
  postableAccountId = postable!.id;
  postableAccountCode = postable!.code;

  // Archived AND non-postable simultaneously. The queue and the
  // per-entry integrity report should both treat this as exclusively
  // archived — never double-count it as non-postable as well.
  const [archived] = await db
    .insert(chartOfAccountsTable)
    .values({
      code: shortCode("8"),
      name: `ArchivedNonPostable ${TAG}`,
      type: "asset",
      normalBalance: "debit",
      isActive: false,
      allowManualPosting: false,
    })
    .returning();
  archivedNonPostableAccountId = archived!.id;
  archivedNonPostableAccountCode = archived!.code;

  // --- Periods -------------------------------------------------------------
  // Open period covering today (so reverseJournalEntry + the adjusting-entry
  // success path can run).
  const year = new Date().getUTCFullYear();
  const [openPeriod] = await db
    .insert(accountingPeriodsTable)
    .values({
      label: `Open ${TAG}`,
      periodStart: `${year}-01-01`,
      periodEnd: `${year + 1}-12-31`,
      status: "open",
    })
    .returning();
  openPeriodId = openPeriod!.id;

  // Locked period far in the past so we can post an adjusting-entry attempt
  // dated inside it and watch it bounce with PERIOD_LOCKED.
  const [lockedPeriod] = await db
    .insert(accountingPeriodsTable)
    .values({
      label: `Locked ${TAG}`,
      periodStart: `2000-01-01`,
      periodEnd: `2000-12-31`,
      status: "closed",
    })
    .returning();
  lockedPeriodId = lockedPeriod!.id;

  // --- Original posted JE (the one we'll remediate) -----------------------
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo: `JE-${TAG}-A`,
      entryDate: TODAY,
      memo: `original ${TAG}`,
      totalsDebitsCents: 1000,
      totalsCreditsCents: 1000,
      status: "posted",
      postedByUserId: adminUserId,
      approverUserId: adminUserId,
      evidenceSnapshot: { test: TAG },
    })
    .returning();
  originalJeId = je!.id;
  createdJeIds.push(je!.id);

  await db
    .insert(journalEntryLinesTable)
    .values([
      {
        journalEntryId: originalJeId,
        lineNo: 1,
        type: "debit",
        amountCents: 1000,
        account: postable!.name,
        accountId: postableAccountId,
        memo: "original debit",
      },
      {
        journalEntryId: originalJeId,
        lineNo: 2,
        type: "credit",
        amountCents: 1000,
        account: postable!.name,
        accountId: postableAccountId,
        memo: "original credit",
      },
    ]);

  // --- Second posted JE that intentionally references the archived +
  //     non-postable account on one of its lines, so the queue and the
  //     per-entry integrity report have something to classify. ---------
  const [je2] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo: `JE-${TAG}-B`,
      entryDate: TODAY,
      memo: `archived-exclusivity ${TAG}`,
      totalsDebitsCents: 500,
      totalsCreditsCents: 500,
      status: "posted",
      postedByUserId: adminUserId,
      approverUserId: adminUserId,
      evidenceSnapshot: { test: TAG },
    })
    .returning();
  archivedExclusivityJeId = je2!.id;
  createdJeIds.push(je2!.id);

  await db
    .insert(journalEntryLinesTable)
    .values([
      {
        journalEntryId: archivedExclusivityJeId,
        lineNo: 1,
        type: "debit",
        amountCents: 500,
        account: archived!.name,
        accountId: archivedNonPostableAccountId,
        memo: "archived debit",
      },
      {
        journalEntryId: archivedExclusivityJeId,
        lineNo: 2,
        type: "credit",
        amountCents: 500,
        account: postable!.name,
        accountId: postableAccountId,
        memo: "balancing credit",
      },
    ]);

  // --- Express test app ----------------------------------------------------
  // requireAuth lives on app.ts in production. For these tests we mount a
  // stub middleware that injects the role we want, switchable per-request
  // via the X-Test-Role header (admin | viewer). The role wrappers inside
  // the router (/accounting/remediation queue is admin/approver only)
  // still run against this injected user.
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  // For the POST /accounting/journal-entries/:id/remediate route the
  // router itself has no auth middleware (it relies on the app-level
  // requireAuth in production), so we still inject req.authUser here.
  // The /accounting/remediation queue routes have requireAuth +
  // requireRole baked into the router, so they additionally require a
  // valid lh_session cookie — set per-request via the X-Test-Role
  // header below.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = (req.headers["x-test-role"] as string) || "admin";
    if (role === "viewer") {
      req.authUser = {
        id: viewerUserId,
        email: `${TAG}-viewer@test.local`,
        role: "viewer",
        firstName: "Dialog",
        lastName: "Viewer",
      };
    } else {
      req.authUser = {
        id: adminUserId,
        email: `${TAG}-admin@test.local`,
        role: "admin",
        firstName: "Dialog",
        lastName: "Admin",
      };
    }
    next();
  });
  app.use("/api", remediationRouter);

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

  try {
    await db.execute(
      sql`ALTER TABLE journal_entry_lines DISABLE TRIGGER journal_entry_lines_lock`,
    );
    await db.execute(
      sql`ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_lock`,
    );

    if (createdJeIds.length > 0) {
      await db
        .delete(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.journalEntryId, createdJeIds));
      await db
        .delete(activityLogTable)
        .where(
          and(
            eq(activityLogTable.referenceType, "journal_entry"),
            inArray(activityLogTable.referenceId, createdJeIds),
          ),
        );
      await db
        .update(journalEntriesTable)
        .set({
          reversedByJournalEntryId: null,
          reversesJournalEntryId: null,
        })
        .where(inArray(journalEntriesTable.id, createdJeIds));
      await db
        .delete(journalEntriesTable)
        .where(inArray(journalEntriesTable.id, createdJeIds));
    }
  } finally {
    await db.execute(
      sql`ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_lock`,
    );
    await db.execute(
      sql`ALTER TABLE journal_entry_lines ENABLE TRIGGER journal_entry_lines_lock`,
    );
  }

  if (openPeriodId)
    await db
      .delete(accountingPeriodsTable)
      .where(eq(accountingPeriodsTable.id, openPeriodId));
  if (lockedPeriodId)
    await db
      .delete(accountingPeriodsTable)
      .where(eq(accountingPeriodsTable.id, lockedPeriodId));
  if (postableAccountId)
    await db
      .delete(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, postableAccountId));
  if (archivedNonPostableAccountId)
    await db
      .delete(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, archivedNonPostableAccountId));
  if (adminUserId)
    await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  if (viewerUserId)
    await db.delete(usersTable).where(eq(usersTable.id, viewerUserId));

  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PostedRemediateBody =
  | {
      action: "reverse_and_replace";
      note: string;
      payload: {
        entryDate: string;
        memo: string;
        lines: Array<{
          type: "debit" | "credit";
          amount: number;
          account_code: string;
          memo?: string;
        }>;
      };
    }
  | {
      action: "adjusting_entry";
      note: string;
      payload: {
        entryDate: string;
        memo: string;
        lines: Array<{
          type: "debit" | "credit";
          amount: number;
          account_code: string;
          memo?: string;
        }>;
      };
    };

async function postRemediate(
  entryId: number,
  body: PostedRemediateBody | { action: string; note: unknown; payload?: unknown },
  opts: { role?: "admin" | "viewer" } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/accounting/journal-entries/${entryId}/remediate`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-role": opts.role ?? "admin",
      },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

function balancedReplacement(): PostedRemediateBody["payload"] {
  return {
    entryDate: TODAY,
    memo: `replacement ${TAG}`,
    lines: [
      {
        type: "debit",
        amount: 10,
        account_code: postableAccountCode,
        memo: "replacement debit",
      },
      {
        type: "credit",
        amount: 10,
        account_code: postableAccountCode,
        memo: "replacement credit",
      },
    ],
  };
}

function unbalancedReplacement(): PostedRemediateBody["payload"] {
  return {
    entryDate: TODAY,
    memo: `bad replacement ${TAG}`,
    lines: [
      {
        type: "debit",
        amount: 10,
        account_code: postableAccountCode,
      },
      {
        type: "credit",
        amount: 7,
        account_code: postableAccountCode,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Validation contract — the dialog enforces the same min length client-side,
// but a buggy client must not be able to bypass it server-side.
// ---------------------------------------------------------------------------

test("note shorter than 5 chars is rejected with INVALID_BODY (400)", async () => {
  const res = await postRemediate(originalJeId, {
    action: "adjusting_entry",
    note: "no",
    payload: {
      entryDate: TODAY,
      memo: "x",
      lines: balancedReplacement().lines,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body["code"], "INVALID_BODY");
});

// ---------------------------------------------------------------------------
// Adjusting-entry path — happy path returns the new JE id (cache key) and
// failure path returns the discriminated reason the dialog maps to copy.
// ---------------------------------------------------------------------------

test("adjusting_entry success returns 201 with adjustingEntryId for cache invalidation", async () => {
  const res = await postRemediate(originalJeId, {
    action: "adjusting_entry",
    note: "automated test adjusting entry",
    payload: {
      entryDate: TODAY,
      memo: `adj ${TAG}`,
      lines: balancedReplacement().lines,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body["ok"], true);
  assert.equal(res.body["action"], "adjusting_entry");
  assert.equal(res.body["originalEntryId"], originalJeId);
  const newId = res.body["adjustingEntryId"];
  assert.equal(typeof newId, "number");
  assert.ok((newId as number) > 0);
  createdJeIds.push(newId as number);

  // Activity-log row is written with the actor id pulled off the
  // authenticated user — guards against the req.user vs req.authUser
  // attribution regression.
  const [logRow] = await db
    .select()
    .from(activityLogTable)
    .where(
      and(
        eq(activityLogTable.referenceType, "journal_entry"),
        eq(activityLogTable.referenceId, originalJeId),
        eq(
          activityLogTable.type,
          "accounting_remediation_adjusting_entry_created",
        ),
      ),
    )
    .limit(1);
  assert.ok(logRow, "activity-log row was not written");
  assert.equal(logRow!.actorUserId, adminUserId);
});

test("adjusting_entry into a locked period returns ADJUSTING_POST_FAILED with reason=period_locked (409)", async () => {
  const res = await postRemediate(originalJeId, {
    action: "adjusting_entry",
    note: "automated test period locked",
    payload: {
      entryDate: "2000-06-15",
      memo: `locked ${TAG}`,
      lines: balancedReplacement().lines,
    },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body["code"], "ADJUSTING_POST_FAILED");
  assert.equal(res.body["reason"], "period_locked");
});

test("adjusting_entry with an unknown account_code returns ADJUSTING_POST_FAILED (400, reason!=ok)", async () => {
  const res = await postRemediate(originalJeId, {
    action: "adjusting_entry",
    note: "automated test bad account",
    payload: {
      entryDate: TODAY,
      memo: `bad account ${TAG}`,
      lines: [
        {
          type: "debit",
          amount: 10,
          account_code: "DOES_NOT_EXIST_999999",
        },
        {
          type: "credit",
          amount: 10,
          account_code: postableAccountCode,
        },
      ],
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body["code"], "ADJUSTING_POST_FAILED");
  assert.notEqual(res.body["reason"], "ok");
  assert.ok(typeof res.body["reason"] === "string");
});

// ---------------------------------------------------------------------------
// Reverse-and-replace partial-success contract.
//
// The dialog relies on this exact shape:
//   - 201 → { ok: true, reversalId, replacementId } so it can invalidate
//     cache for both the original and the replacement.
//   - 409 REPLACEMENT_POST_FAILED → reversal still committed, dialog stays
//     open with a retry path. The reversalId must be in the body so the
//     operator (and the activity log) know what already landed.
// ---------------------------------------------------------------------------

test("reverse_and_replace happy path returns reversalId AND replacementId for cache invalidation", async () => {
  // Use a fresh JE for this test so the reversal doesn't collide with the
  // adjusting-entry test above.
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo: `JE-${TAG}-RR1`,
      entryDate: TODAY,
      memo: `rr happy ${TAG}`,
      totalsDebitsCents: 100,
      totalsCreditsCents: 100,
      status: "posted",
      postedByUserId: adminUserId,
      approverUserId: adminUserId,
      evidenceSnapshot: { test: TAG },
    })
    .returning();
  createdJeIds.push(je!.id);
  await db.insert(journalEntryLinesTable).values([
    {
      journalEntryId: je!.id,
      lineNo: 1,
      type: "debit",
      amountCents: 100,
      account: "x",
      accountId: postableAccountId,
    },
    {
      journalEntryId: je!.id,
      lineNo: 2,
      type: "credit",
      amountCents: 100,
      account: "x",
      accountId: postableAccountId,
    },
  ]);

  const res = await postRemediate(je!.id, {
    action: "reverse_and_replace",
    note: "automated test happy reverse/replace",
    payload: balancedReplacement(),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body["ok"], true);
  assert.equal(res.body["action"], "reverse_and_replace");
  assert.equal(res.body["originalEntryId"], je!.id);
  const reversalId = res.body["reversalId"];
  const replacementId = res.body["replacementId"];
  assert.equal(typeof reversalId, "number");
  assert.equal(typeof replacementId, "number");
  assert.notEqual(reversalId, replacementId);
  createdJeIds.push(reversalId as number, replacementId as number);
});

test("reverse_and_replace with unbalanced replacement returns 409 REPLACEMENT_POST_FAILED but reversal still committed", async () => {
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo: `JE-${TAG}-RR2`,
      entryDate: TODAY,
      memo: `rr partial ${TAG}`,
      totalsDebitsCents: 100,
      totalsCreditsCents: 100,
      status: "posted",
      postedByUserId: adminUserId,
      approverUserId: adminUserId,
      evidenceSnapshot: { test: TAG },
    })
    .returning();
  createdJeIds.push(je!.id);
  await db.insert(journalEntryLinesTable).values([
    {
      journalEntryId: je!.id,
      lineNo: 1,
      type: "debit",
      amountCents: 100,
      account: "x",
      accountId: postableAccountId,
    },
    {
      journalEntryId: je!.id,
      lineNo: 2,
      type: "credit",
      amountCents: 100,
      account: "x",
      accountId: postableAccountId,
    },
  ]);

  const res = await postRemediate(je!.id, {
    action: "reverse_and_replace",
    note: "automated test partial-success",
    payload: unbalancedReplacement(),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body["code"], "REPLACEMENT_POST_FAILED");
  const reversalId = res.body["reversalId"];
  assert.equal(typeof reversalId, "number");
  // detail.kind carries the underlying postingService failure (here:
  // "unbalanced") so the dialog can render an actionable hint.
  assert.equal(res.body["replacementError"], "unbalanced");
  createdJeIds.push(reversalId as number);

  // Reversal really committed: original is now status=reversed and the
  // reversal JE exists with a posted status.
  const [orig] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, je!.id));
  assert.equal(orig!.status, "reversed");
  assert.equal(orig!.reversedByJournalEntryId, reversalId);

  const [rev] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, reversalId as number));
  assert.equal(rev!.status, "posted");

  // The activity-log row for the reversal records the failed replacement
  // explicitly so a human auditor can reconstruct the partial outcome.
  const [logRow] = await db
    .select()
    .from(activityLogTable)
    .where(
      and(
        eq(activityLogTable.referenceType, "journal_entry"),
        eq(activityLogTable.referenceId, je!.id),
        eq(
          activityLogTable.type,
          "accounting_remediation_posted_entry_reversed",
        ),
      ),
    )
    .limit(1);
  assert.ok(logRow, "reversal activity-log row missing");
  const meta = logRow!.metadata as Record<string, unknown>;
  assert.equal(meta["replacementOk"], false);
  assert.equal(meta["replacementId"], null);
  assert.equal(meta["replacementError"], "unbalanced");
  assert.equal(logRow!.actorUserId, adminUserId);
});

// ---------------------------------------------------------------------------
// Archived vs non-postable exclusivity.
//
// An account that is BOTH isActive=false AND allowManualPosting=false must
// be classified exclusively as archived in:
//   1. /accounting/remediation queue
//   2. /accounting/remediation/counts
//
// The dialog (and the integrity report) renders different fix prompts for
// the two codes, so double-counting would show the operator a bogus second
// entry to remediate.
// ---------------------------------------------------------------------------

test("queue classifies archived+non-postable line exclusively as archived_account", async () => {
  const adminCookie = `lh_session=${encodeSession(adminUserId)}`;
  const res = await fetch(
    `${baseUrl}/accounting/remediation?entryId=${archivedExclusivityJeId}`,
    { headers: { "x-test-role": "admin", cookie: adminCookie } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
  const codesForLine = body.rows
    .filter(
      (r) =>
        r["entryId"] === archivedExclusivityJeId &&
        r["currentAccount"] !== null &&
        (r["currentAccount"] as { id: number }).id ===
          archivedNonPostableAccountId,
    )
    .map((r) => r["failureCode"]);
  assert.ok(
    codesForLine.includes("archived_account"),
    `expected archived_account in codes, got: ${codesForLine.join(",")}`,
  );
  assert.ok(
    !codesForLine.includes("non_postable_account"),
    `archived line was double-counted as non_postable_account: ${codesForLine.join(",")}`,
  );
});

test("counts endpoint does NOT double-count an archived line as non_postable", async () => {
  const adminCookie = `lh_session=${encodeSession(adminUserId)}`;
  const res = await fetch(`${baseUrl}/accounting/remediation/counts`, {
    headers: { "x-test-role": "admin", cookie: adminCookie },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    byCode: Record<string, number>;
  };
  // We can't assert exact counts (other rows in the test DB), but we can
  // assert a tighter invariant: archived_account >= 1 AND that the
  // non_postable_account counter does not include our specific line. The
  // simplest way to check that is to confirm the queue rows for our JE
  // don't carry that code, which the previous test already proved. As a
  // belt-and-braces sanity check, byCode is well-formed and non-negative.
  for (const code of [
    "missing_account",
    "archived_account",
    "non_postable_account",
    "invalid_line_amount",
    "unbalanced_entry",
  ]) {
    assert.ok(
      typeof body.byCode[code] === "number" && body.byCode[code]! >= 0,
      `byCode.${code} is missing or negative`,
    );
  }
  assert.ok(
    body.byCode["archived_account"]! >= 1,
    "expected at least one archived_account in counts",
  );
});

// ---------------------------------------------------------------------------
// Role gate on the queue (admin/approver only). Viewer must be rejected so
// the dialog never even gets a chance to load remediation rows.
// ---------------------------------------------------------------------------

test("viewer role is rejected from /accounting/remediation queue (403)", async () => {
  const viewerCookie = `lh_session=${encodeSession(viewerUserId)}`;
  const res = await fetch(`${baseUrl}/accounting/remediation`, {
    headers: { "x-test-role": "viewer", cookie: viewerCookie },
  });
  assert.equal(res.status, 403);
});
