/**
 * Task #79 — Pin the scheduled-CSV preview to the emailed CSV byte-for-byte.
 *
 * Task #69 introduced a "Preview CSV" button that funnels through
 * `buildScheduleCsv` so the bytes shown to the admin equal the bytes the
 * next scheduled run would attach to the email. That parity is the entire
 * point of the preview — if anyone tweaks one path without the other
 * (different filename format, different filter parsing, an extra newline,
 * a different BOM, a renamed column) the preview silently lies. Manual
 * smoke testing won't catch that, so this suite locks the two outputs
 * together for several cadence/filter combinations.
 *
 * Method per case:
 *   1. Call `buildScheduleCsv(config, runAt)` directly — the preview path.
 *   2. Call `runSchedule(schedule, { runAt })` against a stubbed SendGrid
 *      transport that captures the outgoing request body. Decode the
 *      base64 attachment.
 *   3. Assert the two byte strings AND filenames are identical.
 *
 * Coverage spans daily/weekly/monthly cadences, summary vs.
 * include-lines exports, and source/status filter variations so the
 * comparison touches every conditional branch in `buildScheduleCsv`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  db,
  pool,
  usersTable,
  journalEntriesTable,
  journalEntryLinesTable,
  journalEntryExportSchedulesTable,
  journalEntryExportSendLogTable,
  activityLogTable,
  agentActionsTable,
  copilotThreadsTable,
  type JournalEntryExportSchedule,
} from "@workspace/db";
import {
  buildScheduleCsv,
  runSchedule,
  type ScheduleCsvConfig,
} from "../journalEntryExportScheduler";

const TAG = `t79-${process.pid}-${Date.now()}`;

const insertedScheduleIds: number[] = [];
const insertedEntryIds: number[] = [];
const insertedAgentActionIds: number[] = [];
const insertedThreadIds: number[] = [];
let testUserId: number;
let copilotUserId: number;
/** Thread that backs the per-row agent_actions used to mark copilot entries. */
let copilotThreadId: number;

const ORIGINAL_SENDGRID_API_KEY = process.env["SENDGRID_API_KEY"];
const ORIGINAL_NOTIFICATION_FROM_EMAIL = process.env["NOTIFICATION_FROM_EMAIL"];
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Captured payload from the most recent stubbed SendGrid request. The
 * tests reset this before each runSchedule() call and read it after to
 * extract the attached CSV bytes.
 */
let lastSendGridPayload: {
  attachments?: Array<{
    filename: string;
    type: string;
    content: string;
    disposition: string;
  }>;
} | null = null;

/**
 * Replace global.fetch with a stub that pretends to be SendGrid: it
 * accepts the POST, records the body, and returns 202. Anything that
 * isn't the SendGrid endpoint falls through to the original fetch so we
 * don't accidentally break unrelated network calls during the test.
 */
function installSendGridStub(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://api.sendgrid.com/v3/mail/send") {
      const rawBody = init?.body;
      if (typeof rawBody === "string") {
        lastSendGridPayload = JSON.parse(rawBody);
      } else {
        lastSendGridPayload = null;
      }
      return new Response("", { status: 202 });
    }
    return ORIGINAL_FETCH(input, init);
  }) as typeof fetch;
}

