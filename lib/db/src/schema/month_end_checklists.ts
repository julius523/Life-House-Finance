import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const monthEndChecklistsTable = pgTable("month_end_checklists", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(),
  fiscalYear: text("fiscal_year").notNull(),
  status: text("status").notNull().default("open"),
  owner: text("owner"),
  items: jsonb("items").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
});

export const insertMonthEndChecklistSchema = createInsertSchema(monthEndChecklistsTable).omit({ id: true, createdAt: true });
export type InsertMonthEndChecklist = z.infer<typeof insertMonthEndChecklistSchema>;
export type MonthEndChecklist = typeof monthEndChecklistsTable.$inferSelect;
