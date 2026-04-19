import { pgTable, text, serial, numeric, timestamp, date, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { expenseCategoriesTable } from "./expense_categories";

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
  // Task #51 — FK into expense_categories. ON DELETE SET NULL so an
  // expense is never lost if a category is hard-deleted; the boot-time
  // seed re-backfills any nulls to "Uncategorized" and the API requires
  // a category on new expense creation.
  categoryId: integer("category_id").references(
    () => expenseCategoriesTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type Expense = typeof expensesTable.$inferSelect;
