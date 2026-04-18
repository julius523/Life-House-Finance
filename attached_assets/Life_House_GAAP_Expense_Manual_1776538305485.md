# Life House Reentry GAAP Accounting, Expense Control, and Audit-Ready Operations Manual

**SOPs, internal policies, workflows, approval rules, and Replit implementation requirements**  
**Version 1.0 | April 18, 2026**  
Prepared for **Life House Reentry**

> Use this manual as an operating baseline, not as legal or tax advice. Management, outside accounting support, and counsel should approve final policy changes affecting taxes, audited financials, payroll, related parties, or regulated funding.

## Document map

- Sections 1–9: policy foundations and operating rules
- Sections 10–29: SOPs for daily accounting and expense work
- Sections 30–38: internal documents, app rules, and implementation guidance
- Appendices: dimensions, approval matrix, retention schedule, sample chart of accounts, close checklist, internal document pack

## 1. Purpose and intended use

- This manual gives Life House Reentry one operating system for expense reporting, receipt capture, accrual accounting, month-end close, audit readiness, and internal controls.
- It is written for two audiences at the same time: internal staff who must follow the rules, and Replit developers who must encode the rules into the app.
- Where policy and software conflict, policy wins until management formally updates this manual.

## 2. Scope

- Applies to all Life House Reentry cash accounts, cards, digital wallets, vendor bills, reimbursements, grants, donations, contracts, payroll-related support records, fixed assets, leases, and accounting records.
- Applies to all staff, contractors, officers, board-authorized approvers, and any outside bookkeeper, accountant, or auditor with system access.
- Applies across programs and service lines, including transitional housing, reentry support, housing stabilization, case management support, transportation, workforce training, community health worker activities, grants, donations, and administrative operations.

## 3. Core accounting policy decisions

- Accounting basis: accrual basis. Revenue is recorded when earned or entitled, and expenses are recorded when incurred, not merely when cash moves.
- Reporting basis: U.S. GAAP for a nonprofit organization.
- Restricted support must be tracked separately from without-donor-restriction activity.
- Exchange transactions and contribution transactions must be evaluated separately before posting revenue.
- Every transaction must carry enough metadata to explain who, what, when, why, funding source, approver, and supporting evidence.
- No transaction is considered fully complete until it is coded, supported, approved, and locked into the appropriate close period.

## 4. Non-negotiable control rules

- No person may request, approve, pay, and reconcile the same transaction end-to-end unless emergency override is documented and independently reviewed after the fact.
- Receipts are required for all reimbursable expenses except formally approved exceptions. Missing receipts require a signed exception memo inside the app.
- Every outflow must map to a natural account and to at least one operating dimension.
- Edits after approval must create a visible audit trail. Hard deletion of posted accounting records is prohibited.
- Voids, reversals, and corrections must preserve the original record and create a linked corrective record.
- Close periods must be lockable. Prior closed periods may be reopened only by an administrator and only with reason logging.

## 5. Required roles

- Submitter: creates expenses, uploads receipts, proposes coding, and answers follow-up questions.
- Approver: approves or rejects transactions within delegated authority but cannot approve personal expenses.
- Accounting manager or controller role: final coding authority, month-end close owner, journal entry reviewer, and lock-period owner.
- Treasury or payment role: executes approved disbursements only after approval gates pass.
- Reconciler: matches bank activity to books and cannot be the sole initiator of the matched transaction when segregation is possible.
- Administrator: manages master data, users, rules, dimensions, chart of accounts, and system settings.

## 6. Reporting dimensions required in the app

- The system must support add, deactivate, reorder, require, and report-by-dimension behavior without code changes.
- Baseline dimensions to preload for Life House Reentry:
- Entity or legal organization
- Fund
- Restriction class
- Program
- Service line
- Grant or contract
- Donor or funding source
- Functional expense class
- Department
- Site or property
- Unit, room, or bed
- County or geography
- Client or resident (when appropriate and privacy-permitted)
- Referral source
- Payer or plan
- Project or initiative
- Vehicle
- Employee or contractor
- Vendor
- Event or campaign
- Board-designated reserve or special purpose bucket
- Natural account

