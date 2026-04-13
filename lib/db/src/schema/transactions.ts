import { pgTable, text, serial, numeric, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  externalId: text("external_id"),
  bankAccountId: integer("bank_account_id"),
  bankAccountName: text("bank_account_name"),
  transactionDate: date("transaction_date").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("unmatched"),
  matchedExpenseId: integer("matched_expense_id"),
  matchedBillId: integer("matched_bill_id"),
  notes: text("notes"),
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, importedAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
