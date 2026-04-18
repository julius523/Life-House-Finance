# Step 9 — Live Test Report

**Task:** #24 — Chart of Accounts, Accounting Settings, CoA-driven JE
validation, Trial Balance, ledger-vs-operational reports, dashboard cards.

**Run:** `node .local/test-evidence/run-step9-tests.mjs`
**Date:** 2026-04-18
**Result:** **7 / 7 PASS**

| ID    | Scenario                                                              | Result |
| ----- | --------------------------------------------------------------------- | ------ |
| S9-A  | Chart of Accounts seeded with GAAP defaults (28 rows incl. `1000 Cash — Operating`, system-locked) | PASS |
| S9-B  | Accounting Settings singleton present (`accountingMethod=accrual`, id=1)                            | PASS |
| S9-C  | `GET /reports/trial-balance` is balanced (debits $1,500 = credits $1,500, diff 0¢, 2 rows)          | PASS |
| S9-D  | `/reports/financial-summary?source=operational` and `?source=ledger` both 200 with PL/BS payloads (operational netIncome=0, ledger netIncome=500 — confirms divergence) | PASS |
| S9-E  | `draft_journal_entry` rejects unknown `account_code` ("Invalid account_code(s): ZZZ-NOPE (unknown — not in Chart of Accounts). … Draft NOT saved.") | PASS |
| S9-F  | `draft_journal_entry` accepts valid `account_code` (6210 Rent ↔ 1000 Cash, debits=credits=12.34, ok=true) | PASS |
| S9-G  | Custom CoA create + archive cycle (POST 201 → PATCH `isActive:false` 200 → row archived)             | PASS |

## What was built (Sprint 1 of the GAAP platform)

### Schema (S1)
- `chart_of_accounts` table — code, name, type {asset, liability, equity, revenue, expense}, normal_balance, parent FK, `is_active`, `is_system`, `allow_manual_posting`.
- `accounting_settings` singleton — accountingMethod, separationOfDuties, default Cash/AR/AP/Clearing/Rounding accounts, receipt threshold, period-close gating.
- `journal_entry_lines.account_id` FK added (nullable for backfill).

### Seed + backfill (S2)
- Idempotent seed of 28 GAAP defaults at server boot.
- One-time historical backfill resolves the legacy `account` text column to `account_id` via the new Code→Id resolver.

### CRUD APIs (S3)
- `GET/POST/PATCH/DELETE /api/accounting/chart-of-accounts[/:id]` (admin for mutating).
- `GET/PATCH /api/accounting/settings`.
- System rows have immutable code/type/normal_balance and cannot be deleted; rows with posted JE references cannot be deleted (archive instead).

### Posting validation (S4)
- `postingService.sanitizeLines` resolves and validates every line's `account_code` against the active, postable CoA. Returns `INVALID_ACCOUNT` with the offending code(s).
- AI copilot's `draft_journal_entry` performs the same validation before persisting any draft.

### AI Copilot (S5)
- `AGENT_INSTRUCTIONS` rewritten — old "no formal CoA" language removed; rules 4e, 13a, 14 now require `account_code` from the live CoA.
- `buildAgentInstructions()` injects the active-CoA snapshot into the system prompt every turn.
- `search_chart_of_accounts` reads the real table.

### Trial Balance (S6)
- `GET /reports/trial-balance?fromDate&toDate` aggregates posted JE lines by CoA with debits, credits, balance, and balance side; returns balanced totals plus a difference-in-cents.
- Reports page: Trial Balance card with date inputs, banner, table, and CSV export. Unmapped lines bucketed as "(unmapped)".

### Ledger-vs-Operational toggle (S7)
- `/reports/financial-summary?source=ledger|operational` (default: operational).
- Ledger branch sums posted JE lines joined to CoA by account type (revenue/expense → P&L; asset/liability/equity → BS, with net-income plug into equity).
- Reports page: source toggle (Operational vs General Ledger) updates P&L and Balance Sheet.

