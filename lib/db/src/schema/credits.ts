import { pgTable, text, serial, integer, numeric, timestamp, date } from "drizzle-orm/pg-core";
import { programsTable } from "./programs";

export const CREDIT_STATUSES = [
  "pipeline",
  "received",
  "delayed",
  "write-off",
  "opportunity",
] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const creditsTable = pgTable("credits", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  programId: integer("program_id").references(() => programsTable.id, {
    onDelete: "set null",
  }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  expectedDate: date("expected_date"),
  receivedDate: date("received_date"),
  status: text("status").notNull().default("pipeline"),
  notes: text("notes"),
  submittedBy: text("submitted_by"),
  // Idempotency key for automation callers (e.g. "lifehouse-claim:<uuid>")
  // — lets an external system upsert the same logical credit (created
  // once, status updated later as it moves through its own pipeline)
  // instead of creating a duplicate row on every sync. Null for
  // manually-entered credits.
  externalRef: text("external_ref").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Credit = typeof creditsTable.$inferSelect;
export type InsertCredit = typeof creditsTable.$inferInsert;
