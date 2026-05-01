/**
 * Task #107 — shared authorization helpers for operational records
 * (expenses, bills, receipts) and master data (vendors, programs).
 *
 * These centralize two recurring decisions:
 *   - "Can the caller READ this record?" — admin/approver can read
 *     anything; submitters can only read records they own.
 *   - "Can the caller MUTATE this record?" — admin can do anything,
 *     approvers handle their workflow routes, submitters can only edit
 *     records they own AND only while those records are still in a
 *     mutable status (draft / submitted / needs_correction).
 *
 * Ownership is matched primarily by email because `expenses.submittedBy`
 * and `bills.submittedBy` are stored as TEXT (display name), not as
 * a foreign key into users. Both tables also carry a `submittedByEmail`
 * column, which is the durable identifier we trust. Where the email
 * column is NULL (legacy rows), we fall back to a case-insensitive
 * match on the display-name string `${firstName} ${lastName}` — the
 * same fallback already used by POST /bills/:id/resubmit.
 *
 * Receipts use `uploadedBy` (integer FK) which is the cleanest case.
 */
import type { AuthUser } from "./auth";

export type ExpenseStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "reimbursed"
  | "needs_correction";

export type BillStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "paid"
  | "overdue"
  | "rejected"
  | "needs_correction";

const MUTABLE_EXPENSE_STATUSES = new Set<ExpenseStatus>([
  "draft",
  "submitted",
  "needs_correction",
]);

const MUTABLE_BILL_STATUSES = new Set<BillStatus>([
  "draft",
  "submitted",
  "needs_correction",
]);

export type ExpenseLike = {
  status: string;
  submittedBy: string;
  submittedByEmail: string | null;
};

export type BillLike = {
  status: string;
  submittedBy: string | null;
  submittedByEmail: string | null;
};

export type ReceiptLike = {
  uploadedBy: number | null;
  linkedExpenseId: number | null;
  linkedBillId: number | null;
};

function callerDisplayName(user: AuthUser): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

/**
 * Returns true when `user` should be treated as the original submitter
 * of `expense`. Email is the source of truth; we only fall back to a
 * display-name match when the row has no submittedByEmail (legacy).
 */
export function isOwnExpense(user: AuthUser, expense: ExpenseLike): boolean {
  const callerEmail = user.email.toLowerCase();
  const ownerEmail = expense.submittedByEmail?.toLowerCase() ?? null;
  if (ownerEmail !== null) return ownerEmail === callerEmail;
  // Legacy row with no email recorded — name-based fallback.
  const display = callerDisplayName(user);
  return (
    display.length > 0 &&
    expense.submittedBy.trim().toLowerCase() === display.toLowerCase()
  );
}

/** Same semantics as `isOwnExpense`, applied to a bill row. */
export function isOwnBill(user: AuthUser, bill: BillLike): boolean {
  const callerEmail = user.email.toLowerCase();
  const ownerEmail = bill.submittedByEmail?.toLowerCase() ?? null;
  if (ownerEmail !== null) return ownerEmail === callerEmail;
  const display = callerDisplayName(user);
  if (display.length === 0) return false;
  const submittedBy = bill.submittedBy?.trim() ?? "";
  if (submittedBy.length === 0) return false;
  return submittedBy.toLowerCase() === display.toLowerCase();
}

/**
 * READ authz for an expense: admins and approvers see everything,
 * submitters only their own.
 */
export function canReadExpense(user: AuthUser, expense: ExpenseLike): boolean {
  if (user.role === "admin" || user.role === "approver") return true;
  return isOwnExpense(user, expense);
}

/** READ authz for a bill, mirroring `canReadExpense`. */
export function canReadBill(user: AuthUser, bill: BillLike): boolean {
  if (user.role === "admin" || user.role === "approver") return true;
  return isOwnBill(user, bill);
}

/**
 * Submitter MUTATION authz for an expense. Admins always pass.
 * Approvers do NOT get a blanket edit override here; their workflow
 * actions live on dedicated routes (approve / reject / regenerate /
 * mark-not-applicable) that are already gated by `requireRole`.
 */
export function canMutateExpense(
  user: AuthUser,
  expense: ExpenseLike,
): boolean {
  if (user.role === "admin") return true;
  if (!isOwnExpense(user, expense)) return false;
  return MUTABLE_EXPENSE_STATUSES.has(expense.status as ExpenseStatus);
}

/** Same as `canMutateExpense`, applied to a bill row. */
export function canMutateBill(user: AuthUser, bill: BillLike): boolean {
  if (user.role === "admin") return true;
  if (!isOwnBill(user, bill)) return false;
  return MUTABLE_BILL_STATUSES.has(bill.status as BillStatus);
}

/**
 * READ authz for a receipt. Admins/approvers see everything. A
 * submitter sees a receipt when they uploaded it, OR when the receipt
 * is linked to an expense/bill they own (so they can audit which
 * documents are attached to their submissions).
 *
 * Caller must pre-fetch the linked expense/bill since this helper
 * shouldn't issue its own DB reads for the per-receipt list path.
 */
export function canReadReceipt(
  user: AuthUser,
  receipt: ReceiptLike,
  linked: { expense?: ExpenseLike | null; bill?: BillLike | null } = {},
): boolean {
  if (user.role === "admin" || user.role === "approver") return true;
  if (receipt.uploadedBy === user.id) return true;
  if (linked.expense && isOwnExpense(user, linked.expense)) return true;
  if (linked.bill && isOwnBill(user, linked.bill)) return true;
  return false;
}

export function isMutableExpenseStatus(status: string): boolean {
  return MUTABLE_EXPENSE_STATUSES.has(status as ExpenseStatus);
}

export function isMutableBillStatus(status: string): boolean {
  return MUTABLE_BILL_STATUSES.has(status as BillStatus);
}

/**
 * Task #107 — privileged READ check used by GET /vendors and
 * GET /programs to decide whether to return the full record or a
 * picker-safe redacted shape.
 *
 * Submitters need to see vendor/program names so they can pick one
 * when filing an expense or bill, but they must not see PII (email,
 * phone, taxId, paymentTerms) or org-wide financial data (budgets,
 * totalSpend, percentUsed). Admins and approvers see everything.
 *
 * Centralized here (rather than duplicated per route) so the rule
 * stays consistent if we ever expand it (e.g., adding a finance-only
 * "viewer" role or honoring an audit-mode override).
 */
export function isPrivilegedRead(req: {
  authUser?: { role?: string } | undefined;
}): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "approver";
}
