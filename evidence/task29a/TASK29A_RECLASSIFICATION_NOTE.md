# Task #29A — Manual JE draft persistence (reclassified from rejected Task #29)

**Date:** 2026-04-19
**Decision (user):** Reject the merged work as Task #29. Reclassify it as
**Task #29A — Manual JE draft persistence**. Open
**Task #29B — Manual JE approval workflow** as the real follow-up.

The merged code is **kept** because:
- It is useful in its own right (accountants can save and resume work).
- It did not regress any previously accepted accounting behavior
  (49 / 49 prior regression cases still pass).

It must **not** be represented as the controlled draft → submit →
approve → reject → post workflow. That work is Task #29B.

---

## Original verdict report (reasoning behind the rejection)

# Task #29 — Verification verdict against frozen acceptance criteria

**Date:** 2026-04-19
**Verdict:** **REJECT as Task #29.** What merged is materially different
from what the frozen 14-test acceptance script (committed at
`evidence/task29/TASK29_ACCEPTANCE_CRITERIA.md`) demanded.

## Regressions (the good news)

| Suite | Result |
|---|---|
| Step 8 | 7 / 7 PASS |
| Step 8 edge cases | 8 / 8 PASS |
| Step 9 | 11 / 11 PASS |
| Task #25 | 14 / 14 PASS |
| Task 25A | 9 / 9 PASS |

The merge did not break any prior accounting control. The direct-post
slice and its idempotency hardening still work as accepted.

## What was actually built

A single-purpose **draft persistence** layer. From the schema's own
header comment (`lib/db/src/schema/manual_journal_entry_drafts.ts`,
lines 25–27):

> "Posting a draft is a separate operation: the client posts the entry
> via the existing `/accounting/journal-entries` endpoint and then
> deletes the draft on success."

Endpoints added:
- `GET /accounting/journal-entry-drafts?scope=mine|all`
- `POST /accounting/journal-entry-drafts`
- `GET /accounting/journal-entry-drafts/:id`
- `PATCH /accounting/journal-entry-drafts/:id`
- `DELETE /accounting/journal-entry-drafts/:id`

Schema fields: `id`, `createdByUserId`, `entryDate`, `memo`, `payload`,
`createdAt`, `updatedAt`. **There is no `status` column, no
`submittedByUserId`, no `approvedByUserId`, no approval timestamp, no
rejection reason.**

The frontend Save / Update / Discard / Resume buttons work; the list
page shows a Drafts card. Posting from a draft uses the existing
direct-post route — same path the user can hit without ever creating a
draft.

## Why this fails the frozen acceptance gate

Per the frozen merge gate:

> Do not accept Task #29 unless approval, posting, idempotency reuse,
> and audit linkage are all proven with live evidence.