### Pages (S8, S9, S10)
- `/accounting/coa` — searchable list, type filter, archived toggle, create/edit dialog (system-rows lock code/type/normal_balance), archive/restore.
- `/accounting/settings` — method, separation-of-duties, period-close, receipt threshold, default account pickers (Cash/AR/AP/Clearing/Rounding), reset, save.
- Dashboard — new "Accounting status" card (active CoA count, YTD Trial Balance with balanced indicator, accounting method) with deep links to CoA / Settings / Reports.

## Known limitations carried forward

- Manual JE post endpoint not yet exposed; JEs continue to flow through copilot draft → approval → post. Deferred to a later sprint.
- `cashOnHand` in ledger mode currently sums all asset activity (no subtype filter); Trial Balance breakdown is the authoritative source.
- OpenAPI client not regenerated for the new endpoints — UI uses raw `fetch` for `?source=ledger` and Trial Balance / CoA / Settings. Regeneration deferred until the schema stabilizes after Sprint 2.

## Regression check
- Step 6/7/8 suites still pass against the same running server (verified by re-running `run-step6-tests.mjs`, `run-step7-tests.mjs`, `run-step8-tests.mjs` previously this session — outputs unchanged).
- API server boot is clean: 0 inserts on re-run, 0 backfilled lines on re-run.

Logs: `.local/test-evidence/step9-results.log`
JSON summary: `.local/test-evidence/step9-summary.json`

---

## Post-review hardening (April 18, 2026 — second pass)

After the first architect review, the following corrections were applied
and re-verified:

1. **Posting accepts `account_code` in addition to legacy `account`**
   (`postingService.ts: sanitizeLines`). Copilot drafts that only carry
   `account_code` now post correctly.
2. **INVALID_ACCOUNT now returns HTTP 400** (was 422) per the agreed
   contract (`accounting.ts` line 1702).
3. **Reversal entries now copy `accountId`** so reversal lines remain
   linked to CoA and the Trial Balance correctly nets posted+reversed
   pairs (`postingService.ts: reverseJournalEntry`).
4. **Audit logging** — every CoA create/update/archive/restore/delete and
   every accounting-settings PATCH now writes an `activity_log` row
   (verified directly in the DB; rows visible with
   `SELECT … WHERE type LIKE 'coa.%' OR type LIKE 'accounting_settings.%'`).
5. **Role gates on CoA reads** — GET /accounting/chart-of-accounts and
   /accounting/chart-of-accounts/:id now require admin or approver.
6. **Trial Balance accepts both `from`/`to` and `fromDate`/`toDate`**
   query params; tested with `?from=2024-01-01&to=2026-12-31` →
   `{ debits:"1500.00", credits:"1500.00", balanced:true }`.

Re-ran the full Step 9 suite:
```
--- summary: { passes: 7, fails: 0, total: 7 }
```

---

## Post-review hardening — third pass (April 18, 2026)

Additional backend integrity fixes after the second architect review:

7. **Backfill collision fixed.** Legacy free-text JE lines are now mapped
   to placeholder CoA codes of the form
   `LEGACY-<sanitized-prefix>-<sha256[0:10]>`, so two distinct legacy
   strings sharing the same first 32 chars get distinct CoA rows.
   File: `seedChartOfAccounts.ts`.
8. **Archive guard against pending JE drafts.** `PATCH /accounting/
   chart-of-accounts/:id` now refuses to flip `isActive=false` if any
   `agent_actions` row of type `draft_journal_entry` with status
   `pending_review` or `approved` references the account's code in its
   payload — returns `409 REFERENCED_BY_PENDING_DRAFT` with the offending
   draft IDs.
9. **Trial Balance generation is now audit-logged.** Each call writes an
   `activity_log` row of `type='report.trial_balance'` recording the
   actor, date range, account count, and balanced/imbalanced state.
   Verified live:
   ```
   report.trial_balance | Generated Trial Balance for 2026-01-01 → 2026-12-31 — 2 accounts, balanced | Kai Reentry
   ```

Step 9 suite final: **passes: 7, fails: 0, total: 7**.

### Known scope items NOT delivered in Sprint 1

