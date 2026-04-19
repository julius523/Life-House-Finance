import {
  db,
  journalEntryExportSchedulesTable,
  journalEntryExportSendLogTable,
  activityLogTable,
  usersTable,
  type JournalEntryExportSchedule,
  type ExportCadence,
} from "@workspace/db";
import { eq, lte, isNotNull, and } from "drizzle-orm";
import { logger } from "./logger";
import { generateJournalEntryCsv } from "./journalEntryCsvService";
import { createNotification, deliverEmail } from "./notifications";

/**
 * Task #68 — number of consecutive failed runs that will auto-pause the
 * schedule. Picked at 3 so a transient SendGrid blip doesn't disable a
 * working schedule, but a genuinely broken config (bad recipient, blocked
 * attachment, quota exhausted) is caught quickly without spamming.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Task #49 — Background scheduler that emits the configured CSV
 * exports of journal entries on their cadence (daily / weekly /
 * monthly). Runs in-process via setInterval — there is no external
 * cron daemon. A single process is expected; if the deployment ever
 * scales out, the atomic-claim UPDATE below ensures duplicate ticks
 * cannot double-send.
 *
 * Run hour: 02:00 UTC. Boundaries below are computed off that anchor
 * so a daily schedule created at any time today fires next at 02:00
 * UTC tomorrow, not 24h from creation.
 */

const TICK_INTERVAL_MS = 60_000;
const RUN_HOUR_UTC = 2;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Compute the next firing instant strictly after `from` for the cadence.
 *
 * Anchored at 02:00 UTC. Each branch is computed independently from `from`
 * (no shared day-roll) so monthly never accidentally skips a month at
 * month-end. Examples:
 *   - daily  : from 2025-01-31T23:00Z → 2025-02-01T02:00Z
 *   - weekly : from 2025-01-06T02:00Z (Mon)  → 2025-01-13T02:00Z (next Mon)
 *   - monthly: from 2025-01-31T23:00Z → 2025-02-01T02:00Z (NOT March)
 */
export function computeNextRunAt(cadence: ExportCadence, from: Date): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const day = from.getUTCDate();

  if (cadence === "daily") {
    const today = new Date(Date.UTC(y, m, day, RUN_HOUR_UTC));
    if (today.getTime() > from.getTime()) return today;
    return new Date(Date.UTC(y, m, day + 1, RUN_HOUR_UTC));
  }

  if (cadence === "weekly") {
    // getUTCDay(): Sun=0..Sat=6; we anchor to Monday=1.
    const today = new Date(Date.UTC(y, m, day, RUN_HOUR_UTC));
    const dow = from.getUTCDay();
    if (dow === 1 && today.getTime() > from.getTime()) return today;
    let daysAhead = (1 - dow + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    return new Date(Date.UTC(y, m, day + daysAhead, RUN_HOUR_UTC));
  }

  // monthly — 1st of (this month if still in future, else next month) at 02:00 UTC.
  if (day === 1) {
    const today = new Date(Date.UTC(y, m, 1, RUN_HOUR_UTC));
    if (today.getTime() > from.getTime()) return today;
  }
  return new Date(Date.UTC(y, m + 1, 1, RUN_HOUR_UTC));
}

/** Inclusive [from, to] YYYY-MM-DD window the scheduler exports for `runAt`. */
export function computeExportRange(
  cadence: ExportCadence,
  runAt: Date,
): { from: string; to: string } {
  const yyyy = (n: number) => n.toString().padStart(4, "0");
  const mm = (n: number) => n.toString().padStart(2, "0");
  const fmt = (d: Date) =>
    `${yyyy(d.getUTCFullYear())}-${mm(d.getUTCMonth() + 1)}-${mm(d.getUTCDate())}`;

  // Yesterday (UTC) is always the upper bound — never include the
  // current day, since postings may still arrive during the day.
  const yesterday = new Date(
    Date.UTC(
      runAt.getUTCFullYear(),
      runAt.getUTCMonth(),
      runAt.getUTCDate() - 1,
    ),
  );

  if (cadence === "daily") {
    return { from: fmt(yesterday), to: fmt(yesterday) };
  }
  if (cadence === "weekly") {
    const start = new Date(yesterday);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: fmt(start), to: fmt(yesterday) };
  }
  // monthly — previous calendar month
  const firstOfThisMonth = new Date(
    Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), 1),
  );
  const lastOfPrev = new Date(firstOfThisMonth);
  lastOfPrev.setUTCDate(0);
  const firstOfPrev = new Date(
    Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1),
  );
  return { from: fmt(firstOfPrev), to: fmt(lastOfPrev) };
}

