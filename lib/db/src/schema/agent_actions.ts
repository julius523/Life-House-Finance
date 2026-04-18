import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { copilotThreadsTable } from "./copilot_threads";
import { copilotMessagesTable } from "./copilot_messages";
import { usersTable } from "./users";

/**
 * Step 6 — Drafting & human-approval workflow.
 *
 * Every drafting/escalation tool the copilot can call writes one row here.
 * Nothing in this table mutates the financial ledger by itself; downstream
 * effects (e.g. creating a follow-up notification, posting a journal entry
 * — *the latter is NOT yet implemented*) only happen when an authorized
 * human flips status from pending_review -> approved via the approvals UI.
 */
export const agentActionsTable = pgTable(
  "agent_actions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    threadId: integer("thread_id")
      .notNull()
      .references(() => copilotThreadsTable.id, { onDelete: "cascade" }),
    /**
     * The assistant message this draft was attached to. Nullable because the
     * tool runs BEFORE the assistant message row is inserted; the route
     * handler back-fills it after the structured-response message is saved.
     */
    assistantMessageId: integer("assistant_message_id").references(
      () => copilotMessagesTable.id,
      { onDelete: "set null" },
    ),
    /**
     * One of: draft_journal_entry | draft_memo | create_followup_task | escalate_to_human
     */
    actionType: text("action_type").notNull(),
    /**
     * Tool-specific payload — what the copilot proposed.
     * draft_journal_entry: { date, memo, lines:[{type,amount,account,...}], totals, ... }
     * draft_memo: { topic, audience, body }
     * create_followup_task: { title, body, assignToUserId }
     * escalate_to_human: { reason, severity, referenceType, referenceId, notifiedUserIds }
     */
    payload: jsonb("payload").notNull(),
    /**
     * Evidence the copilot relied on: { sources:[{snippet_id, why_relevant}], why, missing_information }
     */
    evidence: jsonb("evidence"),
    confidence: text("confidence"), // low | medium | high
    riskFlags: text("risk_flags"),
    /**
     * Defensive flag — every row created by the copilot starts true. Only the
     * human approval workflow can effectively make a draft "actionable" (and
     * even then, downstream ledger posting is OUT OF SCOPE for Step 6).
     */
    requiresHumanReview: boolean("requires_human_review")
      .notNull()
      .default(true),
    /**
     * pending_review | approved | rejected | canceled
     */
    status: text("status").notNull().default("pending_review"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at"),
    reviewNotes: text("review_notes"),
  },
  (table) => [
    index("agent_actions_status_idx").on(table.status, table.createdAt),
    index("agent_actions_user_idx").on(table.userId),
    index("agent_actions_thread_idx").on(table.threadId),
    index("agent_actions_message_idx").on(table.assistantMessageId),
  ],
);

export type AgentActionRow = typeof agentActionsTable.$inferSelect;
export type AgentActionInsert = typeof agentActionsTable.$inferInsert;

export const AGENT_ACTION_TYPES = [
  "draft_journal_entry",
  "draft_memo",
  "create_followup_task",
  "escalate_to_human",
] as const;

export const AGENT_ACTION_STATUSES = [
  "pending_review",
  "approved",
  "rejected",
  "canceled",
] as const;
