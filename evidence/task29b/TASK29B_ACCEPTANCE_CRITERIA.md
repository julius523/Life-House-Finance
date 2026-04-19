# Task #29B — Manual JE approval workflow (frozen acceptance criteria)

**Date frozen:** 2026-04-19
**Origin:** Opened immediately after rejecting the original Task #29
merge (which delivered draft persistence only, now reclassified as
Task #29A). This is the real controlled-workflow follow-up.

**Pre-existing constraint:** Task #29A is in the codebase and may NOT
be torn out. Task #29B must build the approval workflow ON TOP of the
existing `manual_journal_entry_drafts` table (extending it with
status + approval columns) so the persistence work is not wasted.

**Posting service constraint:** the new "post approved draft"
endpoint must call the existing `postManualJournalEntry` service from
`artifacts/api-server/src/lib/postingService.ts` — the same service
behind the Task 25A idempotency-protected route. No second posting
implementation. No bypass.

---

## Frozen requirements (verbatim from user, 2026-04-19)

Reject this merge as **Task #29**.

Reason:
It does **not** satisfy the frozen acceptance gate. It delivers draft persistence only, not the controlled draft → submit → approve → reject → post workflow required by the authoritative checklist.

Reclassify the merged work as:

**Task #29A — Manual JE draft persistence**

Keep it, because it is useful and did not break previously accepted accounting behavior.

Open the actual required follow-up as:

**Task #29B — Manual JE approval workflow**

Task #29B must include all of the following:

1. Draft workflow states

   * draft
   * submitted
   * approved
   * rejected
   * posted or equivalent immutable linkage state

2. Required server-side fields

   * submitted_by_user_id
   * submitted_at
   * approved_by_user_id
   * approved_at
   * rejected_by_user_id
   * rejected_at
   * rejection_reason

3. Required endpoints

   * create draft
   * edit draft
   * submit draft
   * approve draft
   * reject draft
   * post approved draft

4. Separation of duties

   * enforce server-side no-self-approval
   * must honor `accounting_settings.separationOfDuties`
   * UI enforcement alone is not sufficient

5. Posting path

   * posting an approved draft must internally reuse the existing Task 25A hardened idempotent posting path
   * no bypass route
   * no separate posting implementation

6. Audit linkage

   * posted journal entry must link back to the originating manual draft and approval chain
   * add queryable linkage such as `journal_entries.manual_draft_id` or equivalent
   * do not destroy linkage by deleting the draft record on success

7. Activity log coverage

   * create
   * edit
   * submit
   * approve
   * reject
   * post

8. Acceptance gate
   Do not accept Task #29B unless these are proven with live evidence:

   * server-side no-self-approval
   * approved-draft post reuses Task 25A idempotent path
   * posted JE links to the approval chain
   * all required activity_log rows exist
   * Step 8 / Step 8 edge / Step 9 / Task #25 / Task 25A regressions remain green

Current merged work is safe to keep as a narrower feature, but it must not be represented as the approved manual JE workflow.
