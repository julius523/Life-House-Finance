import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { programsTable } from "./programs";

export const programContactsTable = pgTable("program_contacts", {
  id: serial("id").primaryKey(),
  programId: integer("program_id")
    .notNull()
    .references(() => programsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ProgramContact = typeof programContactsTable.$inferSelect;
