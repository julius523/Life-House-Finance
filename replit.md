# Life House Reentry — Finance Portal

Nonprofit bookkeeping monorepo (pnpm workspace).

## Artifacts
- `artifacts/finance-portal` — React/Vite UI
- `artifacts/api-server` — Express + Drizzle/Postgres
- `artifacts/mockup-sandbox` — component preview server

## Operator docs
Short, in-product runbooks for finance staff. Each is one printable page or less and follows the same structure (when to use, prerequisites, step-by-step, success, common errors, escalate to). They live in `docs/runbooks/` and are bundled into the finance-portal at build time via `import.meta.glob` (see `artifacts/finance-portal/src/lib/runbooks.ts`).

- `docs/runbooks/index.md` — 5-minute tour and master index
- `docs/runbooks/admin-emergency.md` — on-call admin runbook (login down, JE post failures, blocked-queue jam, scheduled-export stalls, integrity findings)
- `docs/runbooks/admin-backup-restore.md` — Postgres backup + restore drill (Task #139, verified 2026-05-02 against dev)
- `docs/runbooks/admin-env-vars.md` — required vs optional environment variables, kept in sync with `src/lib/envCheck.ts`
- `docs/runbooks/submit-expense.md`
- `docs/runbooks/review-approve-expense.md`
- `docs/runbooks/enter-bill-record-payment.md`
- `docs/runbooks/post-manual-journal-entry.md`
- `docs/runbooks/resolve-blocked-queue.md`
- `docs/runbooks/month-end-close.md`
- `docs/runbooks/reports-and-scheduled-exports.md`
- `docs/runbooks/invite-manage-users.md`

In-app surfaces:
- Sidebar **Help** button opens the drawer (`HelpDrawer`) at the master index.
- Each major page exposes a small `<HelpLink topic="…" />` next to the page title that deep-links into the matching runbook (Expenses, Bills, Approvals, Accounting, Remediation, Month End, Reports, Admin, Journal Entries — New).
- First-login toast (keyed by `lh-tour-seen:<email>` in localStorage) points new users at the 5-minute tour. Fires exactly once per user per device.
- Drawer is mounted once at the app shell. Cross-runbook links inside markdown navigate within the drawer (no page reload). HelpLink components communicate with the drawer via a `lh:open-help` `CustomEvent` — no React Context plumbing.

To edit a runbook, edit the markdown file directly; Vite picks it up on next build.

## Recent shipped work
- **Service-role + bearer-token API auth** — new role `service` for the Apps Script automation account `automation@lifehousereentry.com` (seeded id=704). Bearer-token auth via `INTEGRATION_API_KEY` env var with timing-safe compare (`src/lib/apiKey.ts`). Service can read `/credits`, `/credit-summary`, `/receipts`, `/bills`, `/expenses` and POST `/credits`, `/receipts`; everything else (writes to bills/expenses, deletes, admin, dashboard, reports, approvals) returns 403. `requireAuth` fails closed when an `Authorization` header is present but invalid (does not silently fall through to cookie). Login route rejects service role; service user is hidden from `/admin/users` and not creatable via UI. Same change set fixes broken production login by self-healing drifted bcrypt hashes for julius/kai/brittney/lifeup on every boot. Also fixed pre-existing routing bug where `dashboard.ts` and `reports.ts` had unscoped `router.use(requireRole(...))` that intercepted unrelated routes.
- **Production login CORS fix (2026-05-02)** — production HTTPS login was returning HTTP 500 with bare HTML because `cors.ts` did a case-sensitive `Set.has(origin)` comparison while the deployed URL `https://Lifehouseaccounting.replit.app` carried a capital "L" in the Origin header but `REPLIT_DOMAINS` stored the host lowercased. Fix: `cors.ts` now lowercases both stored origins and incoming origins via a `normalize()` helper; `app.ts` uses `isAllowedOrigin(origin)` instead of touching the Set directly. DNS hosts are case-insensitive per RFC, so this matches expected behavior. Verified mixed-case Origin headers now return 401 (auth failure) instead of 500 (CORS crash).
- **Source tagging on receipts + helper extraction (2026-05-02)** — `formatReceipt` now emits `entrySource: "automation" | "manual"` derived from `uploadedBy === automationUserId`, mirroring the existing credit-side derivation. `getAutomationUserId()` is a lazy process-lifetime cache in `auth.ts` (with a `__resetAutomationUserIdCacheForTests()` test hook). Added pure `isServiceCreatedRecord(hint)` helper to `apiKey.ts` that accepts three identity-hint shapes (submittedBy text marker, submittedByEmail FK, or uploadedByUserId FK) and returns true iff any indicate the automation account; `formatCredit` and `formatReceipt` both consume it. OpenAPI Receipt + Credit schemas updated with required `entrySource` enum field; codegen regenerated. New integration test `serviceRoleAuthz.test.ts` covers bearer happy-path, wrong-bearer 401, missing-env 401, POST credits/receipts stamps automation marker + entrySource, PUT/DELETE credits 403, POST vendors 403 (8 tests, all green; api-server suite total 206/206 pass).
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
- **Task #103 detection layer**: the same 32 checks are now also exposed as a typed read-only TypeScript service (`artifacts/api-server/src/lib/integritySweepService.ts`) that returns the locked `IntegritySweepReport` shape from `@workspace/db` — per-check count + up to 25 sample IDs (`INTEGRITY_SAMPLE_CAP`), every sample tagged with its `kind` (`expense | bill | journal_entry | draft | source_link | other`). The service `key` for each check matches the `sweep.sql` check_name 1:1.
  - HTTP: `GET /api/admin/integrity/sweep` (admin-only — `requireAuth + requireRole("admin")`).
  - CLI: `pnpm --filter @workspace/api-server run integrity:sweep` — prints a human summary on stderr and the locked report JSON on stdout (exit 0 on success regardless of findings, exit 1 on runtime failure).
  - Service is strictly read-only: no `activity_log` rows, no caching tables, no "last run" persistence. The Findings UI in #104 will consume this endpoint.
- One-off repair scripts live under `scripts/integrity/YYYY-MM-DD-*.sql`. Conventions:
  - One transaction.
  - Header documents the finding, root cause, and reproduction context.
  - Bridge inserts: idempotent via `ON CONFLICT (cols) DO NOTHING`.
  - **Audit rows are driven from `RETURNING` of the actual insert via CTE**, so a replay against an already-fixed DB writes ZERO `activity_log` rows — no phantom "we backfilled this" entries.
  - `created_by_user_id = NULL` on system-initiated repair rows (preserves portability across environments, and tells one honest provenance story when compared against canonical user-driven rows).
  - Inline `SELECT COUNT(*)` verification before `COMMIT`.
- 2026-04-20 backfill closed the only finding (`expense_draft_no_link=3`): expenses 4/6/7 had drafts 52/53/54 but no `accounting_source_links` row — legacy from a brief window before the inserter at `expenseDraftService.ts:318` went live.
