import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const uploadedObjectsTable = pgTable("uploaded_objects", {
  id: serial("id").primaryKey(),
  objectPath: text("object_path").notNull().unique(),
  uploadedBy: integer("uploaded_by").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UploadedObject = typeof uploadedObjectsTable.$inferSelect;
export type InsertUploadedObject = typeof uploadedObjectsTable.$inferInsert;
