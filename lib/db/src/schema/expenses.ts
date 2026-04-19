import { pgTable, text, serial, numeric, timestamp, date, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  submittedBy: text("submitted_by").notNull(),
  submittedByEmail: text("submitted_by_email"),
  expenseDate: date("expense_date").notNull(),
  merchant: text("merchant").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  programId: integer("program_id"),
  status: text("status").notNull().default("draft"),
  managerApprovedBy: text("manager_approved_by"),
  financeApprovedBy: text("finance_approved_by"),
  rejectionReason: text("rejection_reason"),
  reimbursedDate: date("reimbursed_date"),
  receiptIds: integer("receipt_ids").array(),
  duplicateDismissed: boolean("duplicate_dismissed").notNull().default(false),
  accountingEntryRef: text("accounting_entry_ref"),
  /**
   * Task #51 — nullable FK into expense_categories. Backfilled to the
   * seeded "Uncategorized" row so legacy expenses do not break list
   * views; new expenses are required (validated at the API layer) to
   * pick a real category. Kept nullable in the DB so the seed/backfill
   * step can run idempotently and so we never lose an expense if its
   * category is hard-deleted (use FK ON DELETE SET NULL).
   */
  categoryId: integer("category_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type Expense = typeof expensesTable.$inferSelect;
