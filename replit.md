# Life House Reentry — Finance Portal

Nonprofit bookkeeping monorepo (pnpm workspace).

## Artifacts
- `artifacts/finance-portal` — React/Vite UI
- `artifacts/api-server` — Express + Drizzle/Postgres
- `artifacts/mockup-sandbox` — component preview server

## Recent shipped work
- **Step 8** — controlled GL posting (admin/approver only, period-locked, idempotent on `agent_action_id`, reversal-only correction)
- **Step 9** — Chart of Accounts + accounting settings + trial balance (9-value account_type enum + `defaultNormalBalanceFor()`; admin-only settings)
- **Task #25** — manual JE direct-post route (`POST /accounting/journal-entries`) + `/accounting/journal-entries/new` page
- **Task #26** — Balance-Sheet breakdown
- **Task #27** — typed React Query hooks generated from OpenAPI for new accounting endpoints
- **Task #28** — `/accounting/journal-entries` review list + detail page (filters: status, source, date; pagination)
- **Task 25A** — manual-post idempotency hardening: required `Idempotency-Key` UUID header, sha256 fingerprint of normalized payload, partial unique index `journal_entries_idempotency_key_uniq`, 200 on replay / 409 on conflict, race-safe via DB unique violation catch

## In flight / deferred
- **Task #29** — draft → submit → approve → reject manual JE workflow (no-self-approval, full lifecycle UI)
- **Task #32** — typed account picker + CoA detail page on the generated client
- **Task #33** — CSV export of journal entries list
- **Task #34** — show "posted by" on the JE review page

## Test evidence
- `evidence/step8/`, `evidence/step9/`, `evidence/task25/`, `evidence/task25a/`
- Runners under `.local/test-evidence/run-*.mjs`
