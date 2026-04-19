Use this as the **Task #29 live acceptance checklist and test script**.

# Task #29 — Manual Journal Entry Draft → Submit → Approve → Post

## Merge-gate test script

Do not accept Task #29 unless every required test below passes with live evidence.

---

## A. Core lifecycle

### T29-01 — Create draft manual JE

**Goal:** authorized user can create a draft JE without posting it

**Steps**

1. Log in as a user allowed to create manual JE drafts.
2. Create a balanced JE draft with at least 2 lines.
3. Save as draft.

**Expect**

* draft record created
* status = `draft`
* no posted ledger impact
* no journal entry posted to the ledger tables
* activity_log row exists for draft creation
* actor, timestamp, reference id all present

---

### T29-02 — Edit existing draft

**Goal:** draft can be edited before submission

**Steps**

1. Open the draft from T29-01.
2. Change memo and one line amount.
3. Save changes.

**Expect**

* same draft id remains
* updated values persisted
* still status = `draft`
* no ledger posting
* activity_log row exists for draft edit
* audit trail shows before/after or equivalent evidence snapshot

---

### T29-03 — Reject invalid draft on save or submit

**Goal:** unbalanced or invalid-account draft cannot move forward incorrectly

**Steps**

1. Make draft unbalanced and try to save/submit.
2. Try a draft line with:

   * archived account
   * `allow_manual_posting=false`
   * unknown account

**Expect**

* clear validation failure
* no submit / no post
* no silent coercion
* no ledger posting

---

## B. Submission and approval controls

### T29-04 — Submit draft for approval

**Goal:** valid draft can be submitted

**Steps**

1. Use a valid balanced draft.
2. Submit for approval.

**Expect**

* status changes to submitted / pending approval
* submission timestamp recorded
* submitter user id recorded
* activity_log row exists for submit
* still no ledger posting at this stage

---

### T29-05 — Server-side no-self-approval block

**Goal:** submitter cannot approve own draft, even if UI is bypassed

**Steps**

1. As the same submitting user, attempt approval through the UI.
2. Attempt approval directly via API.

**Expect**

* both blocked
* API rejects server-side
* clean 4xx response
* no status transition to approved
* no posting occurs
* proof captured from API response, not just UI behavior

---

### T29-06 — Separate approver can approve

**Goal:** second authorized user can approve

**Steps**

1. Log in as different authorized approver.
2. Approve submitted draft.

**Expect**

* status changes to approved
* approver user id recorded
* approval timestamp recorded
* activity_log row exists for approval
* still no posting unless workflow intentionally posts immediately after approval; if it does, that must be explicit and tested separately below

---

### T29-07 — Rejection path works

**Goal:** approver can reject without posting

**Steps**

1. Create and submit a second valid draft.
2. Reject it with notes.

**Expect**

* status = rejected
* rejection note persisted
* approver/reviewer identity recorded
* activity_log row exists for reject
* no ledger posting

---

## C. Approval-to-post linkage and idempotent posting

### T29-08 — Approved draft posts through hardened posting path

**Goal:** posting from approved draft reuses Task 25A idempotency path

**Steps**

1. Take an approved draft.
2. Post it through the Task #29 workflow.

**Expect**

* real posted JE created
* posted JE linked back to source draft / approval record
* approver linkage queryable
* posting path uses idempotency-protected route/service, not a separate bypass implementation
* activity_log row exists for post
* ledger rows created exactly once

**Proof required**

* code-path proof or runtime evidence showing reuse of Task 25A path
* posted JE id
* draft id
* approval id or equivalent linkage
* poster / approver identities

---

### T29-09 — Idempotent retry on approved-draft posting

**Goal:** approved-draft post is protected against duplicate retries

**Steps**

1. Trigger posting twice with the same logical request / idempotency key.
2. Also test parallel duplicate submission if feasible.

**Expect**

* exactly one posted JE
* safe retry returns same JE
* no duplicates
* if same key + different payload is possible, returns conflict

---

## D. Audit trail completeness

### T29-10 — Full six-event activity coverage

**Goal:** all workflow stages are audit-logged

**Required event types**

1. create
2. edit
3. submit
4. approve
5. reject
6. post

**Expect for each**

* actor
* timestamp
* reference id
* enough metadata to reconstruct what happened

---

### T29-11 — JE detail + workflow audit trail are queryable

**Goal:** reviewer can inspect the full chain

**Steps**

1. Open JE detail for a posted draft-origin JE.
2. Retrieve linked workflow data.

**Expect**

* visible or queryable linkage from posted JE back to:

  * draft
  * submitter
  * approver
  * post event
* historical trail is intact
* no orphaned approval state

---

## E. Accounting behavior and regressions

### T29-12 — Step 8 reversal still works on JE posted through draft path

**Goal:** newly posted draft-origin JE behaves like every other posted JE

**Steps**

1. Reverse the JE created in T29-08 using Step 8 behavior.

**Expect**

* reversal succeeds under existing rules
* audit trail preserved
* no regression in reversal logic

---

### T29-13 — Regression battery

Run all of these:

* Step 8
* Step 8 edge cases
* Step 9
* Task #25
* Task 25A
* new Task #29 suite

**Expect**

* all green

---

## F. Access matrix

### T29-14 — Role enforcement

Prove exact server-side permissions for:

* create draft
* edit own draft
* submit
* approve
* reject
* post approved draft
* view detail

**Expect**

* unauthorized roles blocked server-side
* no permissions enforced only in UI

---

## Required evidence files

Produce:

* `evidence/task29/TASK29_LIVE_TEST_REPORT.md`
* `evidence/task29/run-task29-tests.mjs`
* `evidence/task29/task29-summary.json`

Include in the report:

* pass/fail table
* response payloads for critical tests
* explicit proof of server-side no-self-approval
* explicit proof of approval-to-post linkage
* explicit proof that Task 25A idempotency path is reused
* explicit list of anything not implemented

## Acceptance rule

Do **not** mark Task #29 accepted unless:

* no-self-approval is proven server-side
* approved drafts post exactly once through the hardened idempotent path
* all six activity events are logged
* posted JE links back to the approval chain
* regressions remain green
