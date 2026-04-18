import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const copilotDocumentsTable = pgTable(
  "copilot_documents",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    content: text("content").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: integer("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("copilot_documents_active_idx").on(table.isActive)],
);

export type CopilotDocumentRow = typeof copilotDocumentsTable.$inferSelect;
