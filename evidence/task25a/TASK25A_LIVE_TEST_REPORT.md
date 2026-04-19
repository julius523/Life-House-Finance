# Task 25A — Manual JE Idempotency Hardening — acceptance report

**Date:** 2026-04-19
**Scope:** `POST /api/accounting/journal-entries` only. Surgical patch.
No change to draft / approve / reject / reverse / Step 8 / Step 9 logic.

## Summary

| Suite | Result |
|---|---|
| **Task 25A acceptance (this report)** | **9 / 9 PASS** |
| Task #25 regression (manual-post slice) | 14 / 14 PASS |
| Step 8 regression (post / reverse / period-lock) | 7 / 7 PASS |
| Step 8 edge cases | 8 / 8 PASS |
| Step 9 regression (CoA / TB / settings) | 11 / 11 PASS |

## Implementation summary

1. **Schema (`lib/db/src/schema/journal_entries.ts`)** —
   added `idempotency_key text` column + a partial unique index
   `journal_entries_idempotency_key_uniq ON (idempotency_key) WHERE idempotency_key IS NOT NULL`.
   Pushed via `drizzle-kit push --force`.

2. **Service (`postingService.postManualJournalEntry`)** —
   accepts `idempotencyKey` and a caller-computed `fingerprint`.
   Flow:
   - Fast-path: `SELECT` by key. If hit → compare fingerprint
     → return existing JE (replay) or `kind:"idempotency_conflict"`.
   - Otherwise: run the existing transactional insert, now passing
     `idempotencyKey` into `journal_entries` and freezing the key +
     fingerprint into `evidence_snapshot.idempotency`.
   - Race guard: catch Postgres `23505` on
     `journal_entries_idempotency_key_uniq` *only*, then re-resolve via
     the same fast-path. Any other error is re-thrown unchanged.

3. **Route (`POST /accounting/journal-entries`)** —
   - Requires header `Idempotency-Key: <UUID>`. Missing → 400
     `IDEMPOTENCY_KEY_REQUIRED`. Non-UUID → 400 `IDEMPOTENCY_KEY_INVALID`.
   - Computes a stable `sha256` fingerprint over a normalized form of
     the logical payload: trimmed memo, entryDate, and lines sorted by
     `(type, account_code, amount_cents, program, fund, memo)` with
     amounts reduced to integer cents-as-string. Key reordering, JSON
     formatting, or `100` vs `100.00` cannot change the hash.
   - Maps service results:
     - `ok && !idempotent` → `201 { journalEntry, idempotent:false }`
     - `ok && idempotent` → `200 { journalEntry, idempotent:true }`
     - `idempotency_conflict` → `409 { code:"IDEMPOTENCY_CONFLICT", existingJournalEntryId }`
     - all existing failure kinds (forbidden / invalid_payload /
       unbalanced / invalid_account / period_locked) preserved verbatim.

## Exact response behavior

| Scenario | HTTP | Body |
|---|---|---|
| First request, valid key, valid payload | **201** | `{ journalEntry, idempotent: false }` |
| Same key, same payload (replay, sequential or racing) | **200** | `{ journalEntry: <SAME id>, idempotent: true }` |
| Same key, different payload | **409** | `{ code:"IDEMPOTENCY_CONFLICT", existingJournalEntryId, idempotencyKey }` |
| Missing `Idempotency-Key` | 400 | `{ code:"IDEMPOTENCY_KEY_REQUIRED" }` |
| Malformed key (not UUID) | 400 | `{ code:"IDEMPOTENCY_KEY_INVALID" }` |

## Test-by-test

| ID | Description | Status | Evidence |
|---|---|---|---|
| 25A-1 | Missing `Idempotency-Key` → 400 IDEMPOTENCY_KEY_REQUIRED | ✅ PASS | code returned matches |
| 25A-2 | Non-UUID key → 400 IDEMPOTENCY_KEY_INVALID | ✅ PASS | code returned matches |
| 25A-3 | Same key + same payload → first 201 (idempotent=false), replay 200 (idempotent=true), **same JE id** | ✅ PASS | first.jeId === replay.jeId |
| 25A-3-no-dup | Replay creates **no** second row in posted-list | ✅ PASS | exactly 1 row matches the test memo |
| 25A-4 | Same key + DIFFERENT payload → 409 IDEMPOTENCY_CONFLICT, references the original JE id | ✅ PASS | `existingJournalEntryId === first.jeId` |
| 25A-4-no-leak | Conflicted second payload creates no JE | ✅ PASS | 0 rows match the second-payload memo |
| **25A-5** | **8 parallel identical requests with the same key → exactly ONE JE created**, all 8 responses converge on the same id (1× 201, 7× 200) | **✅ PASS** | `created201:1, replay200:7, distinctJeIds:1, jeRowsForMemo:1` |
| 25A-6 | Sanity: same payload, **different keys** → two distinct JEs (so the dedupe is keyed on the header, not the payload) | ✅ PASS | distinct ids returned |
| 25A-7 | `evidence_snapshot.idempotency.{key,fingerprint}` stored on the JE; key matches the original request and fingerprint is a 64-char sha256 hex | ✅ PASS | stored key + fingerprint length 64 |

## Audit trail

- The first successful post writes the usual `activity_log` row
  (`type=journal_entry_posted`). Replays do NOT write a duplicate
  activity_log row (they do not enter the transaction at all on the
  fast path, and the catch-block path also short-circuits before the
  log insert) — this is the correct behavior: the JE was posted once,
  so it should appear in the activity feed once.
- The idempotency key + fingerprint are persisted inside
  `evidence_snapshot.idempotency`, so any future investigation of
  "why did this retry get 409" can compare the stored fingerprint
  against the new request payload.

## Constraints honored

- Patch is isolated to `journal_entries` schema, `postingService.ts`
  manual-post path, and the manual-post route. No change to draft /
  approve / reject (Task #29 surface), Step 8 reversal, Step 9 CoA /
  settings, or the agent-action posting flow.
- Period-lock, balance, account-validity, and role checks are
  unchanged and still enforced (verified by full Task #25 + Step 8 +
  Step 9 regression suites).
- No weakening of validation. The idempotency check only takes effect
  AFTER role + header validation pass; payload validation and posting
  rules still run on every first request.

## Status update

Task #25 carry-forward gap (concurrent duplicate posts) is now closed
at the database, service, and route layers. The endpoint is safe to
expose to retries, double-clicks, network replays, and parallel
duplicate submissions.
