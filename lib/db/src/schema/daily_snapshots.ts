import { pgTable, serial, date, jsonb, timestamp } from "drizzle-orm/pg-core";

export const dailySnapshotsTable = pgTable("daily_snapshots", {
  id: serial("id").primaryKey(),
  snapshotDate: date("snapshot_date").notNull().unique(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DailySnapshot = typeof dailySnapshotsTable.$inferSelect;
export type InsertDailySnapshot = typeof dailySnapshotsTable.$inferInsert;
