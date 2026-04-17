import { pgTable, text, serial, numeric, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const billsTable = pgTable("bills", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull(),
  invoiceNumber: text("invoice_number"),
  invoiceDate: date("invoice_date"),
  dueDate: date("due_date").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  description: text("description"),
  submittedBy: text("submitted_by"),
  submittedByEmail: text("submitted_by_email"),
  programId: integer("program_id"),
  status: text("status").notNull().default("draft"),
  approvedBy: text("approved_by"),
  rejectionReason: text("rejection_reason"),
  paidDate: date("paid_date"),
  receiptIds: integer("receipt_ids").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, createdAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
