# Threat Model

## Project Overview

Life House Reentry is a nonprofit bookkeeping application in a pnpm monorepo. The production system consists of a React/Vite finance portal (`artifacts/finance-portal`) and an Express + Drizzle/PostgreSQL API server (`artifacts/api-server`). The app is used by authenticated staff with role-based permissions (`admin`, `approver`, `submitter`) to manage expenses, bills, receipts, vendors, programs, accounting workflows, and related reporting.

Per project assumptions, `artifacts/mockup-sandbox` is a development-only preview environment and is not deployed to production. Production traffic is terminated with platform-managed TLS, so this scan focuses on production-reachable application-layer issues.

## Assets

- **User sessions and role assignments** — the signed `lh_session` cookie and server-side role lookup determine whether a user acts as an admin, approver, or submitter. Compromise or misuse allows broad access to financial workflows.
- **Financial records** — expenses, bills, journal entries, transactions, vendors, programs, approval states, and month-end workflow data are business-critical records. Unauthorized reads expose sensitive nonprofit spending information; unauthorized writes can corrupt accounting data.
- **Uploaded documents** — receipt and statement files in object storage may contain PII, merchant details, account numbers, and reimbursement evidence. These must remain scoped to authorized users.
- **Accounting controls** — posting, reconciliation, period locking, approval flows, and integrity links protect the general ledger from tampering. Bypassing these controls can create materially incorrect books.
- **Application secrets and integrations** — database credentials, session-signing material, mail settings, AI/provider credentials, and any storage credentials must remain server-only.

## Trust Boundaries

- **Browser to API** — the finance portal is untrusted. Every API request must be authenticated and authorized server-side regardless of what navigation or UI the client exposes.
- **Authenticated user to privileged role boundary** — submitters, approvers, and admins have materially different permissions. Role and ownership checks must be enforced in backend route handlers and services, not only in frontend route guards.
- **API to PostgreSQL** — the API server can read and mutate all financial records. Input validation and safe query construction are required to prevent unauthorized access or data corruption.
- **API to object storage / file-processing services** — receipt and statement files cross into storage and AI-processing flows. Object identifiers and storage paths must be treated as sensitive capabilities and checked against caller authorization.
- **Production to dev-only boundary** — `artifacts/mockup-sandbox` is intentionally out of production scope unless production reachability is demonstrated.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/*.ts`, `artifacts/finance-portal/src/pages/**`
- Highest-risk areas: role/session enforcement in `artifacts/api-server/src/lib/auth.ts`; operational finance routes such as `expenses.ts`, `bills.ts`, `receipts.ts`, `vendors.ts`, `programs.ts`; reviewer/reporting/control routes such as `dashboard.ts`, `approvals.ts`, `reports.ts`, `month-end.ts`, `accounting.ts`; file/object routes such as `storage.ts` and `ai.ts`; copilot tool execution and prompt-to-data boundaries in `artifacts/api-server/src/lib/copilotTools.ts`
- Public vs authenticated vs admin: `/api` is globally authenticated in `app.ts`; many routes rely on that baseline and require additional per-role or per-record authorization; accounting/admin/reviewer actions must be restricted server-side, not just hidden in the client
- Dev-only areas usually skipped: `artifacts/mockup-sandbox/**`
- Special boundary reminders from this scan: `POST /api/ai/parse-bank-statement` and the `/api/accounting` copilot endpoints are production-reachable authenticated entry points that can mutate or disclose shared finance data even when the corresponding UI sections are hidden from submitters; legacy ownership fallbacks that use display names instead of durable user identifiers remain sensitive

## Threat Categories

### Spoofing

The application relies on a signed session cookie and server-side user lookup to identify staff users. The API must reject unauthenticated requests, bind all sensitive actions to the authenticated principal, and avoid trusting client-supplied identity fields such as submitter names or email addresses when creating or mutating records.

### Tampering

Users can create and modify financial records, attach receipts, import statements, and trigger accounting workflows. The server must compute or validate security-sensitive fields itself, enforce record ownership where applicable, and ensure lower-privilege roles cannot change status, approval, vendor, program, month-end, transaction-ledger, or accounting state outside their remit. AI-assisted imports and copilot-triggered tool calls are part of this tampering surface because they can write shared finance records on behalf of the caller.

### Repudiation

Expense, bill, receipt, reporting-control, and accounting mutations need reliable attribution. Sensitive actions should be tied to the authenticated user and recorded consistently so the organization can investigate who changed financial data and when.

### Information Disclosure

Expense, bill, receipt, dashboard, approvals, reporting, and accounting endpoints expose organization financial data and uploaded documents. Responses must be scoped by role and need-to-know, and file download or AI-processing routes must not treat a database identifier or storage path as sufficient authorization on its own. Copilot tool calls and document-search features must enforce the same role and ownership limits as the underlying direct routes.

### Denial of Service

Authenticated users can trigger list views, file-processing flows, and potentially expensive accounting or AI-backed operations. These routes should bound query sizes, upload sizes, and processing work so a regular user cannot disproportionately consume backend or third-party resources.

### Elevation of Privilege

This project has a strong authenticated-but-differently-privileged threat model. The main risk is broken access control: a submitter or other low-privilege user reaching approver/admin capabilities or other users’ records through direct API calls, AI-assisted import endpoints, or copilot tool execution. All privileged finance and accounting operations must be authorized server-side per route and, where relevant, per record ownership with durable identifiers rather than non-unique display names.