before(async () => {
  // Set both env vars so deliverEmail takes the SendGrid branch and our
  // stub gets to capture the outgoing payload (without them deliverEmail
  // short-circuits to "not_attempted" and we'd never see the bytes).
  process.env["SENDGRID_API_KEY"] = "test-key-not-real";
  process.env["NOTIFICATION_FROM_EMAIL"] = `${TAG}@test.local`;
  installSendGridStub();

  // Posting users — postedByUserId is NOT NULL on the journal_entries
  // table. We need two distinct users so we can also exercise the
  // copilot/manual source split (copilot rows have agentActionId set, not
  // a different posting user — but the second user makes failure modes
  // around posting attribution easier to spot if the test ever extends).
  const [u1] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-poster@test.local`,
      passwordHash: "x",
      firstName: "T79",
      lastName: "Poster",
      role: "admin",
    })
    .returning();
  testUserId = u1!.id;

  const [u2] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-copilot@test.local`,
      passwordHash: "x",
      firstName: "T79",
      lastName: "CopilotPoster",
      role: "admin",
    })
    .returning();
  copilotUserId = u2!.id;

  // Real copilot thread so each copilot journal entry can hang an
  // agent_action off it. Without this fixture we couldn't seed entries
  // with non-null agent_action_id, and the source filter for
  // copilot/manual would be trivially equivalent to "all" — the parity
  // test would still pass but wouldn't be meaningfully exercising the
  // source-filter branch in buildScheduleCsv. (Each copilot row gets
  // its own agent_action because journal_entries has a unique partial
  // index on agent_action_id — at most one JE per approved draft.)
  const [thread] = await db
    .insert(copilotThreadsTable)
    .values({ userId: copilotUserId, title: `${TAG}-thread` })
    .returning();
  insertedThreadIds.push(thread!.id);
  copilotThreadId = thread!.id;

  // Seed entries spanning the windows the cadences below will exercise.
  // runAt is fixed at 2025-04-15T03:00:00Z so:
  //   - daily   yields 2025-04-14 .. 2025-04-14
  //   - weekly  yields 2025-04-08 .. 2025-04-14
  //   - monthly yields 2025-03-01 .. 2025-03-31
  // The mix below puts at least two entries in each window plus an
  // outside-window row so the date filter is actually under test (not a
  // no-op). Status and source mix lets the filter combos in the loop
  // below produce different row counts and prove the filters propagate.
  const seeds: Array<{
    entryNo: string;
    entryDate: string;
    memo: string;
    status: "posted" | "reversed";
    /** "manual" rows have agentActionId NULL, "copilot" rows non-null. */
    source: "manual" | "copilot";
    debitAccount: string;
    creditAccount: string;
    amountCents: number;
  }> = [
    {
      entryNo: `${TAG}-001`,
      entryDate: "2025-04-14",
      memo: "Daily window, manual, posted",
      status: "posted",
      source: "manual",
      debitAccount: "1000 Cash",
      creditAccount: "4000 Revenue",
      amountCents: 12345,
    },
    {
      entryNo: `${TAG}-002`,
      entryDate: "2025-04-14",
      memo: "Daily window, copilot, posted, with 'quote, comma'",
      status: "posted",
      source: "copilot",
      debitAccount: "1000 Cash",
      creditAccount: "4000 Revenue",
      amountCents: 5000,
    },
    {
      entryNo: `${TAG}-003`,
      entryDate: "2025-04-10",
      memo: "Weekly-only, manual, posted",
      status: "posted",
      source: "manual",
      debitAccount: "5000 Expenses",
      creditAccount: "1000 Cash",
      amountCents: 7777,
    },
    {
      entryNo: `${TAG}-004`,
      entryDate: "2025-04-08",
      memo: "Weekly-only, copilot, reversed",
      status: "reversed",
      source: "copilot",
      debitAccount: "5000 Expenses",
      creditAccount: "1000 Cash",
      amountCents: 999,
    },
    {
      entryNo: `${TAG}-005`,
      entryDate: "2025-03-15",
      memo: "Monthly window, manual, posted",
      status: "posted",
      source: "manual",
      debitAccount: "1000 Cash",
      creditAccount: "4000 Revenue",
      amountCents: 200000,
    },
    {
      entryNo: `${TAG}-006`,
      entryDate: "2025-03-31",
      memo: "Monthly window, copilot, posted",
      status: "posted",
      source: "copilot",
      debitAccount: "1000 Cash",
      creditAccount: "4000 Revenue",
      amountCents: 333,
    },
    {
      entryNo: `${TAG}-007`,
      entryDate: "2025-02-15",
      memo: "Outside every window — must never appear",
      status: "posted",
      source: "manual",
      debitAccount: "1000 Cash",
      creditAccount: "4000 Revenue",
      amountCents: 1,
    },
  ];

  for (const s of seeds) {
    let agentActionId: number | null = null;
    if (s.source === "copilot") {
      const [aa] = await db
        .insert(agentActionsTable)
        .values({
          userId: copilotUserId,
          threadId: copilotThreadId,
          actionType: "draft_journal_entry",
          payload: { entryNo: s.entryNo },
          status: "approved",
        })
        .returning();
      insertedAgentActionIds.push(aa!.id);
      agentActionId = aa!.id;
    }
    const [entry] = await db
      .insert(journalEntriesTable)
      .values({
        entryNo: s.entryNo,
        entryDate: s.entryDate,
        memo: s.memo,
        totalsDebitsCents: s.amountCents,
        totalsCreditsCents: s.amountCents,
        status: s.status,
        // Posted-at varies by date so the scheduler's desc(postedAt) ordering
        // is deterministic across runs. We anchor at noon UTC of entryDate.
        postedAt: new Date(`${s.entryDate}T12:00:00.000Z`),
        postedByUserId: s.source === "copilot" ? copilotUserId : testUserId,
        // Stamping a real agent_action_id on copilot rows is what makes the
        // source filter discriminative — buildSourceClauseFor("copilot")
        // checks `agent_action_id IS NOT NULL`, and the manual branch
        // checks the inverse. Without this both classes would collapse
        // and the parity test for source filters would be vacuous.
        agentActionId,
      })
      .returning();
    insertedEntryIds.push(entry!.id);

    await db.insert(journalEntryLinesTable).values([
      {
        journalEntryId: entry!.id,
        lineNo: 1,
        type: "debit",
        amountCents: s.amountCents,
        account: s.debitAccount,
        program: "general",
        fund: "unrestricted",
        memo: `dr ${s.memo}`,
      },
      {
        journalEntryId: entry!.id,
        lineNo: 2,
        type: "credit",
        amountCents: s.amountCents,
        account: s.creditAccount,
        program: "general",
        fund: "unrestricted",
        memo: `cr ${s.memo}`,
      },
    ]);
  }
});

