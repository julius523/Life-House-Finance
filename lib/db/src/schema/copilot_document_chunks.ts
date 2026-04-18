import {
  pgTable,
  text,
  serial,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { copilotDocumentsTable } from "./copilot_documents";

export const copilotDocumentChunksTable = pgTable(
  "copilot_document_chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => copilotDocumentsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
  },
  (table) => [
    index("copilot_document_chunks_doc_idx").on(table.documentId, table.chunkIndex),
  ],
);

export type CopilotDocumentChunkRow =
  typeof copilotDocumentChunksTable.$inferSelect;
