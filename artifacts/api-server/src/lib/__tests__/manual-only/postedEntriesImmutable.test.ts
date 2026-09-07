/**
 * Task #67 — Posted journal entries are immutable.
 *
 * Task #48 installed two BEFORE UPDATE/DELETE triggers
 * (`journal_entries_lock_trg`, `journal_entry_lines_lock_trg`) that
 * fail-close any attempt to mutate the ledger out of band. Those triggers
 * were verified manually but never covered by an automated test, so this
 * suite locks that audit guarantee in CI.
 *
 * The suite exercises the triggers directly against the live database
 * (DATABASE_URL must be set) and:
 *
 *   1. DELETE on a posted journal_entries row is rejected.
 *   2. UPDATE of any column other than the controlled posted -> reversed
 *      flip is rejected.
 *   3. UPDATE of any journal_entry_lines column (other than the legacy
 *      account_id NULL -> non-NULL backfill) is rejected.
 *   4. DELETE of any journal_entry_lines row is rejected.
 *   5. The legitimate posted -> reversed flip performed by
 *      reverseJournalEntry() still succeeds end-to-end (status flips,
 *      reversed_by_journal_entry_id wired, reversal JE inserted with
 *      mirrored lines).
 *
 * Cleanup intentionally bypasses the immutability triggers via
 * `ALTER TABLE ... DISABLE TRIGGER` so the test leaves no residue. The
 * triggers are re-enabled in a finally block even if assertions throw.
 *
 * MOVED OUT OF THE AUTO-RUN SUITE 2026-09-07: `npm run test` (api-server)
 * globs `src/lib/__tests__/*.test.ts`, which does NOT recurse into this
 * `manual-only/` subdirectory, so this file no longer runs on every deploy.
 * Confirmed live: this suite had been running on every single deploy
 * against the real production database — no dedicated test database has
 * ever existed for this project — meaning production's posted-entry
 * immutability triggers were disabled and re-enabled as a side effect of
 * every deploy's test step. That's a real risk window (a crash between the
 * DISABLE and the re-enabling `finally` would leave the live GL
 * unprotected), not a hypothetical one. Provisioning a real, separate test
 * database (e.g. a distinct Neon branch) is the actual fix and needs a
 * human with Neon account access — until then, this suite should only be
 * run by hand, deliberately, with DATABASE_URL pointed at that dedicated
 * database: `DATABASE_URL=<test-db-url> tsx --test src/lib/__tests__/manual-only/postedEntriesImmutable.test.ts`.
 * The guard just below refuses to run at all if DATABASE_URL still points
 * at the known production host, as a hard floor under human error.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
import { reverseJournalEntry, type PostingActor } from "../../postingService";
import { refuseIfProductionDatabase } from "./refuseProductionDb";

const TAG = `t67-${process.pid}-${Date.now()}`;

let actor: PostingActor;
let userId: number;
let accountId: number;
let periodId: number;
let originalJeId: number;
let lineIds: number[] = [];
const createdJeIds: number[] = [];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// No dedicated test database exists yet for this project (tracked
// separately — needs a real Neon branch provisioned, which requires
// account access this environment doesn't have) — every test run,
// including this one, currently shares DATABASE_URL with production. This
// suite is uniquely dangerous among the test files here: it disables the
// posted-entry immutability triggers with `ALTER TABLE ... DISABLE
// TRIGGER` and only re-enables them in a `finally`. If this file were ever
// run by hand, or a future change broke that finally block, the real
// general ledger's core audit guarantee would be left unprotected. Refusing
// to run at all against the one known-production connection string is a
// hard floor, not a substitute for the real fix (an actually separate
// database) — it just makes the worst-case outcome of not having one
// impossible for this specific host until that's provisioned.
refuseIfProductionDatabase();

before(async () => {
  // Make sure the lock triggers are installed in this database. Idempotent.
  await ensureSchemaConstraints();

  // --- Fixtures ----------------------------------------------------------
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}@test.local`,
      passwordHash: "x",
      firstName: "Trigger",
      lastName: "Test",
      role: "admin",
    })
    .returning();
  userId = user!.id;
  actor = {
    id: user!.id,
    role: "admin",
    firstName: user!.firstName,
    lastName: user!.lastName,
    email: user!.email,
  };

  const [account] = await db
    .insert(chartOfAccountsTable)
    .values({
      code: `9${String(process.pid).slice(-3)}${String(Date.now()).slice(-4)}`.slice(0, 8),
      name: `Test Account ${TAG}`,
      type: "asset",
      normalBalance: "debit",
    })
    .returning();
  accountId = account!.id;

  // Period covering today and the surrounding year so reverseJournalEntry
  // can post a reversal dated today, and the original JE (also dated today)
  // is inside an open period.
  const year = new Date().getUTCFullYear();
  const [period] = await db
    .insert(accountingPeriodsTable)
    .values({
      label: `Test Period ${TAG}`,
      periodStart: `${year}-01-01`,
      periodEnd: `${year + 1}-12-31`,
      status: "open",
    })
    .returning();
  periodId = period!.id;

  // Post the JE directly via INSERT — we don't want the test depending on
  // the high-level posting workflow (drafts, agent actions, etc). The
  // triggers fire on UPDATE/DELETE, not INSERT, so this is allowed.
  const today = todayIso();
  const entryNo = `JE-TEST-${TAG}`;
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNo,
      entryDate: today,
      memo: `original ${TAG}`,
      totalsDebitsCents: 1000,
      totalsCreditsCents: 1000,
      status: "posted",
      postedByUserId: userId,
      approverUserId: userId,
      evidenceSnapshot: { test: TAG },
    })
    .returning();
  originalJeId = je!.id;
  createdJeIds.push(je!.id);

  const lines = await db
    .insert(journalEntryLinesTable)
    .values([
      {
        journalEntryId: originalJeId,
        lineNo: 1,
        type: "debit",
        amountCents: 1000,
        account: "Test Debit",
        accountId,
        memo: "debit memo",
      },
      {
        journalEntryId: originalJeId,
        lineNo: 2,
        type: "credit",
        amountCents: 1000,
        account: "Test Credit",
        accountId,
        memo: "credit memo",
      },
    ])
    .returning();
  lineIds = lines.map((l) => l.id);
});

after(async () => {
  // Triggers prevent normal DELETEs. Disable them just for cleanup, then
  // re-enable so the rest of the database stays protected.
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
            eq(activityLogTable.referenceType, 'journal_entry'),
            inArray(activityLogTable.referenceId, createdJeIds),
          ),
        );
      // Break the self-FK before deleting parents.
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

  if (periodId)
    await db
      .delete(accountingPeriodsTable)
      .where(eq(accountingPeriodsTable.id, periodId));
  if (accountId)
    await db
      .delete(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.id, accountId));
  if (userId)
    await db.delete(usersTable).where(eq(usersTable.id, userId));

  await pool.end();
});

async function expectTriggerError(
  fn: () => Promise<unknown>,
  matcher: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected trigger to reject the operation, but it succeeded");
  const errObj = caught as { message?: string; cause?: { message?: string } };
  const msg = (errObj.message ?? "") + " || " + (errObj.cause?.message ?? "");
  assert.match(msg, matcher, `unexpected error message: ${msg}`);
}

test("DELETE on a posted journal_entries row is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .delete(journalEntriesTable)
        .where(eq(journalEntriesTable.id, originalJeId)),
    /immutable|deletion is not allowed/i,
  );
  // Row should still exist.
  const [stillThere] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, originalJeId));
  assert.ok(stillThere, "JE row was deleted despite the trigger");
});

test("UPDATE of memo on a posted JE is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .update(journalEntriesTable)
        .set({ memo: "tampered" })
        .where(eq(journalEntriesTable.id, originalJeId)),
    /Posted journal entries are locked/i,
  );
});

test("UPDATE of totals on a posted JE is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .update(journalEntriesTable)
        .set({ totalsDebitsCents: 9999 })
        .where(eq(journalEntriesTable.id, originalJeId)),
    /Posted journal entries are locked/i,
  );
});

test("UPDATE flipping status to reversed without a reversal JE id is rejected", async () => {
  // The trigger only allows the flip when reversed_by_journal_entry_id
  // moves from NULL to non-NULL in the same UPDATE. A bare status flip
  // must be refused.
  await expectTriggerError(
    () =>
      db
        .update(journalEntriesTable)
        .set({ status: "reversed" })
        .where(eq(journalEntriesTable.id, originalJeId)),
    /Posted journal entries are locked/i,
  );
});

test("UPDATE on a journal_entry_lines row is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .update(journalEntryLinesTable)
        .set({ memo: "tampered" })
        .where(eq(journalEntryLinesTable.id, lineIds[0]!)),
    /journal_entry_lines are immutable/i,
  );
});

test("UPDATE of amount_cents on a journal_entry_lines row is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .update(journalEntryLinesTable)
        .set({ amountCents: 9999 })
        .where(eq(journalEntryLinesTable.id, lineIds[0]!)),
    /journal_entry_lines are immutable/i,
  );
});

test("DELETE of a journal_entry_lines row is rejected", async () => {
  await expectTriggerError(
    () =>
      db
        .delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.id, lineIds[0]!)),
    /journal_entry_lines are immutable/i,
  );
});

test("reverseJournalEntry() still works end-to-end and flips status atomically", async () => {
  const result = await reverseJournalEntry(
    originalJeId,
    actor,
    "automated trigger test reversal",
  );
  assert.equal(result.kind, "ok", `unexpected result kind: ${result.kind}`);
  if (result.kind !== "ok") return;
  assert.equal(result.idempotent, false);
  assert.equal(result.original.status, "reversed");
  assert.equal(result.original.reversedByJournalEntryId, result.reversal.id);
  assert.equal(result.reversal.reversesJournalEntryId, originalJeId);
  assert.equal(result.reversal.status, "posted");
  // Lines are mirrored: each original debit becomes a credit and vice versa.
  assert.equal(result.reversalLines.length, 2);
  const byLineNo = new Map(result.reversalLines.map((l) => [l.lineNo, l]));
  assert.equal(byLineNo.get(1)?.type, "credit");
  assert.equal(byLineNo.get(2)?.type, "debit");
  // Track the new reversal JE so cleanup tears it down too.
  createdJeIds.push(result.reversal.id);

  // Calling reverse again is idempotent and returns the same reversal.
  const replay = await reverseJournalEntry(
    originalJeId,
    actor,
    "automated trigger test reversal",
  );
  assert.equal(replay.kind, "ok");
  if (replay.kind !== "ok") return;
  assert.equal(replay.idempotent, true);
  assert.equal(replay.reversal.id, result.reversal.id);
});