after(async () => {
  // Restore env + fetch first so a failure in the DB cleanup below does
  // not leave a poisoned global state behind for other test files.
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
    // Each runSchedule() call writes to send_log + activity_log; clear
    // those before the schedules so the FKs let go.
    await db
      .delete(journalEntryExportSendLogTable)
      .where(
        inArray(
          journalEntryExportSendLogTable.scheduleId,
          insertedScheduleIds,
        ),
      );
    // Scope by referenceType too so we never accidentally clobber an
    // unrelated activity_log row that happens to share an id with one
    // of our schedules (paranoia for shared/parallel test environments).
    await db
      .delete(activityLogTable)
      .where(
        and(
          eq(activityLogTable.referenceType, "journal_entry_export_schedule"),
          inArray(activityLogTable.referenceId, insertedScheduleIds),
        ),
      );
    await db
      .delete(journalEntryExportSchedulesTable)
      .where(
        inArray(journalEntryExportSchedulesTable.id, insertedScheduleIds),
      );
  }
  if (insertedEntryIds.length > 0) {
    // journal_entries / journal_entry_lines have BEFORE UPDATE/DELETE
    // triggers (Task #48) that reject normal DELETEs. Disable them just
    // for cleanup, then re-enable so the rest of the database stays
    // protected — same pattern postedEntriesImmutable.test.ts uses.
    try {
      await db.execute(
        sql`ALTER TABLE journal_entry_lines DISABLE TRIGGER journal_entry_lines_lock`,
      );
      await db.execute(
        sql`ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_lock`,
      );
      await db
        .delete(journalEntryLinesTable)
        .where(
          inArray(journalEntryLinesTable.journalEntryId, insertedEntryIds),
        );
      await db
        .delete(journalEntriesTable)
        .where(inArray(journalEntriesTable.id, insertedEntryIds));
    } finally {
      await db.execute(
        sql`ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_lock`,
      );
      await db.execute(
        sql`ALTER TABLE journal_entry_lines ENABLE TRIGGER journal_entry_lines_lock`,
      );
    }
  }
  if (insertedAgentActionIds.length > 0) {
    // agent_actions has ON DELETE RESTRICT from journal_entries; the JE
    // delete above must run first or this DELETE would error.
    await db
      .delete(agentActionsTable)
      .where(inArray(agentActionsTable.id, insertedAgentActionIds));
  }
  if (insertedThreadIds.length > 0) {
    await db
      .delete(copilotThreadsTable)
      .where(inArray(copilotThreadsTable.id, insertedThreadIds));
  }
  if (typeof testUserId === "number" || typeof copilotUserId === "number") {
    const ids = [testUserId, copilotUserId].filter(
      (id): id is number => typeof id === "number",
    );
    if (ids.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, ids));
    }
  }

  await pool.end();
});

/**
 * Insert a schedule row matching the given config. Each test gets its
 * own row (tracked for cleanup) so the per-run mutations made by
 * runSchedule (last_run_at, last_run_status) don't bleed across cases.
 */
async function insertScheduleFor(
  caseLabel: string,
  config: ScheduleCsvConfig,
): Promise<JournalEntryExportSchedule> {
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `${TAG}-${caseLabel}`,
      enabled: true,
      cadence: config.cadence,
      // Use a real-looking address so deliverEmail accepts the recipient
      // list (it filters out empty/whitespace entries).
      recipients: [`${TAG}-rcpt@test.local`],
      filterStatus: config.filterStatus,
      filterSource: config.filterSource,
      filterPostedByUserId: config.filterPostedByUserId,
      filterApproverUserId: config.filterApproverUserId,
      includeLines: config.includeLines,
      // Future timestamp so the in-process scheduler tick (if it ever
      // ran during tests) cannot also claim and dispatch this row.
      nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .returning();
  insertedScheduleIds.push(row!.id);
  return row!;
}

type ParityCase = {
  label: string;
  runAt: Date;
  config: ScheduleCsvConfig;
};