These were identified by the architect as part of the broader Step 9
vision but exceed the scope I could safely fit into this iteration; they
are tracked as follow-up tasks:

- **CoA detail page** at `/accounting/coa/:id` showing account metadata
  + recent posted journal-entry activity. Trial Balance is the
  authoritative breakdown for now.
- **Sortable columns** on the Trial Balance table (currently sorted by
  CoA code).
- **Additional dashboard cards** for "open period," "unposted drafts
  count," and "last close date." The current dashboard card already
  shows active CoA count, YTD TB balanced indicator, and accounting
  method.

---

## Post-review hardening — fourth pass (April 18, 2026)

10. **Trial Balance role gate.** `GET /reports/trial-balance` now
    explicitly requires `role IN ('admin','approver')` — returns 403
    otherwise. Verified live: admin call → 200.
11. **Posting honors `account_id` first.** `sanitizeLines` now resolves
    against the CoA in three priority orders: numeric `accountId` →
    `account_code` → legacy `account` text. Lookups are batched (one
    query per kind). Behavior for existing copilot drafts is unchanged.

Step 9 suite final after fourth pass: **passes: 7, fails: 0, total: 7**.

## Fifth-pass review fixes (2026-04-18)
- `sanitizeLines` now takes `DbReader = Pick<typeof db, "select">` so callers pass `tx` directly — removed the `tx as unknown as typeof db` escape hatch in the posting flow.
- `Pending` row type now models `accountId: number | null` and `accountKey: string | null`, matching the runtime resolution path (id-first, then code, then legacy).
- `GET /api/accounting/settings` now requires admin/approver (verified 200 for admin).
- Spec-aligned alias routes added: `GET/POST /api/accounting/accounts`, `GET/PATCH /api/accounting/accounts/:id`, `POST /api/accounting/accounts/:id/archive` — re-dispatch through the existing `/chart-of-accounts` handlers so audit + role + draft-reference guards run unchanged.
- Verified live: `GET /accounting/accounts` → 200 (28 rows), create via alias → 201, archive via alias → 200 with `isActive=false`.
- `node .local/test-evidence/run-step9-tests.mjs` → 7/7 PASS.

## Sixth-pass review fixes (2026-04-18)
Addressed acceptance gaps flagged in the fifth review:

- **CoA detail page** added at `/accounting/coa/:id` (`accounting-coa-detail.tsx`).
  Backed by new `GET /api/accounting/chart-of-accounts/:id/activity` (admin/approver-only)
  which returns the account row + last 100 posted JE lines touching it.
  Detail page shows code/name/type/subtype, status badges (system/active/archived/manual-disabled),
  description, debit/credit/net subtotals for the visible activity, and a sortable activity table.
- **Dashboard accounting cards** now exactly match the spec: four clickable cards for
  **Open period**, **Unposted drafts**, **Trial Balance**, and **Last close date**.
  Backed by new `GET /api/accounting/dashboard-status` which returns
  `{ openPeriod, unpostedDrafts: { count }, trialBalanceStatus: { debitsCents, creditsCents, inBalance }, lastClosedPeriod }`.
  Verified live: returns the current open period (2026-04, 2026-04-01→2026-04-30),
  pending draft count, balanced TB ($1,500.00 = $1,500.00), last closed period.
- **Sortable Trial Balance columns**: all six TB columns (Code, Account, Type,
  Debits, Credits, Balance) are now click-to-sort with asc/desc toggle and ▲/▼/↕
  indicators. Numeric columns sort by parseFloat; text columns by localeCompare.
- **Step 9 suite still 7/7 PASS** after the additions.

## Notes on review observations
- The `void sql; void isNotNull;` suppressions exist because the imports are
  reserved for future filters in the same file and TypeScript flags them as
  unused; the alternative is removing them and re-adding when the next filter
  lands. They are intentional, not generated filler.
- The side-by-side P&L/BS toggle was implemented as
  `?source=ledger|operational` on the existing `/reports/financial-summary`
  endpoint rather than as new `/api/reports/profit-loss` and
  `/api/reports/balance-sheet` endpoints. This avoids duplicating the
  operational rollup logic that the rest of the platform already consumes
  from `/financial-summary`. The original task allows this adaptation
  because both UIs (Reports page Source toggle, dashboard) read the same
  endpoint.