## 7. Chart of accounts governance

- Only accounting-admin roles may create or retire general ledger accounts.
- Accounts must follow a structured numbering scheme with account type, subtype, and reporting intent embedded in the code.
- Natural accounts should be stable. Most reporting flexibility should come from dimensions, not account sprawl.
- New account requests require business reason, sample transaction, statement classification, and proposed tax/Form 990 relevance.
- Inactive accounts may not be used for new transactions.

## 8. Source-of-truth hierarchy

- First: executed contract, grant letter, donation letter, invoice, receipt, lease, payroll record, or other primary document.
- Second: approved transaction record in the accounting app.
- Third: bank evidence and reconciliation evidence.
- Fourth: management memo for estimates, accruals, allocations, and exceptions.
- AI output is never primary evidence by itself. AI can assist, summarize, or draft, but a human owner must validate.

## 9. Transaction lifecycle statuses

- Inbox: imported but not yet reviewed.
- Draft: user-created or AI-created but not yet submitted.
- Needs receipt: waiting for support.
- Needs coding: support exists but coding is incomplete.
- Needs approver: ready for approval routing.
- Approved for payment: approved but not yet paid.
- Paid or cleared: cash has moved or card settled.
- Ready to post: fully supported and eligible for ledger posting.
- Posted: journalized to the ledger.
- Reconciled: matched to bank or subledger evidence.
- Locked: period-closed, no ordinary edits allowed.
- Rejected: not accepted; requires correction or cancellation.
- Voided or reversed: original preserved, corrective action linked.

## 10. Expense submission SOP

- Step 1: User submits expense from web or mobile.
- Step 2: Required fields: expense date, vendor, amount, payment method, business purpose, requested reimbursement or company-paid flag, at least one dimension set, and supporting document upload.
- Step 3: OCR or AI may extract merchant, date, total, tax, tip, memo, and line items, but the submitter must confirm before submission.
- Step 4: System runs validations: duplicate check, receipt presence, period open, vendor policy, dimension completeness, amount thresholds, and approver routing.
- Step 5: Record enters approval queue with immutable submission timestamp.

## 11. Receipt and support SOP

- Accepted support includes itemized receipt, invoice, signed contract, lease, boarding pass, mileage log, donor letter, grant notice, bank memo plus exception memo, or board-approved documentation appropriate to the transaction type.
- Every support file must be tied to a transaction id and stored in durable cloud or NAS storage with checksum or hash where feasible.
- Receipt images must retain the original upload plus any AI-processed derivative.
- The app must support email forwarding of receipts and transaction notifications into a monitored intake inbox.
- If a receipt is missing, the app must require a Missing Receipt Declaration with reason, amount, date, vendor, business purpose, and approving override.

## 12. Approval routing SOP

- Approval routing must be rule-based and not manually improvised.
- Minimum routing factors: amount, program, funding source, transaction type, submitter identity, vendor risk, and whether the expense is budgeted or off-budget.
- Self-approval is prohibited.
- Transactions touching executives, related parties, or board members require elevated review.
- Rejections must include reason code and comment. Resubmissions retain prior history.

## 13. Corporate card and debit card SOP

- Cards are for approved business use only.
- Card transactions must auto-create draft expenses when feeds or email alerts arrive.
- Cardholders must assign business purpose and upload receipt by the internal deadline set in the app.
- Repeated late coding or missing receipts triggers escalation and possible card suspension.
- Personal charges must be flagged immediately and repaid or offset under written policy.

## 14. Employee reimbursement SOP

- Reimbursements are allowed only for authorized business expenses not reasonably paid directly by the organization.
- Standard reimbursement categories should include travel, lodging, meals, local mileage, program supplies, emergency participant support approved under policy, software, and small operating purchases.
- The app must distinguish accountable-plan reimbursements from non-accountable-plan payments and route questionable items to accounting review.
- Mileage reimbursements must store trip date, origin, destination, purpose, miles, and rate basis. The app should reference the current IRS business mileage rate table rather than hard-code a stale value.

