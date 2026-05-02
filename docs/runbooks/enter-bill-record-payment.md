# Enter a bill and record its payment

## When to use this
A vendor sent us an invoice we will pay later (rent, utilities, insurance, professional services). Bills are different from expenses: they create an **accrual** when entered and a **payment** when paid.

## Prerequisites
- Submitter role or higher.
- The PDF invoice from the vendor.
- The vendor exists in **Vendors**, or you can create them inline.

## Step-by-step (entering the bill)
1. Sidebar → **Bills** → **New bill**.
2. **Vendor** — pick from the list, or "Create new" if they don't exist yet.
3. **Bill date** — the date on the invoice.
4. **Due date** — when we have to pay by.
5. **Amount** — the total.
6. **Category / Account** — what this bill is for (Rent, Utilities, Insurance, etc.).
7. **Program** — which program absorbs this cost.
8. Upload the **invoice PDF**.
9. Click **Submit**. The bill enters **Pending review**, an approver approves it, and once approved the **accrual leg** posts (debit expense, credit Accounts Payable).

## Step-by-step (recording the payment)
1. Open the bill from **Bills** → click the row → **Record payment**.
2. **Payment date** — the date the cheque cleared / the transfer was sent.
3. **Payment account** — which bank account paid it (Operating, Reserve, etc.).
4. **Amount** — usually the full bill amount; partial payments are allowed.
5. **Reference** — cheque number or transfer ID.
6. Click **Record payment**. The **payment leg** posts (debit Accounts Payable, credit the bank account).

## What success looks like
- Bill status moves: **Pending review → Approved → Partially paid / Paid**.
- Two journal entries exist: the accrual and the payment, both visible under **Accounting → Journal Entries** with source **bill**.
- Accounts Payable balance for this vendor goes back to zero once fully paid.

## Common errors
- **"Bill is blocked — mapping required"** — category isn't mapped to a GL account. See [Resolve a blocked-queue item](resolve-blocked-queue.md).
- **"Payment exceeds remaining balance"** — you're trying to pay more than is owed. Check for an earlier partial payment.
- **"Period locked"** — pick a payment date inside the current open period.

## Escalate to
Approver if the bill is sitting in pending review more than a day. Admin for any mapping or period-lock blocker.
