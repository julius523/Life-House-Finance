import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { copilotMessagesTable } from "./copilot_messages";
import { copilotDocumentChunksTable } from "./copilot_document_chunks";
import { copilotDocumentsTable } from "./copilot_documents";

export const copilotMessageSourcesTable = pgTable(
  "copilot_message_sources",
  {
    id: serial("id").primaryKey(),
    assistantMessageId: integer("assistant_message_id")
      .notNull()
      .references(() => copilotMessagesTable.id, { onDelete: "cascade" }),
    chunkId: integer("chunk_id")
      .notNull()
      .references(() => copilotDocumentChunksTable.id, { onDelete: "restrict" }),
    documentId: integer("document_id")
      .notNull()
      .references(() => copilotDocumentsTable.id, { onDelete: "restrict" }),
    snippetText: text("snippet_text").notNull(),
    documentTitle: text("document_title").notNull(),
    snippetId: text("snippet_id").notNull(),
    rank: numeric("rank", { precision: 8, scale: 6 }),
    whyRelevant: text("why_relevant"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("copilot_message_sources_msg_idx").on(table.assistantMessageId),
  ],
);

export type CopilotMessageSourceRow =
  typeof copilotMessageSourcesTable.$inferSelect;
