import { pgTable, text, serial, integer, timestamp, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  description: text("description").notNull(),
  actor: text("actor").notNull(),
  /**
   * Task #29B — structured actor user id for audit trail. Nullable for
   * historical rows that pre-date this column and for system-emitted
   * events with no human actor. New event types (manual_je_draft_*,
   * journal_entry_posted, journal_entry_reversed) are required to
   * populate this so an auditor can join activity_log → users without
   * parsing the free-text `actor` display string.
   */
  actorUserId: integer("actor_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  referenceId: integer("reference_id"),
  referenceType: text("reference_type"),
  /**
   * Task #29B — optional structured payload for cross-entity references
   * (e.g. a posted-draft event references both the draft via
   * `referenceId` and the resulting journal entry via
   * `metadata.journalEntryId`). Free-form jsonb so future event types
   * can attach extra context without schema churn.
   */
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertActivityLogSchema = createInsertSchema(activityLogTable).omit({ id: true, createdAt: true });
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogTable.$inferSelect;
