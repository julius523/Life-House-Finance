import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const copilotThreadsTable = pgTable(
  "copilot_threads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [
    index("copilot_threads_user_updated_idx").on(
      table.userId,
      table.updatedAt.desc(),
    ),
  ],
);

export type CopilotThreadRow = typeof copilotThreadsTable.$inferSelect;