## 15. Accounts payable and bill pay SOP

- Vendor bill intake may start from email, upload, scan, or manual entry.
- Required vendor master fields: legal name, remit details, tax form status if applicable, service type, contract link, active/inactive flag, and conflict check status.
- Bills must be coded before payment release.
- Payment batches require a second-person review above defined thresholds.
- The system must support check, ACH, card, and manual external payment references.

## 16. Bank feed and transaction ingestion SOP

- Preferred mode is direct feed if the chosen bank connector is affordable and stable.
- Fallback mode is email-derived ingestion from bank alerts, statement PDFs, and forwarded transaction notifications.
- Statement import must support CSV, OFX, QFX, and PDF-assisted parsing with human review.
- Imported transactions should land in Inbox and never auto-post straight to the ledger without rule checks and human review, except narrowly approved low-risk autopost rules.
- Every imported bank line must preserve the raw bank description.

## 17. Bank reconciliation SOP

- Reconciliations are performed monthly at minimum, preferably continuously with a formal monthly sign-off.
- Outstanding items must be categorized: timing, duplicate, bank error, book error, uncleared payment, or investigation required.
- Reconciliations require preparer sign-off and reviewer sign-off.
- Unreconciled cash differences over threshold must trigger immediate escalation.

## 18. Accruals and cut-off SOP

- Expenses incurred before month-end but unpaid at month-end must be accrued when material or operationally required by policy.
- Revenue earned before month-end but not yet billed or received must be recognized when supported by the governing agreement and accounting rules.
- Prepaids must be amortized into the correct periods.
- The app must allow reversing journal entries with automatic reversal dates.

## 19. Revenue classification SOP for Life House

- Each incoming resource must be classified first as contribution, exchange transaction, or agency/pass-through arrangement as applicable.
- Restricted gifts, grants, and donor-imposed purpose or time restrictions must be tagged at intake.
- Conditional contributions must not be recognized as revenue until barriers are substantially met or otherwise satisfied under the governing guidance.
- Fee-for-service, contract-based, and other exchange transactions must tie to performance obligations or earned service delivery logic where applicable.

## 20. Functional expense allocation SOP

- Life House must be able to report expenses by natural classification and by function: program services, management and general, and fundraising.
- Directly attributable costs should be coded directly whenever possible.
- Shared costs require a documented allocation basis such as square footage, headcount, time study, service volume, or another approved rational basis.
- Allocation rules must be versioned, dated, approved, and reproducible.

## 21. Fixed assets, software, and leases SOP

- Capitalization thresholds must be configurable by asset class.
- Assets above threshold with useful life beyond one year should route to fixed asset review instead of immediate full expense when policy requires capitalization.
- Depreciation method, useful life, in-service date, funding source, location, and disposal history must be tracked.
- Lease arrangements must be flagged for accounting review so right-of-use asset and lease liability analysis can be performed where required.

## 22. Journal entry SOP

- Only authorized accounting roles may post manual journal entries.
- Every manual journal entry requires explanation, source support, preparer, reviewer, date, period, reversal flag, and linked documentation.
- No manual journal entry may directly hit cash unless exceptional and reviewed.
- Recurring entries should be templatized and reviewable.

## 23. Month-end close SOP

- Close calendar should be embedded in the app with task owners and due dates.
- Minimum monthly tasks: import and review all bank activity, complete card coding, post bills and reimbursements, record payroll summaries, book accruals and deferrals, reconcile cash, review suspense and uncategorized balances, review restricted funds, review grant spend, review fixed assets, review interfund activity, lock the period, and publish the management pack.
- Close checklist completion must be auditable.

## 24. Required monthly management pack

- Statement of financial position.
- Statement of activities by month and year-to-date.
- Budget versus actual by program and consolidated.
- Cash position and 13-week view if configured.
- Grant and contract burn report.
- Restricted fund rollforward.
- Aged payables and receivables if used.
- Expense exception log.
- Cardholder compliance log.
- Open accruals, reversals, and uncleared items report.