| Frozen test | Status | Why |
|---|---|---|
| T29-01 Create draft | ⚠️ Partially supportable | Draft row is created, but **no activity_log row is written** — the new draft routes never call `activityLogTable`. |
| T29-02 Edit draft | ⚠️ Partially supportable | Same issue — PATCH writes the row but no activity_log entry. |
| T29-03 Reject invalid draft on save/submit | ❌ N/A | "Save tolerates incomplete/invalid lines" by design (per merge note). There is no submit step to validate against. |
| **T29-04 Submit draft for approval** | ❌ **STRUCTURALLY MISSING** | No submit endpoint exists. There is no `pending_approval` status, no submit timestamp, no submitter linkage. |
| **T29-05 Server-side no-self-approval block** | ❌ **STRUCTURALLY MISSING** | There is no concept of approval to enforce. Cannot prove what does not exist. |
| **T29-06 Separate approver can approve** | ❌ **STRUCTURALLY MISSING** | No approve endpoint. No `approved` status. No approver linkage. |
| **T29-07 Rejection path** | ❌ **STRUCTURALLY MISSING** | No reject endpoint. No `rejected` status. No rejection note column. |
| **T29-08 Approved draft posts through Task 25A path** | ❌ **STRUCTURALLY MISSING** | There is no approval. The "post" is the same direct-post route any admin/approver could hit without a draft. The posted JE has **no FK back to the draft** (`agentActionId` is null, no `manualDraftId` column exists). The draft is best-effort-deleted on success — the audit linkage is destroyed, not preserved. |
| **T29-09 Idempotent retry on approved-draft posting** | ⚠️ Inherits Task 25A | The post route is unchanged, so 25A's idempotency still works — but only because the new "draft post" is just the old direct-post under a different button. |
| **T29-10 Six-event activity coverage** (create / edit / submit / approve / reject / post) | ❌ **FAILS** | Only `post` writes to activity_log (and only because that's the existing direct-post path). The four new draft routes write zero activity_log rows. Submit/approve/reject events do not exist to log. |
| T29-11 Workflow audit trail queryable | ❌ FAILS | Posted JE has no draft id, no submitter id (other than poster), no approver id distinct from poster. |
| T29-12 Step 8 reversal still works | ✅ Confirmed by regression | Reversal works on any JE posted via the direct-post route. |
| T29-13 Regression battery | ✅ 49 / 49 PASS | See top of report. |
| T29-14 Role enforcement | ⚠️ Partial | Draft routes correctly require admin/approver. But there is no submit/approve/reject role matrix to enforce, because those operations do not exist. |

## Specific non-negotiables that are NOT met

The user (2026-04-19) explicitly stated:

> "The two things I care most about when it lands are: server-side
> no-self-approval proof, and proof that approved manual drafts post
> through the existing Task 25A idempotent path, not a side door."

- **Server-side no-self-approval: NOT PROVABLE.** No approval surface
  exists. There is nothing for a server-side check to gate.
- **Approved manual drafts post through Task 25A idempotent path: NOT
  PROVABLE.** There are no "approved manual drafts" — there are only
  drafts and direct posts. The post path is unchanged from Task #25,
  so any admin/approver can post WITHOUT going through the draft at
  all. The draft system can be entirely bypassed.

## Recommended decision

1. **Reject this merge as Task #29.** It does not satisfy the frozen
   merge gate.
2. **Reclassify what was built as a smaller delivered feature** (e.g.
   "Task #29A — Manual JE draft persistence"). It is real value — let
   accountants save and resume work — and the ledger surface is
   untouched, so it is safe to keep in the codebase.
3. **Open a new task — call it Task #29B "Manual JE approval workflow"**
   — that delivers what the frozen 14-test script actually requires:
   - `status` column on `manual_journal_entry_drafts` with values
     `draft | pending_approval | approved | rejected | posted`
   - `submitted_by_user_id`, `submitted_at`, `approver_user_id`,
     `approved_at`, `rejection_reason` columns (or a separate
     `manual_journal_entry_approvals` audit table)
   - new endpoints: `POST .../drafts/:id/submit`,
     `POST .../drafts/:id/approve`, `POST .../drafts/:id/reject`,
     `POST .../drafts/:id/post`
   - server-side no-self-approval gate honoring
     `accounting_settings.separationOfDuties`
   - the new `.../post` endpoint MUST internally reuse the Task 25A
     posting service (`postManualJournalEntry`), passing the draft id
     as the idempotency key (or a derived key) so the existing
     idempotency-key + fingerprint protection covers approval-driven
     posting end-to-end
   - the resulting JE row must carry a new
     `journal_entries.manual_draft_id` FK so post → approval → submit
     → draft is queryable in one join
   - `activity_log` rows for create / edit / submit / approve /
     reject / post (six event types as specified)
4. **Do not start the new automation work** (expense/bill → JE) until
   29B lands and is accepted.

## Audit trail of this verdict

- Frozen acceptance criteria: `evidence/task29/TASK29_ACCEPTANCE_CRITERIA.md`
- Regression evidence: this report (top section)
- Schema-level proof of missing fields: `lib/db/src/schema/manual_journal_entry_drafts.ts`
- Route-level proof of missing endpoints: `artifacts/api-server/src/routes/accounting.ts` lines 2073–2342 contain only GET/POST/GET:id/PATCH/DELETE for drafts; no submit/approve/reject handlers exist anywhere in the file.
