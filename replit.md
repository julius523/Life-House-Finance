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

## Running tests locally
- Backend integration tests: `pnpm --filter @workspace/api-server test` (also runs automatically in `scripts/post-merge.sh` after every merge, so a regression in the journal-entry immutability triggers — or any future backend test — will fail the merge run). Tests run with `--test-concurrency=1` because two suites globally `DISABLE TRIGGER` during cleanup; parallel runs cause the line-DELETE rejection test to flake.

## Integrity sweep
- `scripts/integrity/sweep.sql` is a read-only diagnostic: 32 single-row checks across `accounting_source_links` structural integrity, JE↔draft linkage including reciprocal pointer symmetry, JE reversal-pointer symmetry + cardinality, expense+bill bridge state vs link presence, and posted-line account_id invariants. A clean DB returns `n=0` for every row. Last run 2026-04-20: 32/32 OK.
- One-off repair scripts live under `scripts/integrity/YYYY-MM-DD-*.sql`. Conventions:
  - One transaction.
  - Header documents the finding, root cause, and reproduction context.
  - Bridge inserts: idempotent via `ON CONFLICT (cols) DO NOTHING`.
  - **Audit rows are driven from `RETURNING` of the actual insert via CTE**, so a replay against an already-fixed DB writes ZERO `activity_log` rows — no phantom "we backfilled this" entries.
  - `created_by_user_id = NULL` on system-initiated repair rows (preserves portability across environments, and tells one honest provenance story when compared against canonical user-driven rows).
  - Inline `SELECT COUNT(*)` verification before `COMMIT`.
- 2026-04-20 backfill closed the only finding (`expense_draft_no_link=3`): expenses 4/6/7 had drafts 52/53/54 but no `accounting_source_links` row — legacy from a brief window before the inserter at `expenseDraftService.ts:318` went live.
