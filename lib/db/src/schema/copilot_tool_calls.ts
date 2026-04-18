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

// Step 7: status was extended with "denied" (role-scope rejection) and
// "preview" (admin-only diagnostics dry-run). Existing rows ("ok"/"error")
// remain valid.
export const COPILOT_TOOL_CALL_STATUSES = [
  "ok",
  "error",
  "denied",
  "preview",
] as const;
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
    /**
     * Step 7: when status='denied', this records the role-scope reason
     * (e.g. "Tool 'draft_journal_entry' is not available for role 'submitter'.").
     * Always null for status='ok' and usually null for status='error'.
     */
    deniedReason: text("denied_reason"),
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
