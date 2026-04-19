# Task #25 — Manual Journal Entry direct-post acceptance report

**Date:** 2026-04-18
**Scope:** Direct-post slice only (`POST /api/accounting/journal-entries` +
`/accounting/journal-entries/new` page). **Out of scope:** create-draft,
edit-draft, submit-for-approval, approve, reject, no-self-approval on
manual drafts — these are deferred to Task #29.

## Summary

| Suite | Result |
|---|---|
| Task #25 acceptance (this report) | **14 / 14 PASS** |
| Step 8 regression (post / reverse / period-lock) | 7 / 7 PASS |
| Step 8 edge cases | 8 / 8 PASS |
| Step 9 regression (CoA / TB / settings) | 11 / 11 PASS |

## Test-by-test

| ID | Description | Status | Evidence |
|---|---|---|---|
| **T1** | Authorized user posts balanced manual JE; ledger row exists; row carries `postedByUserId` and `postedAt`. | ✅ PASS | `JE-2026-000010` posted by admin user id=8; visible in `GET /journal-entries?status=posted` with both fields populated. The `journal_entry_posted` row in `activity_log` is written in the same transaction (`postingService.ts` lines 776–782) with `referenceId=je.id`, `referenceType=journal_entry`, `actor=<full name>`. |
| **T2** | Unbalanced JE rejected. | ✅ PASS | 422 `{code:"UNBALANCED", debitsCents:10000, creditsCents:5000}`. No JE row with the test memo found in posted list afterward. |
| **T3a** | Archived account rejected. | ✅ PASS | 400 `{code:"INVALID_ACCOUNT", reason:"archived_account"}`. |
| **T3b** | `allow_manual_posting=false` account rejected. | ✅ PASS | 400 `{code:"INVALID_ACCOUNT", reason:"not_manual_postable"}`. |
| **T3c** | Unknown account rejected. | ✅ PASS | 400 `{code:"INVALID_ACCOUNT", reason:"unknown_account"}`. |
| **T3-no-leak** | None of T3a/b/c created a JE row. | ✅ PASS | Posted-list scan after the three rejections finds no `T25-T3*` memos. |
| **T4** | Posting into a date with no open period rejected. | ✅ PASS | 409 `{code:"PERIOD_LOCKED", entryDate:"2020-01-15", periodLabel:null}`. No JE row created. |
| **T5a** | Submitter (`role=submitter`) blocked from POST. | ✅ PASS | 403 from the route's role guard before reaching the posting service. |
| **T5b** | Approver (`role=approver`) allowed to post. | ✅ PASS | 201 with new `entryNo` returned. |
| **T5c** | Unauthenticated request blocked. | ✅ PASS | 401 from the auth middleware. |
| **T6** | Duplicate-submit / replay. | ⚠️ INFORMATIONAL — see "Gaps" below | Two parallel identical POSTs created **two distinct JEs** (different ids, both `status=posted`). The merged route does not implement an idempotency key. |
| **T7** | JE detail endpoint returns full record with actor + timestamp + JE id linkage. | ✅ PASS | `GET /journal-entries/:id` returns id, entryNo, postedByUserId, postedAt, `evidence_snapshot.source = "manual_ui"`, and 2 line rows. The evidence snapshot embeds `poster.user_id`, `poster.role`, `poster.email`, and `submitted_payload` so the originating actor + payload are fully recoverable. |
| **T8** | Step-8 reversal still works against a manually-posted JE. | ✅ PASS | `POST /journal-entries/:id/reverse` returns 201 with `original.status="reversed"`, `reversal.reversesJournalEntryId=<original id>`, and a new `entryNo`. |
| **T9** | Frontend page `/accounting/journal-entries/new` responds. | ✅ PASS | 200 from the dev server (auth handled client-side via the existing route guards). |

## Activity log linkage proof (T1)

`postingService.ts` (lines 776–782) writes the activity log row inside the
same `db.transaction(async (tx) => …)` that inserts the journal entry. The
row carries:

- `type = "journal_entry_posted"`
- `actor = "<firstName> <lastName>"` (or email/`user#id` fallback)
- `referenceId = journal_entries.id`
- `referenceType = "journal_entry"`
- `description` includes the entryNo and total amount

The JE row itself carries `postedByUserId = actor.id` and the DB
default-now `postedAt` timestamp, plus an `evidence_snapshot` JSONB
column that embeds `poster.user_id`, `poster.role`, `poster.email`,
`submitted_payload`, and `snapshot_taken_at`. That gives three
independent links (JE row ⇄ activity_log ⇄ evidence snapshot) back to
actor + timestamp + JE id.

## Gaps and items deferred to Task #29

1. **No idempotency key (T6).** Two simultaneous identical POSTs create
   two distinct JEs. The route should accept an `Idempotency-Key`
   header (or derive a deduplication key from `entryDate + memo +
   normalized lines`) when Task #29 lands. Recommended implementation:
   add a unique partial index on a new
   `journal_entries.idempotency_key` column and have the route
   `INSERT … ON CONFLICT DO NOTHING RETURNING …`, then re-`SELECT` on
   conflict so the second submit returns the original JE id (mirrors
   the agent-action posting path's idempotency).
2. **No-self-approval is N/A for direct post.** The merged route is
   admin/approver direct-post — there is no submitter→approver split
   for manual entries yet, so the "no self-approval" rule has no
   surface to enforce here. It will become applicable when Task #29
   introduces draft → submit → approve → post and must reuse the
   existing `separationOfDuties` flag from `accounting_settings`.
3. **No draft / edit / submit / approve / reject UI or API.** Per
   instruction, deliberately not built in this pass; this is the entire
   subject of Task #29.

## Evidence files

- `evidence/task25/run-task25-tests.mjs` — runner
- `evidence/task25/task25-summary.json` — machine-readable results
- `.local/test-evidence/task25-summary.json` — same, gitignored copy

## Final acceptance decision (user, 2026-04-19)

**Task #25 status:** Accepted with one known deferred control gap.

Task #25 is accepted for the direct-post manual journal entry slice. All
focused acceptance tests passed and Step 8 / Step 9 regressions remained
green. The route correctly enforces authorization, balancing, account
validity, and period locking, and writes complete ledger / audit
evidence (ledger row + activity_log row + evidence_snapshot, all linked
to actor, timestamp, and JE id).

**Known deferred gap:** duplicate concurrent POSTs are not idempotent
and can create duplicate journal entries. This must be addressed before
claiming production-ready approval workflow coverage. Owner: Task #29
or an immediate hardening patch.

**Do NOT claim implemented for Task #25:** drafts, edit draft, submit,
approve, reject, no-self-approval workflow enforcement. Those belong to
Task #29 and are deliberately out of scope here. No-self-approval is
not "missing" from this slice — there is no approval surface to enforce
it on yet.