## 25. Year-end and audit readiness SOP

- The app must support PBC-ready exports: trial balance, general ledger detail, bank reconciliations, fixed asset rollforward, lease schedule, revenue support, grant schedules, board minutes index, document retention index, and user access log.
- Year-end close requires freeze of prior year after adjustment entry window ends.
- All audit requests and responses should be tracked in one evidence room folder structure.

## 26. Document retention and destruction SOP

- Retention periods must be configurable, but the default policy should preserve documents long enough to support tax filings, audits, grants, contracts, litigation holds, and operational needs.
- Returns, ledgers, close workpapers, governing documents, board minutes, major contracts, leases, and fixed asset records should be retained for long-form archival periods or permanently where appropriate.
- Receipts, invoices, reimbursement files, and reconciliation support should be retained with their transaction history and not orphaned from the ledger.

## 27. Fraud prevention and exception handling SOP

- Require duplicate detection by amount, vendor, date range, and attachment fingerprint where feasible.
- Require outlier alerts for split transactions, weekend spend, high-risk merchant category codes, related-party indicators, and rapid repeat transactions.
- Require positive confirmation before approving changes to vendor payment instructions.
- Emergency overrides must be rare, logged, and retrospectively reviewed.

## 28. AI copilot policy

- The AI copilot may draft coding suggestions, missing-field prompts, policy answers, reconciliation hints, and journal entry drafts, but it may not silently post final accounting entries.
- When retrieval is live, every internal-policy answer must cite the actual retrieved source snippet shown in the UI.
- If evidence is missing, the AI must say so instead of guessing.
- High-risk topics such as revenue recognition, restrictions, leases, fixed assets, payroll, related parties, and legal contingencies must include a human-review flag.

## 29. Security and permissions rules

- Least privilege by default.
- Separate permissions for create, edit, approve, pay, post, reconcile, export, lock period, manage rules, and manage users.
- Sensitive fields such as bank details, SSNs, taxpayer forms, and personnel reimbursement support must have narrowed visibility.
- Audit logs must capture create, edit, approve, reject, pay, post, reverse, export, login, role change, rule change, and period-lock events.

## 30. Minimum internal documents to adopt

- Accounting policy manual.
- Expense reimbursement policy.
- Corporate card policy.
- Document retention and destruction policy.
- Conflict of interest policy.
- Related-party transaction policy.
- Delegation of authority and approval matrix.
- Revenue recognition and grant classification memo template.
- Allocation methodology memo template.
- Month-end close checklist.
- Journal entry template.
- Missing receipt declaration.
- Vendor onboarding checklist.
- Lease intake checklist.
- Fixed asset intake and disposal form.
- Audit request log template.

## 31. Replit implementation requirements

- The app must separate operational transaction records from ledger entries but keep them linked.
- Every record needs immutable ids and created/updated metadata.
- Soft delete only for unposted drafts. Posted records require reverse/void workflows.
- Rules engine must be data-driven: thresholds, approvals, required fields, autopost eligibility, retention periods, capitalization thresholds, allocation drivers, and lock dates all editable in admin settings.
- Receipt storage must allow multiple attachments per record and maintain original file plus OCR text.
- The system must support API-ready bank import adapters and email parser adapters.

## 32. Recommended default close timeline

- Day 0 to 2: import transactions, receipt chase, card coding.
- Day 3 to 5: vendor bills, reimbursements, payroll summaries, grant coding cleanup.
- Day 5 to 7: accruals, deferrals, allocations, fixed asset review, lease review.
- Day 7 to 8: cash reconciliation and suspense cleanup.
- Day 9 to 10: management review, lock period, publish reports.

## 33. Final operating rule

- If a transaction cannot be explained clearly to a board member, auditor, regulator, donor, payer, or future staff member within two minutes using the record and its support, the record is not complete.

## 34. Minimum data objects for the app

