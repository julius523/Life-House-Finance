import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const emailSettingsTable = pgTable("email_settings", {
  id: integer("id").primaryKey().default(1),
  senderName: text("sender_name")
    .notNull()
    .default("Life House Finance Portal"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const emailTemplatesTable = pgTable("email_templates", {
  type: text("type").primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EmailSettings = typeof emailSettingsTable.$inferSelect;
export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;
