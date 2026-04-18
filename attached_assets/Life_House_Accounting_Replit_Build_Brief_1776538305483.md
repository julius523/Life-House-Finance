# Life House Reentry Accounting Build Brief for Replit

**Source of truth:** Life House Reentry GAAP Accounting, Expense Control, and Audit-Ready Operations Manual  
**Version:** Version 1.0 | April 18, 2026

## Build objective

Build an **audit-ready accounting and expense operating system**, not a simple expense tracker.

## Non-negotiable system rules

- Use **accrual accounting**.
- Support nonprofit **GAAP-style reporting**.
- Separate **operational records** from **ledger entries**, but keep them linked.
- Use **soft delete only for unposted drafts**.
- For posted records, use **void, reverse, or corrective entry** workflows.
- Preserve **immutable ids**, timestamps, actor ids, and audit history.
- No user may **request, approve, pay, and reconcile** the same transaction end-to-end without logged override.
- **Self-approval is prohibited**.
- AI may suggest, draft, or summarize. AI may **not silently post final accounting entries**.

## Required statuses

- Inbox
- Draft
- Needs receipt
- Needs coding
- Needs approver
- Approved for payment
- Paid / cleared
- Ready to post
- Posted
- Reconciled
- Locked
- Rejected
- Voided / reversed

## Required master data

- Users
- Roles
- Permissions
- Vendors
- Employees / contractors
- Donors / funding sources
- Grants / contracts
- Programs
- Service lines
- Funds
- Restriction classes
- Departments
- Sites / properties
- Units / beds
- Vehicles
- Projects
- Bank accounts
- Card accounts
- Policies / SOP versions

## Required dimensions on transactions

- Fund
- Restriction class
- Program
- Service line
- Grant / contract
- Donor / funding source
- Functional expense class
- Department
- Site / property
- Natural account

Support optional / conditional dimensions too:
- Unit / room / bed
- County / geography
- Client / resident id
- Referral source
- Payer / plan
- Project
- Vehicle
- Employee / contractor
- Vendor
- Event / campaign

## Required transaction objects

- Expenses
- Bills
- Reimbursements
- Payments
- Journal entries
- Ledger headers and ledger lines
- Reconciliations
- Attachments
- Comments
- Approval steps
- Exceptions
- Audit logs
- Imported bank transactions
- Imported card transactions

## Required validations

- Block posting if natural account is missing.
- Block posting if required dimensions are missing.
- Block self-approval.
- Warn or block likely duplicates based on configurable scoring.
- Warn if transaction date is in a locked period.
- Route to accounting review when:
  - missing receipt
  - manual override
  - related-party flag
  - split allocation
  - high-risk category
  - restricted funding mismatch
- Require human review on AI-drafted items for:
  - revenue recognition
  - restrictions
  - leases
  - fixed assets
  - payroll
  - related parties
  - legal contingencies

## Receipt and support requirements

- Multiple attachments per record
- Preserve original file
- Preserve OCR text or parsed text
- Support upload, email forward, mobile photo, and statement import
- Missing receipts require a signed exception declaration

## Approval routing factors

- Amount
- Program
- Funding source
- Transaction type
- Submitter
- Vendor risk
- Budgeted vs off-budget
- Executive-related or related-party flag

## Reconciliation requirements

- Monthly reconciliation minimum
- Preparer sign-off
- Reviewer sign-off
- Exception categories:
  - timing
  - duplicate
  - bank error
  - book error
  - uncleared item
  - investigation required

## Period control requirements

- Lock periods
- Reopen only by authorized admin
- Reopen requires reason log
- All post-lock edits must be tracked

## Suggested implementation order

1. Dimension engine
2. Status model
3. Expense / receipt intake
4. Approval routing
5. Audit log
6. Ledger posting layer
7. Reconciliation module
8. Month-end close checklist
9. AI copilot with retrieval-backed policy answers

## Final instruction

Do not optimize for speed by sacrificing evidence, reversibility, or audit history.
