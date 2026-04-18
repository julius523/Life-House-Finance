import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { copilotThreadsTable } from "./copilot_threads";
import { copilotMessagesTable } from "./copilot_messages";

export const COPILOT_TOOL_CALL_STATUSES = ["ok", "error"] as const;
export type CopilotToolCallStatus = (typeof COPILOT_TOOL_CALL_STATUSES)[number];

export const copilotToolCallsTable = pgTable(
  "copilot_tool_calls",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => copilotThreadsTable.id, { onDelete: "cascade" }),
    assistantMessageId: integer("assistant_message_id").references(
      () => copilotMessagesTable.id,
      { onDelete: "set null" },
    ),
    userId: integer("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments"),
    result: jsonb("result"),
    status: text("status").notNull().default("ok"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("copilot_tool_calls_thread_idx").on(table.threadId, table.id),
    index("copilot_tool_calls_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export type CopilotToolCallRow = typeof copilotToolCallsTable.$inferSelect;
