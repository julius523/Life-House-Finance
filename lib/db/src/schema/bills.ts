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
  // Task #63 — expense category drives the Dr expense leg of the accrual draft.
  // Nullable for legacy/uncategorized bills; in that case the bridge blocks
  // with reason='missing_category' so finance can fix it.
  categoryId: integer("category_id"),
  status: text("status").notNull().default("draft"),
  approvedBy: text("approved_by"),
  rejectionReason: text("rejection_reason"),
  paidDate: date("paid_date"),
  receiptIds: integer("receipt_ids").array(),
  // Task #63 — accounting bridge bookkeeping (mirrors expenses.* fields).
  // Two parallel legs because a bill produces TWO drafts over its lifecycle:
  //   accrual: at approval (Dr expense / Cr A/P)
  //   payment: at payment (Dr A/P / Cr cash)
  // 'pending' = no attempt yet, 'draft_created' = linked to manual draft,
  // 'blocked' = generator failed, 'not_applicable' = finance opted out.
  accountingStatus: text("accounting_status").notNull().default("pending"),
  accountingBlockReason: text("accounting_block_reason"),
  accountingGeneratedAt: timestamp("accounting_generated_at"),
  accountingPaymentStatus: text("accounting_payment_status")
    .notNull()
    .default("pending"),
  accountingPaymentBlockReason: text("accounting_payment_block_reason"),
  accountingPaymentGeneratedAt: timestamp("accounting_payment_generated_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, createdAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
