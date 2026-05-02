/**
 * Task #131 — Guided integrity-repair workflow integration tests.
 *
 * Covers POST /api/admin/integrity/sweep/repair against the safe-set
 * registry (`expense_draft_no_link`, `bill_accrual_draft_no_link`,
 * `bill_payment_draft_no_link`):
 *
 *   - Happy path per check: an orphan draft (created with the canonical
 *     memo suffix/prefix) is matched and an asl row + activity_log
 *     entry of type='integrity_repair' get written.
 *   - Replay safety: a second call against an already-linked source
 *     skips with "Already linked — no change needed" and does NOT
 *     write a duplicate asl row or a duplicate activity_log entry.
 *   - State drift: when accountingStatus has moved off 'draft_created'
 *     the repair is skipped with a clear reason and no side effects.
 *   - Auth gating: unknown checkKey → 400; non-admin → 403.
 *
 * Same express-stub pattern as integritySweep.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "node:http";
import { eq, inArray, and } from "drizzle-orm";

import {
  db,
  pool,
  usersTable,
  expensesTable,
  vendorsTable,
  billsTable,
  manualJournalEntryDraftsTable,
  accountingSourceLinksTable,
  activityLogTable,
} from "@workspace/db";
import integrityRouter from "../../routes/integrity";
import { encodeSession } from "../auth";
import { INTEGRITY_REPAIR_ACTIVITY_TYPE } from "../integrityRepairService";

const TAG = `t131-${process.pid}-${Date.now()}`;

let app: Express;
let server: Server;
let baseUrl: string;
let adminUserId: number;
let viewerUserId: number;
let vendorId: number;

const draftIds: number[] = [];
const expenseIds: number[] = [];
const billIds: number[] = [];

async function makeDraft(memo: string): Promise<number> {
  const [d] = await db
    .insert(manualJournalEntryDraftsTable)
    .values({
      createdByUserId: adminUserId,
      entryDate: "2030-06-01",
      memo,
      payload: { entryDate: "2030-06-01", memo, lines: [] },
      status: "draft",
      version: 0,
    })
    .returning();
  draftIds.push(d!.id);
  return d!.id;
}

async function makeExpense(suffixId: number): Promise<number> {
  const [e] = await db
    .insert(expensesTable)
    .values({
      submittedBy: `${TAG}-exp-${suffixId}`,
      expenseDate: "2030-06-01",
      merchant: `${TAG}-merch`,
      description: "x",
      amount: "12.34",
      paymentMethod: "cash",
      status: "draft",
      accountingStatus: "draft_created",
    })
    .returning();
  expenseIds.push(e!.id);
  return e!.id;
}

async function makeBill(amount: string): Promise<number> {
  const [b] = await db
    .insert(billsTable)
    .values({
      vendorId,
      dueDate: "2030-06-15",
      invoiceDate: "2030-06-01",
      amount,
      status: "approved",
      accountingStatus: "draft_created",
    })
    .returning();
  billIds.push(b!.id);
  return b!.id;
}

async function makePaidBill(amount: string): Promise<number> {
  const [b] = await db
    .insert(billsTable)
    .values({
      vendorId,
      dueDate: "2030-06-15",
      invoiceDate: "2030-06-01",
      paidDate: "2030-06-20",
      amount,
      status: "paid",
      accountingStatus: "posted",
      accountingPaymentStatus: "draft_created",
    })
    .returning();
  billIds.push(b!.id);
  return b!.id;
}

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@test.local`,
      passwordHash: "x",
      firstName: "Repair",
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
      firstName: "Repair",
      lastName: "Viewer",
      role: "submitter",
    })
    .returning();
  viewerUserId = viewer!.id;

  const [v] = await db
    .insert(vendorsTable)
    .values({ name: `${TAG}-vendor` })
    .returning();
  vendorId = v!.id;

  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", integrityRouter);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object")
        baseUrl = `http://127.0.0.1:${addr.port}/api`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (expenseIds.length) {
    await db
      .delete(accountingSourceLinksTable)
      .where(
        and(
          eq(accountingSourceLinksTable.sourceType, "expense"),
          inArray(accountingSourceLinksTable.sourceId, expenseIds),
        ),
      );
    await db
      .delete(activityLogTable)
      .where(
        and(
          eq(activityLogTable.referenceType, "expense"),
          inArray(activityLogTable.referenceId, expenseIds),
        ),
      );
    await db.delete(expensesTable).where(inArray(expensesTable.id, expenseIds));
  }
  if (billIds.length) {
    await db
      .delete(accountingSourceLinksTable)
      .where(
        and(
          eq(accountingSourceLinksTable.sourceType, "bill"),
          inArray(accountingSourceLinksTable.sourceId, billIds),
        ),
      );
    await db
      .delete(activityLogTable)
      .where(
        and(
          eq(activityLogTable.referenceType, "bill"),
          inArray(activityLogTable.referenceId, billIds),
        ),
      );
    await db.delete(billsTable).where(inArray(billsTable.id, billIds));
  }
  if (draftIds.length) {
    await db
      .delete(manualJournalEntryDraftsTable)
      .where(inArray(manualJournalEntryDraftsTable.id, draftIds));
  }
  if (vendorId)
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  if (adminUserId)
    await db.delete(usersTable).where(eq(usersTable.id, adminUserId));
  if (viewerUserId)
    await db.delete(usersTable).where(eq(usersTable.id, viewerUserId));
  await pool.end();
});

function adminCookie(): string {
  return `lh_session=${encodeSession(adminUserId)}`;
}

async function postRepair(
  body: unknown,
  cookie: string = adminCookie(),
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/admin/integrity/sweep/repair`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registry endpoint exposes the safe-set with stable shape", async () => {
  const r = await fetch(`${baseUrl}/admin/integrity/repair-registry`, {
    headers: { cookie: adminCookie() },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  const keys = body.items.map((i: { checkKey: string }) => i.checkKey).sort();
  assert.deepEqual(keys, [
    "bill_accrual_draft_no_link",
    "bill_payment_draft_no_link",
    "expense_draft_no_link",
  ]);
  for (const it of body.items) {
    assert.equal(typeof it.label, "string");
    assert.equal(typeof it.description, "string");
    assert.equal(typeof it.idLabel, "string");
  }
});

test("expense_draft_no_link: links orphan draft + replay is a noop", async () => {
  const expenseId = await makeExpense(1);
  await makeDraft(`Some accrual memo (expense #${expenseId})`);

  const first = await postRepair({
    checkKey: "expense_draft_no_link",
    ids: [expenseId],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.repaired, [expenseId]);
  assert.deepEqual(first.body.skipped, []);

  const links = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "expense"),
        eq(accountingSourceLinksTable.sourceId, expenseId),
      ),
    );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.eventType, "primary");
  assert.equal(links[0]!.createdByUserId, adminUserId);

  const logs = await db
    .select()
    .from(activityLogTable)
    .where(
      and(
        eq(activityLogTable.type, INTEGRITY_REPAIR_ACTIVITY_TYPE),
        eq(activityLogTable.referenceType, "expense"),
        eq(activityLogTable.referenceId, expenseId),
      ),
    );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.actorUserId, adminUserId);

  // Replay — no new asl row, no new activity_log row.
  const second = await postRepair({
    checkKey: "expense_draft_no_link",
    ids: [expenseId],
  });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.repaired, []);
  assert.equal(second.body.skipped.length, 1);
  assert.match(second.body.skipped[0].reason, /Already linked/);

  const linksAfter = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "expense"),
        eq(accountingSourceLinksTable.sourceId, expenseId),
      ),
    );
  assert.equal(linksAfter.length, 1);

  const logsAfter = await db
    .select()
    .from(activityLogTable)
    .where(
      and(
        eq(activityLogTable.type, INTEGRITY_REPAIR_ACTIVITY_TYPE),
        eq(activityLogTable.referenceType, "expense"),
        eq(activityLogTable.referenceId, expenseId),
      ),
    );
  assert.equal(logsAfter.length, 1);
});

test("bill_accrual_draft_no_link: links orphan accrual draft", async () => {
  const billId = await makeBill("250.00");
  await makeDraft(`Acme Vendor — June (bill #${billId})`);

  const r = await postRepair({
    checkKey: "bill_accrual_draft_no_link",
    ids: [billId],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.repaired, [billId]);

  const links = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "bill"),
        eq(accountingSourceLinksTable.sourceId, billId),
        eq(accountingSourceLinksTable.eventType, "accrual"),
      ),
    );
  assert.equal(links.length, 1);
});

test("bill_payment_draft_no_link: matches Payment-of-bill memo prefix", async () => {
  const billId = await makePaidBill("400.00");
  await makeDraft(`Payment of bill #${billId} — Acme Vendor`);

  const r = await postRepair({
    checkKey: "bill_payment_draft_no_link",
    ids: [billId],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.repaired, [billId]);
  const links = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "bill"),
        eq(accountingSourceLinksTable.sourceId, billId),
        eq(accountingSourceLinksTable.eventType, "payment"),
      ),
    );
  assert.equal(links.length, 1);
});

test("state drift: skips when accounting_status no longer 'draft_created'", async () => {
  const expenseId = await makeExpense(2);
  await db
    .update(expensesTable)
    .set({ accountingStatus: "posted" })
    .where(eq(expensesTable.id, expenseId));

  const r = await postRepair({
    checkKey: "expense_draft_no_link",
    ids: [expenseId],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.repaired, []);
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /no longer 'draft_created'/);

  // No side effects.
  const links = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "expense"),
        eq(accountingSourceLinksTable.sourceId, expenseId),
      ),
    );
  assert.equal(links.length, 0);
});

test("missing draft: skips with 'no matching unposted draft' reason", async () => {
  const expenseId = await makeExpense(3);
  // Intentionally no draft created.

  const r = await postRepair({
    checkKey: "expense_draft_no_link",
    ids: [expenseId],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.repaired, []);
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /No matching unposted draft/);
});

test("recent-repairs feed includes the integrity_repair rows just written", async () => {
  const r = await fetch(`${baseUrl}/admin/integrity/repairs`, {
    headers: { cookie: adminCookie() },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.items));
  // The two successful repairs above (expense + bill accrual + bill payment)
  // should be the most-recent entries by this admin.
  const mine = body.items.filter(
    (i: { actorUserId: number | null }) => i.actorUserId === adminUserId,
  );
  assert.ok(mine.length >= 3, `expected >=3 repair rows, got ${mine.length}`);
  for (const row of mine) {
    assert.equal(row.type, INTEGRITY_REPAIR_ACTIVITY_TYPE);
    assert.match(row.description, /Integrity repair/);
  }
});

test("payment memo match is bounded — bill #N does not match draft for #N0/#N00", async () => {
  // Seed two paid bills whose IDs are known to be distinct, then create
  // a draft only for the LARGER (numerically-prefix-overlapping) bill.
  // The repair for the smaller bill must NOT pick up the larger bill's
  // draft via a loose LIKE 'Payment of bill #N%' match.
  const smallBill = await makePaidBill("11.00");
  // Force a draft memo with a numerically-prefix-overlapping id by
  // building the memo from `${smallBill}0` rather than relying on
  // serial ids landing on a prefix-overlap. We still seed a real
  // larger bill so cleanup hooks run normally.
  const largeBill = await makePaidBill("110.00");
  const overlappingId = `${smallBill}0`;
  // Seed a draft whose memo references a DIFFERENT bill id that just
  // happens to start with the small bill's id ("12" → "120"). A loose
  // `LIKE 'Payment of bill #12%'` would erroneously match "#120 — …"
  // and silently mis-link the small bill. The bounded match
  // (`#12 — %` with the em-dash separator) must reject it.
  await makeDraft(`Payment of bill #${overlappingId} — Acme Vendor`);
  await makeDraft(`Payment of bill #${largeBill} — Acme Vendor`);

  const r = await postRepair({
    checkKey: "bill_payment_draft_no_link",
    ids: [smallBill],
  });
  assert.equal(r.status, 200);
  // Repair for the smaller bill must skip — no draft for THAT bill
  // exists. If the LIKE pattern were unbounded (`#N%`), the larger
  // bill's draft would be wrongly returned and `repaired` would
  // contain `smallBill`.
  assert.deepEqual(
    r.body.repaired,
    [],
    `bill #${smallBill} must not be linked to bill #${largeBill}'s draft`,
  );
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /No matching unposted draft/);

  // And the large bill's draft must remain unlinked (untouched).
  const linksLarge = await db
    .select()
    .from(accountingSourceLinksTable)
    .where(
      and(
        eq(accountingSourceLinksTable.sourceType, "bill"),
        eq(accountingSourceLinksTable.sourceId, largeBill),
        eq(accountingSourceLinksTable.eventType, "payment"),
      ),
    );
  assert.equal(linksLarge.length, 0);
});

test("400 for unknown checkKey", async () => {
  const r = await postRepair({ checkKey: "not_in_registry", ids: [1] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not in the safe-set/);
});

test("400 for empty ids", async () => {
  const r = await postRepair({
    checkKey: "expense_draft_no_link",
    ids: [],
  });
  assert.equal(r.status, 400);
});

test("non-admin viewer is rejected with 403", async () => {
  const r = await postRepair(
    { checkKey: "expense_draft_no_link", ids: [1] },
    `lh_session=${encodeSession(viewerUserId)}`,
  );
  assert.equal(r.status, 403);
});
