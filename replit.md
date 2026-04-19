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
- **Task #64** — finished migrating the finance portal off ad-hoc `fetch()`/`apiJson` to typed hooks generated from the OpenAPI spec. Added paths for daily-snapshot, restore-day, wipe-data, email-settings GET/PUT/test, admin notifications GET + resend, transactions/auto-match, accounting/threads/{id}/messages. Migrated `admin.tsx`, `transactions/index.tsx`, `accounting.tsx` (copilot send), `accounting-blocked-expenses.tsx`, `bills/detail.tsx`. Copilot 503 fallback reads `ApiError.data` (parsed body), not `err.response`. Server `/admin/email-settings/test` now returns `delivered` as a real boolean (was a `DeliveryResult` object that always made `delivered` truthy).

## In flight / deferred
- **Task #29A** — Manual JE draft persistence (save/resume work-in-progress). Reclassified from rejected Task #29 (which was supposed to be the full approval workflow but only delivered persistence). Useful in its own right; ledger surface untouched. See `evidence/task29a/`.
- **Task #29B (PENDING)** — the actual Manual JE approval workflow (draft → submit → approve → reject → post). Frozen acceptance criteria at `evidence/task29b/TASK29B_ACCEPTANCE_CRITERIA.md`. Must build on top of the existing 29A drafts table (extend with status + approval columns); must reuse the Task 25A idempotent posting service; must add `journal_entries.manual_draft_id` linkage; must enforce server-side no-self-approval honoring `accounting_settings.separationOfDuties`.
- **Task #32** — typed account picker + CoA detail page on the generated client
- **Task #33** — CSV export of journal entries list
- **Task #34** — show "posted by" on the JE review page

## Test evidence
- `evidence/step8/`, `evidence/step9/`, `evidence/task25/`, `evidence/task25a/`
- Runners under `.local/test-evidence/run-*.mjs`