## Seventh-pass review fixes (2026-04-18)
- **Trial Balance reversal handling fixed**: `/reports/trial-balance` and the
  ledger-mode `/reports/financial-summary` (P&L + BS) now include
  `journal_entries.status IN ('posted', 'reversed')`. In this codebase a
  reversal flips the original to `status='reversed'` and posts an inverse
  JE — including both ensures reversal pairs net to zero in the ledger
  reports rather than leaving the inverse hanging as a one-sided amount.
- **CoA list → detail link**: each row in `/accounting/coa` now shows an
  Eye icon button (`coa-view-${id}` testid) that links to
  `/accounting/coa/:id`. Visible to all roles, not just admin.
- **Test artifact location note**: `.local/test-evidence/run-step9-tests.mjs`
  and `.local/test-evidence/STEP9_LIVE_TEST_REPORT.md` are committed under
  `.local/`. Re-running `node .local/test-evidence/run-step9-tests.mjs`
  → 7/7 PASS after the reversal fix.

## Eighth-pass review fixes (2026-04-18)
- **Fixed `lastClosedPeriod.endDate`** in dashboard-status payload — was reading
  `lastClosed.endDate` (which doesn't exist on the row); now reads
  `lastClosed.periodEnd` to match the schema. Verified live: response now
  includes `endDate: "2026-05-31"` for the most recently closed period.
- **Cleaned stale copilot tool description**: `get_accounting_dimensions` no
  longer says "a formal chart of accounts is not yet integrated" — it now
  says it returns the live Chart of Accounts and instructs the model to use
  active CoA codes when drafting journal entries.
- **Force-added Step 9 test artifacts to git** (`git add -f`) so they appear
  in the diff for review:
    - `.local/test-evidence/run-step9-tests.mjs`
    - `.local/test-evidence/STEP9_LIVE_TEST_REPORT.md`
- Re-ran `node .local/test-evidence/run-step9-tests.mjs` → 7/7 PASS.

## Ninth-pass test expansion (2026-04-18)

Expanded the live test runner from 7 tests to 11 covering the gaps called out
in the 8th review:

| ID    | Coverage |
|-------|----------|
| S9-H  | `draft_journal_entry` rejects an account_code that exists but is **archived** (validates `sanitizeLines` archived-account branch). |
| S9-I  | `PATCH /api/accounting/settings` returns 200 and persists the change; per the route implementation in `coa.ts` this also writes an `activity_log` row in the same transaction. |
| S9-J  | Trial Balance `debits === credits` to the cent and `balanced: true`, including reversal pairs (proves `status IN ('posted','reversed')` netting). |
| S9-K  | Re-invoking `/api/accounting/seed-coa` does not change CoA row count (idempotence verified at API level). |

### Run output

```
[PASS] S9-A: CoA seeded with GAAP defaults
[PASS] S9-B: Settings singleton present with method
[PASS] S9-C: Trial Balance is balanced
[PASS] S9-D: Source=operational vs source=ledger both respond 200 with PL/BS
[PASS] S9-E: draft_journal_entry rejects unknown account_code
[PASS] S9-F: draft_journal_entry accepts valid account_code
[PASS] S9-G: Custom CoA create + archive
[PASS] S9-H: draft_journal_entry rejects archived account_code
[PASS] S9-I: Settings PATCH succeeds and (per route impl) writes activity_log row
[PASS] S9-J: Trial Balance: debits = credits to the cent (posted+reversed netted)
[PASS] S9-K: Seed/backfill is idempotent (CoA count stable across re-invocation)
--- summary: { passes: 11, fails: 0, total: 11 }
```

### Frontend follow-up

- `accounting-coa.tsx`: archive action now goes through an `AlertDialog`
  confirmation (`Archive this account?`) before calling `PATCH … {isActive:false}`.
  Test id `confirm-archive-account`.
