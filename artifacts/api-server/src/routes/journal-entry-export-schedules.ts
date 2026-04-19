/**
 * Task #49 — CRUD + run-now + send-log routes for scheduled CSV
 * exports of journal entries.
 *
 * All endpoints are admin-only. Mounted under /api/.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import {
  db,
  journalEntryExportSchedulesTable,
  journalEntryExportSendLogTable,
  EXPORT_CADENCES,
  EXPORT_FILTER_STATUSES,
  EXPORT_FILTER_SOURCES,
  type ExportCadence,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  applyRunOutcome,
  buildScheduleCsv,
  computeNextRunAt,
  runSchedule,
} from "../lib/journalEntryExportScheduler";

const router: IRouter = Router();
router.use("/journal-entry-export-schedules", requireAuth, requireRole("admin"));

// Email validation: SendGrid is strict; cap to a sensible recipient count
// per schedule so a typo'd config can't fan out to hundreds of inboxes.
const MAX_RECIPIENTS = 25;
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Each recipient must be a valid email address");

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  cadence: z.enum(EXPORT_CADENCES),
  recipients: z
    .array(emailSchema)
    .min(1, "At least one recipient is required")
    .max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients per schedule`),
  filterStatus: z.enum(EXPORT_FILTER_STATUSES).nullable().optional(),
  filterSource: z.enum(EXPORT_FILTER_SOURCES).nullable().optional(),
  // Task #71 — optional user filters (mirror the on-demand CSV download).
  // Reject 0 / negatives so the "Anyone" option must be expressed as
  // explicit null and the scheduler never tries to match user_id <= 0.
  filterPostedByUserId: z.number().int().positive().nullable().optional(),
  filterApproverUserId: z.number().int().positive().nullable().optional(),
  includeLines: z.boolean().default(false),
});

function dedupeRecipients(list: string[]): string[] {
  return Array.from(new Set(list));
}

router.get(
  "/journal-entry-export-schedules",
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(journalEntryExportSchedulesTable)
      .orderBy(
        desc(journalEntryExportSchedulesTable.enabled),
        desc(journalEntryExportSchedulesTable.createdAt),
      );
    res.json({ schedules: rows });
  },
);

router.post(
  "/journal-entry-export-schedules",
  async (req, res): Promise<void> => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid schedule",
        details: parsed.error.flatten(),
      });
      return;
    }
    const data = parsed.data;
    const cadence = data.cadence as ExportCadence;
    const now = new Date();
    const nextRunAt = data.enabled ? computeNextRunAt(cadence, now) : null;

    const [row] = await db
      .insert(journalEntryExportSchedulesTable)
      .values({
        name: data.name,
        enabled: data.enabled,
        cadence,
        recipients: dedupeRecipients(data.recipients),
        filterStatus: data.filterStatus ?? null,
        filterSource: data.filterSource ?? null,
        filterPostedByUserId: data.filterPostedByUserId ?? null,
        filterApproverUserId: data.filterApproverUserId ?? null,
        includeLines: data.includeLines,
        createdByUserId: req.authUser?.id ?? null,
        nextRunAt,
      })
      .returning();
    res.status(201).json({ schedule: row });
  },
);

router.patch(
  "/journal-entry-export-schedules/:id",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = upsertSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid schedule",
        details: parsed.error.flatten(),
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(journalEntryExportSchedulesTable)
      .where(eq(journalEntryExportSchedulesTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }

    const data = parsed.data;
    const next: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) next["name"] = data.name;
    if (data.recipients !== undefined)
      next["recipients"] = dedupeRecipients(data.recipients);
    if (data.filterStatus !== undefined)
      next["filterStatus"] = data.filterStatus ?? null;
    if (data.filterSource !== undefined)
      next["filterSource"] = data.filterSource ?? null;
    if (data.filterPostedByUserId !== undefined)
      next["filterPostedByUserId"] = data.filterPostedByUserId ?? null;
    if (data.filterApproverUserId !== undefined)
      next["filterApproverUserId"] = data.filterApproverUserId ?? null;
    if (data.includeLines !== undefined)
      next["includeLines"] = data.includeLines;

    // Recompute next_run_at when cadence or enabled toggle. Disabling
    // clears next_run_at so the scheduler ignores the row entirely.
    const newCadence = (data.cadence ?? existing.cadence) as ExportCadence;
    const newEnabled =
      data.enabled !== undefined ? data.enabled : existing.enabled;
    if (data.cadence !== undefined) next["cadence"] = newCadence;
    if (data.enabled !== undefined) next["enabled"] = newEnabled;
    if (data.cadence !== undefined || data.enabled !== undefined) {
      next["nextRunAt"] = newEnabled
        ? computeNextRunAt(newCadence, new Date())
        : null;
    }

    // Task #68 — re-enabling a schedule (whether it was admin-disabled or
    // auto-paused) clears the failure tracking so the next failure starts a
    // fresh run-of-3 toward auto-pause. Without this an auto-paused row would
    // re-pause itself after a single failure.
    if (data.enabled === true && existing.enabled === false) {
      next["consecutiveFailureCount"] = 0;
      next["autoPausedAt"] = null;
      next["autoPausedReason"] = null;
      next["lastRunError"] = null;
    }

    const [row] = await db
      .update(journalEntryExportSchedulesTable)
      .set(next)
      .where(eq(journalEntryExportSchedulesTable.id, id))
      .returning();
    res.json({ schedule: row });
  },
);

router.delete(
  "/journal-entry-export-schedules/:id",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db
      .delete(journalEntryExportSchedulesTable)
      .where(eq(journalEntryExportSchedulesTable.id, id))
      .returning({ id: journalEntryExportSchedulesTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    res.status(204).end();
  },
);

// Task #69 — Preview the CSV the next scheduled run would attach.
// Accepts an in-flight form payload (no DB row required) so admins can
// inspect their config before clicking Save. Goes through buildScheduleCsv
// so the bytes returned here are byte-identical to the bytes the
// scheduler would email for the same cadence + filters at this moment.
const previewSchema = z.object({
  cadence: z.enum(EXPORT_CADENCES),
  filterStatus: z.enum(EXPORT_FILTER_STATUSES).nullable().optional(),
  filterSource: z.enum(EXPORT_FILTER_SOURCES).nullable().optional(),
  filterPostedByUserId: z.number().int().positive().nullable().optional(),
  filterApproverUserId: z.number().int().positive().nullable().optional(),
  includeLines: z.boolean().default(false),
});

router.post(
  "/journal-entry-export-schedules/preview",
  async (req, res): Promise<void> => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid preview request",
        details: parsed.error.flatten(),
      });
      return;
    }
    const data = parsed.data;
    try {
      // Anchor the preview to the *next scheduled fire time*, not "now".
      // computeExportRange is relative to runAt — anchoring to "now" can
      // produce a different date window than the next real run (e.g. a
      // daily schedule previewed at 23:00 UTC would otherwise show
      // yesterday's window, but the next run at tomorrow 02:00 UTC will
      // export today's window). Using computeNextRunAt makes the preview
      // bytes match what the scheduler will actually email next.
      const cadence = data.cadence as ExportCadence;
      const nextRunAt = computeNextRunAt(cadence, new Date());
      const built = await buildScheduleCsv(
        {
          cadence: data.cadence,
          filterStatus: data.filterStatus ?? null,
          filterSource: data.filterSource ?? null,
          filterPostedByUserId: data.filterPostedByUserId ?? null,
          filterApproverUserId: data.filterApproverUserId ?? null,
          includeLines: data.includeLines,
        },
        nextRunAt,
      );
      if (!built.ok) {
        if (built.reason === "too_large") {
          res.status(413).json({
            error: `Preview would exceed ${built.max} entries. Narrow the filters and try again.`,
            code: "EXPORT_TOO_LARGE",
            max: built.max,
          });
          return;
        }
        res.status(400).json({ error: "Invalid cadence" });
        return;
      }
      // Surface the same metadata the scheduler logs so the UI can
      // show row count / range without re-parsing the CSV.
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${built.filename}"`,
      );
      res.setHeader("X-Preview-Row-Count", String(built.rowCount));
      res.setHeader("X-Preview-Range-From", built.range.from);
      res.setHeader("X-Preview-Range-To", built.range.to);
      res.send(built.csv);
    } catch (err) {
      logger.error({ err }, "Schedule CSV preview failed");
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

router.post(
  "/journal-entry-export-schedules/:id/run-now",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [schedule] = await db
      .select()
      .from(journalEntryExportSchedulesTable)
      .where(eq(journalEntryExportSchedulesTable.id, id));
    if (!schedule) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    try {
      const now = new Date();
      const result = await runSchedule(schedule, {
        triggeredBy: "manual",
        triggeredByUserId: req.authUser?.id ?? null,
        runAt: now,
      });
      // Stamp last_run_at + advance next_run_at first; applyRunOutcome
      // owns last_run_status / failure-counter / auto-pause book-keeping
      // so manual runs and scheduled runs follow the same rules
      // (Task #68 — manual "Run now" can also push a row past the
      // auto-pause threshold).
      await db
        .update(journalEntryExportSchedulesTable)
        .set({
          lastRunAt: now,
          updatedAt: now,
          ...(schedule.enabled
            ? {
                nextRunAt: computeNextRunAt(
                  schedule.cadence as ExportCadence,
                  now,
                ),
              }
            : {}),
        })
        .where(eq(journalEntryExportSchedulesTable.id, schedule.id));
      await applyRunOutcome(schedule, result);
      res.json({ result });
    } catch (err) {
      logger.error({ err, scheduleId: id }, "Manual run-now failed");
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

router.get(
  "/journal-entry-export-schedules/:id/log",
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query["limit"]) || 25),
    );
    const rows = await db
      .select()
      .from(journalEntryExportSendLogTable)
      .where(eq(journalEntryExportSendLogTable.scheduleId, id))
      .orderBy(desc(journalEntryExportSendLogTable.sentAt))
      .limit(limit);
    res.json({ entries: rows });
  },
);

export default router;
