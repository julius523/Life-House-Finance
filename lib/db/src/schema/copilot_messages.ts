import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { copilotThreadsTable } from "./copilot_threads";

export const COPILOT_MESSAGE_ROLES = ["user", "assistant"] as const;
export type CopilotMessageRole = (typeof COPILOT_MESSAGE_ROLES)[number];

export const COPILOT_MESSAGE_STATUSES = ["ok", "error"] as const;
export type CopilotMessageStatus = (typeof COPILOT_MESSAGE_STATUSES)[number];

export const COPILOT_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type CopilotConfidence = (typeof COPILOT_CONFIDENCE_LEVELS)[number];

export const copilotMessagesTable = pgTable(
  "copilot_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => copilotThreadsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("ok"),
    userText: text("user_text"),
    answer: text("answer"),
    why: text("why"),
    missingInformation: text("missing_information"),
    riskFlags: text("risk_flags"),
    recommendedNextStep: text("recommended_next_step"),
    humanReviewNeeded: boolean("human_review_needed"),
    confidence: text("confidence"),
    rawResponseJson: jsonb("raw_response_json"),
    pageContext: jsonb("page_context"),
    modelName: text("model_name"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("copilot_messages_thread_id_idx").on(table.threadId, table.id),
    index("copilot_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

export type CopilotMessageRow = typeof copilotMessagesTable.$inferSelect;