const parityCases: ParityCase[] = [
  {
    label: "daily-summary-no-filters",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "daily",
      filterStatus: null,
      filterSource: null,
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
    },
  },
  {
    label: "daily-with-lines-no-filters",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "daily",
      filterStatus: null,
      filterSource: null,
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: true,
    },
  },
  {
    label: "weekly-summary-status-posted",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "weekly",
      filterStatus: "posted",
      filterSource: null,
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
    },
  },
  {
    label: "weekly-with-lines-status-reversed",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "weekly",
      filterStatus: "reversed",
      filterSource: null,
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: true,
    },
  },
  {
    label: "monthly-summary-source-manual",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "monthly",
      filterStatus: null,
      filterSource: "manual",
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
    },
  },
  {
    // Pairs with the manual-source case above on the same window. The
    // seed places one copilot row (entry-006) and one manual row
    // (entry-005) inside the monthly window, so this case must produce
    // a strictly different CSV from the manual case — proving the
    // source filter actually selects rows, not just no-ops.
    label: "monthly-summary-source-copilot",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "monthly",
      filterStatus: null,
      filterSource: "copilot",
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
    },
  },
  {
    label: "monthly-with-lines-posted-by-filter",
    runAt: new Date("2025-04-15T03:00:00.000Z"),
    config: {
      cadence: "monthly",
      filterStatus: null,
      filterSource: null,
      filterPostedByUserId: null, // assigned at test time once testUserId is known
      filterApproverUserId: null,
      includeLines: true,
    },
  },
  {
    label: "weekly-empty-window",
    // A runAt whose weekly window (2025-06-08..2025-06-14) contains no
    // seeded rows. Ensures the empty-CSV path (header-only) also matches.
    runAt: new Date("2025-06-15T03:00:00.000Z"),
    config: {
      cadence: "weekly",
      filterStatus: null,
      filterSource: null,
      filterPostedByUserId: null,
      filterApproverUserId: null,
      includeLines: false,
    },
  },
];

for (const c of parityCases) {
  test(`preview bytes match emailed CSV — ${c.label}`, async () => {
    // Fill in user-id-dependent filters now that the before() hook ran.
    const config: ScheduleCsvConfig =
      c.label === "monthly-with-lines-posted-by-filter"
        ? { ...c.config, filterPostedByUserId: testUserId }
        : c.config;

    // 1) Preview path — bytes the admin sees in the UI.
    const preview = await buildScheduleCsv(config, c.runAt);
    assert.equal(
      preview.ok,
      true,
      `preview build must succeed for ${c.label}`,
    );
    if (!preview.ok) return; // narrowing for TS

    // 2) Scheduled-email path — bytes deliverEmail attaches to the message.
    const schedule = await insertScheduleFor(c.label, config);
    lastSendGridPayload = null;
    const result = await runSchedule(schedule, {
      triggeredBy: "manual",
      runAt: c.runAt,
    });
    assert.notEqual(
      result.status,
      "failed",
      `runSchedule must not fail for ${c.label}: ${result.error ?? ""}`,
    );

    // SendGrid payload must have been captured (proves deliverEmail
    // actually exercised the network branch — without this the test
    // would silently pass on a "not_attempted" path that bypasses the
    // attachment encoding entirely).
    assert.ok(
      lastSendGridPayload,
      `SendGrid stub must have received the request for ${c.label}`,
    );
    const attachments = lastSendGridPayload!.attachments ?? [];
    assert.equal(
      attachments.length,
      1,
      `expected exactly one attachment for ${c.label}`,
    );
    const attachment = attachments[0]!;
    const emailedBytes = Buffer.from(attachment.content, "base64");
    const previewBytes = Buffer.from(preview.csv, "utf-8");

    // 3) The byte-for-byte parity assertion this whole suite exists for.
    // Compare as raw Buffers so a stray BOM/CRLF/encoding shift between
    // the two paths trips the assertion at the byte level (a UTF-8
    // string compare would still catch most drift, but bytes are the
    // strictest representation of "what SendGrid would attach").
    assert.equal(
      attachment.filename,
      preview.filename,
      `filename drift between preview and email for ${c.label}`,
    );
    assert.equal(
      emailedBytes.length,
      previewBytes.length,
      `CSV byte length drift (${emailedBytes.length} vs ${previewBytes.length}) for ${c.label}`,
    );
    assert.ok(
      emailedBytes.equals(previewBytes),
      `CSV byte drift between preview and email for ${c.label}`,
    );
    assert.equal(
      attachment.type,
      "text/csv",
      `attachment MIME type must be text/csv for ${c.label}`,
    );
  });
}
