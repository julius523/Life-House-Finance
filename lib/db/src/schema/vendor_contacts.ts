import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const vendorContactsTable = pgTable("vendor_contacts", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VendorContact = typeof vendorContactsTable.$inferSelect;