- Users, roles, permissions.
- Vendors.
- Employees and contractors.
- Funding sources and donors.
- Grants and contracts.
- Programs, service lines, departments, sites, units, vehicles, projects, and other configurable dimensions.
- Bank accounts, card accounts, external feed connections, and imported statements.
- Expenses, bills, reimbursements, payments, journal entries, ledger lines, reconciliations, attachments, comments, approval steps, exceptions, and audit logs.
- Policies, SOP versions, AI knowledge documents, and retention schedules.

## 35. Critical validations Replit must encode

- Reject posting if natural account is missing.
- Reject posting if required dimensions for that transaction type are missing.
- Reject approval if requester equals approver.
- Warn or block if duplicate likely exists based on configurable rule score.
- Warn if expense date falls in locked period.
- Warn if restricted funding source is selected but purpose/category mismatches restriction rules.
- Route to accounting review when manual override, missing receipt, split allocation, or related-party tag is present.
- Require human review flag before finalizing AI-suggested entries on high-risk categories.

## 36. Suggested automation priorities

- First: email intake for receipts, invoices, and bank notifications.
- Second: bank statement and card statement parsing into draft transactions.
- Third: approval routing and reminder engine.
- Fourth: close checklist automation and exception dashboards.
- Fifth: AI copilot with retrieval over internal policies and accounting docs.

## 37. Version control and change management

- Every policy, rule, threshold, dimension, and workflow must have effective date, version, owner, and change note.
- Historical reports must remain reproducible under the rules effective for the original period where practical.
- Admin changes that affect accounting logic must be logged and reviewable.

## 38. Implementation note to Replit

- Do not build this as a simple expense tracker. Build it as a transaction operating system with accounting discipline.
- Separate user convenience from accounting finality. Drafts can be flexible; posted books cannot.
- Preserve evidence. Preserve history. Preserve reversibility.

## Appendix A. Baseline reporting dimensions

| Dimension | Purpose | Examples for Life House | Default Required? |
| --- | --- | --- | --- |
| Fund | Separate unrestricted, donor-restricted, board-designated, or special pools of money | Operating, Donor Restricted, Board Reserve, Emergency Client Support | Yes |
| Restriction class | Track net assets with/without donor restrictions and internal designations | Without donor restriction, With donor restriction, Board designated | Yes |
| Program | Primary mission bucket | Reentry Housing, Housing Stabilization, CHW Training, Workforce Support | Yes |
| Service line | Operational service detail | Transitional Housing, Transportation, Case Support, Outreach, Training | Yes |
| Grant or contract | Sponsor-specific reporting and compliance | County grant, foundation grant, contract id | When applicable |
| Donor or funding source | Track source relationships and restrictions | Individual donor, foundation, public agency | When applicable |
| Functional expense class | GAAP nonprofit functional reporting | Program Services, Management & General, Fundraising | Yes |
| Department | Internal ownership | Operations, Finance, Executive, Development | Recommended |
| Site or property | Location-based performance and cost tracking | Main house, Sacramento site, future properties | When applicable |
| Unit/room/bed | Housing utilization analytics | Bed 1, Room A, Overflow | When applicable |
| County/geography | Regional reporting | Sacramento, Yolo, Solano | Recommended |
| Client or resident | Direct-support traceability with privacy controls | Resident ID only | When applicable |
| Referral source | Partnership and pipeline tracking | Probation, hospital, self-referral | Optional |
| Payer or plan | CalAIM/plan reporting where needed | Plan, county, self-pay, donor-supported | When applicable |
| Project/initiative | Temporary or special work | App build, retreat, capital campaign | Recommended |
| Vehicle | Mileage and fleet cost tracking | Van 1, Van 2 | When applicable |
| Employee/contractor | Ownership and reimbursement traceability | Staff ID | When applicable |
| Vendor | Spend concentration and AP controls | Vendor master entry | Yes |
| Event/campaign | Fundraising or event profitability | Giving campaign, workshop | When applicable |
| Natural account | Financial statement classification | Rent, utilities, payroll, supplies | Yes |

## Appendix B. Default approval matrix

