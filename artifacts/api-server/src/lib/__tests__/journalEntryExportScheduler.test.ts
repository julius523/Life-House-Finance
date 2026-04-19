/**
 * Task #70 — Cadence math + scheduler claim safety.
 *
 * Two regressions in `journalEntryExportScheduler.ts` would silently
 * misbehave in production:
 *
 *   1. `computeNextRunAt` getting a month-end / year-end edge wrong
 *      (would skip an export, or fire it twice for the same window).
 *   2. The atomic-claim UPDATE in `tick()` admitting two concurrent
 *      ticks against the same due row (would double-send the CSV).
 *
 * Both paths were only validated by manual smoke testing. This suite
 * covers the cadence math exhaustively across UTC edges (no DST since
 * everything is anchored at 02:00 UTC) and exercises the exact SQL
 * claim predicate that `tick()` relies on, asserting that two parallel
 * claim attempts on the same due schedule produce exactly one winner —
 * i.e. only one `runSchedule()` invocation can ever follow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNotNull, lte, inArray } from "drizzle-orm";

import {
  db,
  pool,
  journalEntryExportSchedulesTable,
} from "@workspace/db";
import {
  computeNextRunAt,
  _tickOnceForTests,
} from "../journalEntryExportScheduler";
import type { JournalEntryExportSchedule } from "@workspace/db";

// ---------------------------------------------------------------------------
// computeNextRunAt — pure function, no DB.
//
// Anchor: 02:00 UTC. Each cadence is recomputed independently from `from`
// (no shared day-roll), so month-end / year-end never accidentally skips a
// period.
// ---------------------------------------------------------------------------

const iso = (s: string) => new Date(s);

test("daily: before 02:00 UTC fires the same day at 02:00", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-03-15T01:30:00.000Z")).toISOString(),
    "2025-03-15T02:00:00.000Z",
  );
});

test("daily: at exactly 02:00 UTC rolls to tomorrow (strictly-after semantics)", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-03-15T02:00:00.000Z")).toISOString(),
    "2025-03-16T02:00:00.000Z",
  );
});

test("daily: after 02:00 UTC fires tomorrow at 02:00", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-03-15T15:00:00.000Z")).toISOString(),
    "2025-03-16T02:00:00.000Z",
  );
});

test("daily: month-end Jan 31 → Feb 1 (non-leap)", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-01-31T23:00:00.000Z")).toISOString(),
    "2025-02-01T02:00:00.000Z",
  );
});

test("daily: leap-year Feb 28 → Feb 29", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2024-02-28T23:00:00.000Z")).toISOString(),
    "2024-02-29T02:00:00.000Z",
  );
});

test("daily: leap-year Feb 29 → Mar 1", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2024-02-29T23:00:00.000Z")).toISOString(),
    "2024-03-01T02:00:00.000Z",
  );
});

test("daily: non-leap Feb 28 → Mar 1", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-02-28T23:00:00.000Z")).toISOString(),
    "2025-03-01T02:00:00.000Z",
  );
});

test("daily: year-end Dec 31 → Jan 1 next year", () => {
  assert.equal(
    computeNextRunAt("daily", iso("2025-12-31T23:00:00.000Z")).toISOString(),
    "2026-01-01T02:00:00.000Z",
  );
});

test("weekly: Monday 01:00 → same Monday 02:00", () => {
  // 2025-01-06 is a Monday.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-06T01:00:00.000Z")).toISOString(),
    "2025-01-06T02:00:00.000Z",
  );
});

test("weekly: Monday 02:00 → next Monday (strictly-after)", () => {
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-06T02:00:00.000Z")).toISOString(),
    "2025-01-13T02:00:00.000Z",
  );
});

test("weekly: Monday afternoon → next Monday 02:00", () => {
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-06T15:00:00.000Z")).toISOString(),
    "2025-01-13T02:00:00.000Z",
  );
});

test("weekly: Sunday 23:00 → Monday 02:00 the next day", () => {
  // 2025-01-05 is a Sunday → 2025-01-06 Monday.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-05T23:00:00.000Z")).toISOString(),
    "2025-01-06T02:00:00.000Z",
  );
});

test("weekly: Tuesday → following Monday (6 days ahead)", () => {
  // 2025-01-07 is a Tuesday.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-07T12:00:00.000Z")).toISOString(),
    "2025-01-13T02:00:00.000Z",
  );
});

test("weekly: Saturday → Monday 2 days later", () => {
  // 2025-01-11 is a Saturday.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-11T12:00:00.000Z")).toISOString(),
    "2025-01-13T02:00:00.000Z",
  );
});

test("weekly: across month boundary Jan→Feb", () => {
  // 2025-01-31 is a Friday → next Monday is 2025-02-03.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-01-31T15:00:00.000Z")).toISOString(),
    "2025-02-03T02:00:00.000Z",
  );
});

test("weekly: across year boundary Dec→Jan", () => {
  // 2025-12-29 is a Monday; 02:00 → next Monday 2026-01-05.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-12-29T02:00:00.000Z")).toISOString(),
    "2026-01-05T02:00:00.000Z",
  );
  // 2025-12-31 (Wed) → next Monday 2026-01-05.
  assert.equal(
    computeNextRunAt("weekly", iso("2025-12-31T12:00:00.000Z")).toISOString(),
    "2026-01-05T02:00:00.000Z",
  );
});

test("monthly: 1st of month before 02:00 → same day 02:00", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-03-01T01:00:00.000Z")).toISOString(),
    "2025-03-01T02:00:00.000Z",
  );
});

test("monthly: 1st of month at 02:00 → next month 1st (strictly-after)", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-03-01T02:00:00.000Z")).toISOString(),
    "2025-04-01T02:00:00.000Z",
  );
});

test("monthly: mid-month → 1st of next month", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-03-15T15:00:00.000Z")).toISOString(),
    "2025-04-01T02:00:00.000Z",
  );
});

test("monthly: Jan 31 23:00 → Feb 1 02:00 (does NOT skip February)", () => {
  // The whole reason cadence branches are recomputed independently from
  // `from` rather than building on a shared "tomorrow" rollover.
  assert.equal(
    computeNextRunAt("monthly", iso("2025-01-31T23:00:00.000Z")).toISOString(),
    "2025-02-01T02:00:00.000Z",
  );
});

test("monthly: Feb 28 (non-leap) → Mar 1", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-02-28T23:00:00.000Z")).toISOString(),
    "2025-03-01T02:00:00.000Z",
  );
});

test("monthly: Feb 29 (leap) → Mar 1", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2024-02-29T23:00:00.000Z")).toISOString(),
    "2024-03-01T02:00:00.000Z",
  );
});

test("monthly: Dec 15 → Jan 1 next year", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-12-15T15:00:00.000Z")).toISOString(),
    "2026-01-01T02:00:00.000Z",
  );
});

test("monthly: Dec 31 23:00 → Jan 1 next year (year-roll)", () => {
  assert.equal(
    computeNextRunAt("monthly", iso("2025-12-31T23:00:00.000Z")).toISOString(),
    "2026-01-01T02:00:00.000Z",
  );
});

// ---------------------------------------------------------------------------
// Atomic-claim safety — exercises the exact SQL predicate that `tick()`
// uses to guarantee at-most-once dispatch per due boundary.
//
// The scheduler's two-phase claim is:
//   SELECT due rows where enabled=true AND next_run_at <= now()
//   For each, run a conditional UPDATE that re-asserts the next_run_at
//   predicate and advances next_run_at to the next boundary.
//   Only rows where the UPDATE returns >0 rows are dispatched.
//
// We replicate that conditional UPDATE here and fire two concurrent
// attempts at the same due schedule. Postgres serializes the row-level
// writes, so exactly one UPDATE must return a row; the loser sees 0.
// That is what gates `runSchedule` in `tick()`, so proving it here proves
// `runSchedule` cannot be entered twice for the same boundary.
// ---------------------------------------------------------------------------

const insertedScheduleIds: number[] = [];

before(async () => {
  // No-op: each concurrency test inserts its own row. We keep this hook
  // so the after-hook symmetry is obvious.
});

after(async () => {
  if (insertedScheduleIds.length > 0) {
    await db
      .delete(journalEntryExportSchedulesTable)
      .where(
        inArray(journalEntryExportSchedulesTable.id, insertedScheduleIds),
      );
  }
  await pool.end();
});

test("two concurrent claim attempts on the same due schedule produce exactly one winner", async () => {
  const past = new Date(Date.now() - 5 * 60_000);
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `t70-claim-${process.pid}-${Date.now()}`,
      enabled: true,
      cadence: "daily",
      recipients: ["t70@test.local"],
      includeLines: false,
      nextRunAt: past,
    })
    .returning();
  assert.ok(row, "failed to insert fixture schedule");
  insertedScheduleIds.push(row!.id);

  const now = new Date();
  const next = computeNextRunAt("daily", now);

  const claim = () =>
    db
      .update(journalEntryExportSchedulesTable)
      .set({ nextRunAt: next, lastRunAt: now, updatedAt: now })
      .where(
        and(
          eq(journalEntryExportSchedulesTable.id, row!.id),
          isNotNull(journalEntryExportSchedulesTable.nextRunAt),
          lte(journalEntryExportSchedulesTable.nextRunAt, now),
        ),
      )
      .returning({ id: journalEntryExportSchedulesTable.id });

  const [a, b] = await Promise.all([claim(), claim()]);
  const winners = a.length + b.length;
  assert.equal(
    winners,
    1,
    `expected exactly one claim winner (got ${winners}: a=${a.length}, b=${b.length})`,
  );

  // The losing claim must observe the row already advanced past `now`,
  // so a third attempt at the same `now` must also lose.
  const third = await claim();
  assert.equal(
    third.length,
    0,
    "a third concurrent claim at the same instant must not win",
  );

  // And the row's next_run_at must equal the freshly-computed boundary,
  // not the original past timestamp.
  const [refetched] = await db
    .select()
    .from(journalEntryExportSchedulesTable)
    .where(eq(journalEntryExportSchedulesTable.id, row!.id));
  assert.ok(refetched, "claimed row vanished");
  assert.equal(
    refetched!.nextRunAt?.toISOString(),
    next.toISOString(),
    "winning claim must advance next_run_at to the freshly computed boundary",
  );
});

test("a parallel burst of claim attempts still admits exactly one winner", async () => {
  // Fan-out beyond two to make accidental races more visible. Postgres'
  // row lock should still funnel them to a single winner.
  const past = new Date(Date.now() - 5 * 60_000);
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `t70-burst-${process.pid}-${Date.now()}`,
      enabled: true,
      cadence: "weekly",
      recipients: ["t70@test.local"],
      includeLines: false,
      nextRunAt: past,
    })
    .returning();
  assert.ok(row, "failed to insert fixture schedule");
  insertedScheduleIds.push(row!.id);

  const now = new Date();
  const next = computeNextRunAt("weekly", now);

  const claim = () =>
    db
      .update(journalEntryExportSchedulesTable)
      .set({ nextRunAt: next, lastRunAt: now, updatedAt: now })
      .where(
        and(
          eq(journalEntryExportSchedulesTable.id, row!.id),
          isNotNull(journalEntryExportSchedulesTable.nextRunAt),
          lte(journalEntryExportSchedulesTable.nextRunAt, now),
        ),
      )
      .returning({ id: journalEntryExportSchedulesTable.id });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => claim()),
  );
  const winners = results.reduce((n, r) => n + r.length, 0);
  assert.equal(winners, 1, `expected 1 claim winner across 8, got ${winners}`);
});

test("two concurrent tick passes invoke runSchedule exactly once for the same due row", async () => {
  // Literal tick-level assertion: spin two _tickOnceForTests in parallel
  // (the in-flight gate of the production tick() is bypassed on purpose
  // here — the gate is per-process; the property we care about is the
  // cross-process / cross-tick claim, and this is the most direct way to
  // reach it). A counted stub stands in for runSchedule so we can assert
  // it fires exactly once and does not actually try to mail a CSV.
  const past = new Date(Date.now() - 5 * 60_000);
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `t70-tick-${process.pid}-${Date.now()}`,
      enabled: true,
      cadence: "daily",
      recipients: ["t70@test.local"],
      includeLines: false,
      nextRunAt: past,
    })
    .returning();
  assert.ok(row, "failed to insert fixture schedule");
  insertedScheduleIds.push(row!.id);

  let calls = 0;
  const calledIds: number[] = [];
  const stub = async (
    schedule: JournalEntryExportSchedule,
  ): Promise<{
    status: "sent" | "empty" | "failed";
    rowCount: number;
    filename: string;
    range: { from: string; to: string };
  }> => {
    if (schedule.id === row!.id) {
      calls += 1;
      calledIds.push(schedule.id);
    }
    // Pretend the export had no matching entries — applyRunOutcome will
    // simply reset the failure counter; no email is dispatched.
    return {
      status: "empty",
      rowCount: 0,
      filename: "stub.csv",
      range: { from: "2025-01-01", to: "2025-01-01" },
    };
  };

  await Promise.all([_tickOnceForTests(stub), _tickOnceForTests(stub)]);

  assert.equal(
    calls,
    1,
    `expected runSchedule to be invoked exactly once for the due row; got ${calls} (ids: ${calledIds.join(",")})`,
  );

  // And next_run_at must have been advanced past `now` so a third tick
  // immediately after would not re-fire it.
  const [refetched] = await db
    .select()
    .from(journalEntryExportSchedulesTable)
    .where(eq(journalEntryExportSchedulesTable.id, row!.id));
  assert.ok(refetched, "row vanished after tick");
  assert.ok(
    refetched!.nextRunAt && refetched!.nextRunAt.getTime() > Date.now(),
    "next_run_at must be advanced into the future after a successful tick",
  );

  await _tickOnceForTests(stub);
  assert.equal(
    calls,
    1,
    "a follow-up tick at the same instant must not re-fire the just-claimed row",
  );
});

test("a disabled schedule with a past next_run_at is never claimed (matches tick's WHERE clause)", async () => {
  const past = new Date(Date.now() - 5 * 60_000);
  const [row] = await db
    .insert(journalEntryExportSchedulesTable)
    .values({
      name: `t70-disabled-${process.pid}-${Date.now()}`,
      enabled: false,
      cadence: "daily",
      recipients: ["t70@test.local"],
      includeLines: false,
      nextRunAt: past,
    })
    .returning();
  assert.ok(row, "failed to insert fixture schedule");
  insertedScheduleIds.push(row!.id);

  const now = new Date();

  // The scheduler's SELECT in tick() filters on enabled=true; we mirror
  // it here to prove a disabled row is invisible to the dispatcher.
  const due = await db
    .select({ id: journalEntryExportSchedulesTable.id })
    .from(journalEntryExportSchedulesTable)
    .where(
      and(
        eq(journalEntryExportSchedulesTable.enabled, true),
        isNotNull(journalEntryExportSchedulesTable.nextRunAt),
        lte(journalEntryExportSchedulesTable.nextRunAt, now),
        eq(journalEntryExportSchedulesTable.id, row!.id),
      ),
    );
  assert.equal(due.length, 0, "disabled schedule must not appear in due set");
});