function isExportCadence(value: unknown): value is ExportCadence {
  return value === "daily" || value === "weekly" || value === "monthly";
}

/**
 * Run a single schedule end-to-end: build the CSV for the cadence
 * window, email it, log the attempt. Used by both the tick loop and
 * the manual "Run now" admin button.
 */
export async function runSchedule(
  schedule: JournalEntryExportSchedule,
  options: {
    triggeredBy: "schedule" | "manual";
    triggeredByUserId?: number | null;
    runAt?: Date;
  },
): Promise<{
  status: "sent" | "empty" | "failed";
  rowCount: number;
  filename: string;
  range: { from: string; to: string };
  error?: string;
}> {
  const runAt = options.runAt ?? new Date();
  if (!isExportCadence(schedule.cadence)) {
    const error = `Invalid cadence: ${schedule.cadence}`;
    logger.error({ scheduleId: schedule.id, error }, error);
    return {
      status: "failed",
      rowCount: 0,
      filename: "",
      range: { from: "", to: "" },
      error,
    };
  }
  const range = computeExportRange(schedule.cadence, runAt);
  const filterStatus =
    schedule.filterStatus === "posted" || schedule.filterStatus === "reversed"
      ? schedule.filterStatus
      : null;
  const filterSource =
    schedule.filterSource === "copilot" ||
    schedule.filterSource === "manual" ||
    schedule.filterSource === "expense" ||
    schedule.filterSource === "bill"
      ? schedule.filterSource
      : null;

  let status: "sent" | "empty" | "failed" = "failed";
  let rowCount = 0;
  let filename = "";
  let errorMessage: string | undefined;

  try {
    const result = await generateJournalEntryCsv({
      status: filterStatus,
      source: filterSource,
      from: range.from,
      to: range.to,
      includeLines: schedule.includeLines,
    });
    if (!result.ok) {
      throw new Error(
        `Export would exceed ${result.max} entries; narrow filters.`,
      );
    }
    rowCount = result.rowCount;
    // Use scheduled-export naming so the attached file is recognizable
    // independent of the on-demand download naming convention.
    filename = `journal-entries-${range.from}_to_${range.to}${
      schedule.includeLines ? "-with-lines" : ""
    }.csv`;

    if (rowCount === 0) {
      status = "empty";
      // Still email so reviewers know the schedule fired (zero-row
      // weeks are themselves a useful signal).
    }

    const subject = `[Life House] Journal entries ${range.from}${
      range.from === range.to ? "" : ` to ${range.to}`
    } (${rowCount} entr${rowCount === 1 ? "y" : "ies"})`;
    const body =
      `Scheduled CSV export for "${schedule.name}".\n\n` +
      `Cadence: ${schedule.cadence}\n` +
      `Date range: ${range.from} → ${range.to}\n` +
      `Status filter: ${filterStatus ?? "all"}\n` +
      `Source filter: ${filterSource ?? "all"}\n` +
      `Include lines: ${schedule.includeLines ? "yes" : "no"}\n` +
      `Entries in export: ${rowCount}\n\n` +
      (rowCount === 0
        ? "No journal entries matched the filters in this period. The attached CSV contains only the header row.\n"
        : "The CSV is attached.\n");

    const csvBase64 = Buffer.from(result.csv, "utf-8").toString("base64");

    const delivery = await deliverEmail({
      to: schedule.recipients,
      subject,
      body,
      // SendGrid rejects ';' or CRLF in the attachment MIME type field,
      // so use the bare type — the CSV bytes already start with a UTF-8
      // BOM which Excel/Sheets honor for encoding detection.
      attachments: [
        { filename, type: "text/csv", contentBase64: csvBase64 },
      ],
    });

    if (delivery.status === "failed") {
      status = "failed";
      errorMessage = delivery.error ?? "Email delivery failed";
    } else if (delivery.status === "not_attempted") {
      status = "failed";
      errorMessage = delivery.reason ?? "Email not configured";
    } else if (rowCount > 0) {
      status = "sent";
    }
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, scheduleId: schedule.id },
      "Journal-entry export run failed",
    );
  }

  await db.insert(journalEntryExportSendLogTable).values({
    scheduleId: schedule.id,
    recipients: schedule.recipients,
    rowCount,
    rangeFrom: range.from,
    rangeTo: range.to,
    status,
    errorMessage: errorMessage ?? null,
    filename: filename || `journal-entries-${range.from}_to_${range.to}.csv`,
    triggeredBy: options.triggeredBy,
    triggeredByUserId: options.triggeredByUserId ?? null,
  });

  await db.insert(activityLogTable).values({
    type: "journal_export_run",
    description:
      `Scheduled CSV export "${schedule.name}" — ${status}` +
      ` (${rowCount} entries, ${range.from} → ${range.to})`,
    actor: options.triggeredBy === "manual" ? "admin" : "system",
    referenceId: schedule.id,
    referenceType: "journal_entry_export_schedule",
  });

  return {
    status,
    rowCount,
    filename,
    range,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

/**
 * Task #68 — apply the result of a run to the schedule row.
 *
 * - sent / empty → reset the consecutive-failure counter (and clear any
 *   prior auto-pause marker; an admin-initiated re-enable already cleared
 *   it, but this keeps the row consistent if a flaky transport recovers).
 * - failed       → bump the counter, and once we hit
 *   MAX_CONSECUTIVE_FAILURES disable the schedule, null out next_run_at,
 *   and notify every admin so they're not surprised by silence.
 *
 * This is shared by the scheduler tick and the manual "Run now" path so
 * both observe identical pause semantics — admins testing a broken send
 * shouldn't be able to thrash a row past the threshold without it pausing.
 */
export async function applyRunOutcome(
  schedule: JournalEntryExportSchedule,
  result: { status: "sent" | "empty" | "failed"; error?: string },
): Promise<void> {
  const now = new Date();
  if (result.status === "failed") {
    const nextCount = (schedule.consecutiveFailureCount ?? 0) + 1;
    const shouldPause = nextCount >= MAX_CONSECUTIVE_FAILURES;
    const reason = result.error ?? "Email delivery failed";
    await db
      .update(journalEntryExportSchedulesTable)
      .set({
        lastRunStatus: result.status,
        lastRunError: result.error ?? null,
        consecutiveFailureCount: nextCount,
        ...(shouldPause
          ? {
              enabled: false,
              nextRunAt: null,
              autoPausedAt: now,
              autoPausedReason: reason,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(journalEntryExportSchedulesTable.id, schedule.id));
    if (shouldPause) {
      await onScheduleAutoPaused(schedule, nextCount, reason);
    }
    return;
  }
  // success / empty → reset failure tracking. Preserve the auto-pause
  // marker when the schedule is currently disabled (e.g. an admin
  // manually "Run now"s an auto-paused row to test the fix); the banner
  // should keep nagging until they explicitly re-enable.
  await db
    .update(journalEntryExportSchedulesTable)
    .set({
      lastRunStatus: result.status,
      lastRunError: null,
      consecutiveFailureCount: 0,
      ...(schedule.enabled
        ? { autoPausedAt: null, autoPausedReason: null }
        : {}),
      updatedAt: now,
    })
    .where(eq(journalEntryExportSchedulesTable.id, schedule.id));
}

async function onScheduleAutoPaused(
  schedule: JournalEntryExportSchedule,
  failureCount: number,
  reason: string,
): Promise<void> {
  logger.warn(
    { scheduleId: schedule.id, failureCount, reason },
    "Auto-paused journal-entry export schedule after consecutive failures",
  );
  await db.insert(activityLogTable).values({
    type: "journal_export_auto_paused",
    description:
      `Scheduled CSV export "${schedule.name}" auto-paused after ` +
      `${failureCount} consecutive failures: ${reason}`,
    actor: "system",
    referenceId: schedule.id,
    referenceType: "journal_entry_export_schedule",
  });
  try {
    const admins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    const title = `CSV export "${schedule.name}" auto-paused`;
    const body =
      `The scheduled journal-entry CSV export "${schedule.name}" failed ` +
      `${failureCount} times in a row and was paused so we stop retrying ` +
      `the same broken send. Last error: ${reason}. Re-enable the ` +
      `schedule to clear the failure counter and resume.`;
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        type: "journal_export_auto_paused",
        title,
        body,
        link: "/accounting/journal-export-schedules",
        referenceType: "journal_entry_export_schedule",
        referenceId: schedule.id,
      });
    }
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id },
      "Failed to notify admins about auto-paused export schedule",
    );
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = new Date();
    // Two-phase claim: first list due rows, then for each row run a
    // conditional UPDATE that advances next_run_at to the *correctly
    // computed* next boundary. The UPDATE's WHERE includes the
    // pre-claim next_run_at predicate, so only one process / one tick
    // wins; if it returns 0 rows, another worker already claimed the
    // schedule and we skip. Critically, even if the process crashes
    // between this UPDATE and runSchedule(), the row simply does not
    // re-fire until the legitimate next boundary — bounded skip, no
    // year-long stranding (vs. a sentinel approach), and no double-send.
    const due = await db
      .select()
      .from(journalEntryExportSchedulesTable)
      .where(
        and(
          eq(journalEntryExportSchedulesTable.enabled, true),
          isNotNull(journalEntryExportSchedulesTable.nextRunAt),
          lte(journalEntryExportSchedulesTable.nextRunAt, now),
        ),
      );

    for (const schedule of due) {
      if (!isExportCadence(schedule.cadence)) {
        logger.error(
          { scheduleId: schedule.id, cadence: schedule.cadence },
          "Skipping schedule with invalid cadence; admin must edit/fix",
        );
        // Stamp last_run_* so the row is visibly broken in the UI but
        // do NOT advance next_run_at (so the admin's fix takes effect
        // immediately).
        await db
          .update(journalEntryExportSchedulesTable)
          .set({
            lastRunAt: now,
            lastRunStatus: "failed",
            lastRunError: `Invalid cadence: ${schedule.cadence}`,
            updatedAt: now,
          })
          .where(eq(journalEntryExportSchedulesTable.id, schedule.id));
        continue;
      }
      const nextRun = computeNextRunAt(schedule.cadence, now);
      const claimed = await db
        .update(journalEntryExportSchedulesTable)
        .set({ nextRunAt: nextRun, lastRunAt: now, updatedAt: now })
        .where(
          and(
            eq(journalEntryExportSchedulesTable.id, schedule.id),
            isNotNull(journalEntryExportSchedulesTable.nextRunAt),
            lte(journalEntryExportSchedulesTable.nextRunAt, now),
          ),
        )
        .returning({ id: journalEntryExportSchedulesTable.id });
      if (claimed.length === 0) continue;

      const result = await runSchedule(schedule, {
        triggeredBy: "schedule",
        runAt: now,
      });
      await applyRunOutcome(schedule, result);
    }
  } catch (err) {
    logger.error({ err }, "Journal-entry export scheduler tick failed");
  } finally {
    inFlight = false;
  }
}

export function startJournalEntryExportScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  // Don't keep the event loop alive solely for the timer.
  if (typeof timer.unref === "function") timer.unref();
  logger.info(
    { intervalMs: TICK_INTERVAL_MS },
    "Journal-entry export scheduler started",
  );
}

export function stopJournalEntryExportSchedulerForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