| Rule | Minimum approval path |
| --- | --- |
| Expense under low threshold and within approved budget | Submitter → Approver |
| Expense above low threshold or off-budget | Submitter → Approver → Accounting |
| Executive-related expense | Submitter → Independent approver → Accounting |
| Vendor payment detail change | Requester → Verifier not involved in change request → Accounting/Treasury |
| Grant-funded unusual cost or questionable allowability | Submitter → Program owner → Accounting |
| Manual journal entry | Preparer → Reviewer |
| Cash disbursement batch above high threshold | Accounting/Treasury preparer → Secondary release approver |

## Appendix C. Default record retention schedule

| Record type | Default retention rule |
| --- | --- |
| Governing documents, IRS determination, major policies, board minutes | Permanent |
| General ledger, trial balances, financial statements, close workpapers | Permanent or long-term archive |
| Grant agreements, major contracts, leases, fixed asset files | At least contract term plus long-form archive period |
| Bank statements, reconciliations, AP, receipts, reimbursement support | At least 7 years unless longer hold applies |
| Payroll summaries and supporting records | Per payroll/legal retention schedule; not less than statutory minimum |
| User access logs and audit logs | At least 7 years if storage allows; longer preferred |
| Litigation hold items | Do not destroy until hold is released in writing |

## Appendix D. Sample chart of accounts frame

| Range | Type | Examples |
| --- | --- | --- |
| 1000-1999 | Assets | Cash, receivables, prepaid expenses, deposits, fixed assets, ROU assets |
| 2000-2999 | Liabilities | Accounts payable, accrued expenses, deferred revenue/refundable advances, lease liabilities |
| 3000-3999 | Net assets | Without donor restrictions, with donor restrictions, board-designated balances |
| 4000-4999 | Revenue and support | Contributions, grants, contract revenue, training revenue, in-kind support |
| 5000-5999 | Program service expenses | Housing, transportation, supplies, client support, training delivery |
| 6000-6999 | Management and general | Accounting, admin software, insurance, occupancy admin share |
| 7000-7999 | Fundraising | Campaign costs, donor events, fundraising software |
| 8000-8999 | Other income/expense | Interest income, gains/losses, adjustments |

## Appendix E. Month-end close checklist

| Task | Owner | Evidence |
| --- | --- | --- |
| Review imported bank and card activity | Operations + Accounting | Inbox cleared report |
| Receipt chase and unresolved exceptions | Submitters + Approvers | Exception log |
| Post bills, reimbursements, and approved expenses | Accounting | Posting summary |
| Record payroll summary and benefit allocations | Accounting | Payroll JE support |
| Book accruals, deferrals, and reversals | Accounting | JE packet |
| Reconcile all cash accounts | Preparer + Reviewer | Signed reconciliation |
| Review restricted funds and grant coding | Accounting + Program leads | Grant report |
| Review uncategorized/suspense balances | Accounting | Zero or explained balance |
| Review fixed assets and lease events | Accounting | Asset/lease memo |
| Lock the period and issue reports | Accounting manager | Lock log + management pack |

## Appendix F. Internal document pack to adopt

1. Accounting Policy Manual — board-approved master policy.
2. Expense Reimbursement Policy — accountable-plan focused rules for staff and contractors.
3. Corporate Card Policy — allowed spend, deadlines, exceptions, and consequences.
4. Delegation of Authority Matrix — who can approve what.
5. Revenue Classification Memo — contribution vs exchange decision support.
6. Grant Setup Form — funding source, restrictions, reporting dates, allowability rules.
7. Allocation Memo — approved bases for rent, utilities, insurance, admin salaries, and shared software.
8. Vendor Onboarding Packet — W-9, conflict check, remit verification, service type, contract link.
9. Missing Receipt Declaration — signed exception record.
10. Journal Entry Cover Sheet — purpose, support, preparer, reviewer, reversal date if any.
11. Reconciliation Sign-Off Form — preparer/reviewer evidence.
12. Audit Request Log — all PBC items tracked in one place.

## Closing note

For Life House, the right system is not just accounting software. It is a governed evidence system. The books should be able to explain the mission, the money, the restrictions, the approvals, and the proof without relying on memory.
