#!/usr/bin/env node
/**
 * Task #29B — Manual Journal Entry approval workflow acceptance.
 *
 * Verifies the full state machine:
 *   draft → submit → approve → reject → post
 *
 * with server-side maker/checker enforcement, deterministic per-draft
 * idempotent posting via the existing postManualJournalEntry service,
 * and a complete activity_log trail for all six transition types.
 *
 * Test users (existing seeded):
 *   submitter user A — lifeup@lifehousereentry.com   role: submitter (cannot draft)
 *   approver user B  — brittney@lifehousereentry.com role: approver (can draft + approve)
 *   admin    user C  — kai@lifehousereentry.com      role: admin
 *
 * Drafts can only be created by admin/approver. The "submitter" of a
 * draft = whoever calls /submit (role admin or approver). User B will
 * play the submitter role (creates + submits), user C will play the
 * approver role (approves + posts).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.API_BASE ?? "http://localhost:8080";
const results = [];

function log(...a) {
  console.log(
    ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))),
  );
}
function record(id, desc, ok, evidence) {
  results.push({ id, desc, pass: !!ok, evidence: evidence ?? null });
  log(`[${ok ? "PASS" : "FAIL"}] ${id}: ${desc}`, evidence ?? {});
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} → ${r.status} ${await r.text()}`);
  return { cookie: r.headers.get("set-cookie").split(";")[0], email };
}

async function api(s, method, url, body, headers = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      Cookie: s.cookie,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await r.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: r.status, data };
}

function buildPayload(memoTag) {
  return {
    payload: {
      entryDate: "2026-04-15",
      memo: `T29B ${memoTag} ${randomUUID().slice(0, 8)}`,
      lines: [
        {
          type: "debit",
          accountCode: "1000",
          amount: "12.34",
          program: "",
          fund: "",
          memo: "",
        },
        {
          type: "credit",
          accountCode: "4000",
          amount: "12.34",
          program: "",
          fund: "",
          memo: "",
        },
      ],
    },
  };
}

(async () => {
  log("---", "Task #29B — Manual JE approval workflow acceptance");

  const submitter = await login(
    "brittney@lifehousereentry.com",
    "StepSevenTest!2026",
  );
  const approver = await login(
    "kai@lifehousereentry.com",
    "StepSevenTest!2026",
  );

  // ------------------------------------------------------------------
  // T1 — create draft as submitter
  const create = await api(
    submitter,
    "POST",
    "/api/accounting/journal-entry-drafts",
    buildPayload("T1-create"),
  );
  const draftId = create.data?.draft?.id;
  record(
    "T1",
    "Submitter creates draft → 201, status='draft', id present",
    create.status === 201 &&
      create.data?.draft?.status === "draft" &&
      Number.isInteger(draftId),
    {
      status: create.status,
      draftStatus: create.data?.draft?.status,
      draftId,
    },
  );

  // ------------------------------------------------------------------
  // T2 — edit draft (PATCH)
  const editBody = buildPayload("T1-edited");
  const edit = await api(
    submitter,
    "PATCH",
    `/api/accounting/journal-entry-drafts/${draftId}`,
    editBody,
  );
  record(
    "T2",
    "Submitter edits draft (PATCH) → 200, payload updated, still status='draft'",
    edit.status === 200 &&
      edit.data?.draft?.status === "draft" &&
      edit.data?.draft?.payload?.memo === editBody.payload.memo,
    {
      status: edit.status,
      draftStatus: edit.data?.draft?.status,
      memoMatches:
        edit.data?.draft?.payload?.memo === editBody.payload.memo,
    },
  );

  // ------------------------------------------------------------------
  // T3 — submit
  const submit = await api(
    submitter,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/submit`,
  );
  record(
    "T3",
    "Submitter submits draft → 200, status='submitted', submittedByUserId set",
    submit.status === 200 &&
      submit.data?.draft?.status === "submitted" &&
      Number.isInteger(submit.data?.draft?.submittedByUserId) &&
      submit.data?.draft?.submittedAt,
    {
      status: submit.status,
      draftStatus: submit.data?.draft?.status,
      submittedBy: submit.data?.draft?.submittedByUserId,
      submittedAt: submit.data?.draft?.submittedAt,
    },
  );

  // ------------------------------------------------------------------
  // T4 — submitted draft cannot be edited
  const editBlocked = await api(
    submitter,
    "PATCH",
    `/api/accounting/journal-entry-drafts/${draftId}`,
    buildPayload("T4-after-submit"),
  );
  record(
    "T4",
    "Submitted draft cannot be edited → 409 DRAFT_NOT_EDITABLE",
    editBlocked.status === 409 &&
      editBlocked.data?.code === "DRAFT_NOT_EDITABLE",
    { status: editBlocked.status, code: editBlocked.data?.code },
  );

  // ------------------------------------------------------------------
  // T5 — submitter cannot approve their own draft (no self-approval)
  const selfApprove = await api(
    submitter,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/approve`,
  );
  record(
    "T5",
    "Submitter cannot approve their own draft → 403 NO_SELF_APPROVAL (server-side)",
    selfApprove.status === 403 &&
      selfApprove.data?.code === "NO_SELF_APPROVAL",
    { status: selfApprove.status, code: selfApprove.data?.code },
  );

  // ------------------------------------------------------------------
  // T6 — different reviewer approves
  const approve = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/approve`,
  );
  record(
    "T6",
    "Different reviewer approves → 200, status='approved', approvedByUserId set and != submittedByUserId",
    approve.status === 200 &&
      approve.data?.draft?.status === "approved" &&
      Number.isInteger(approve.data?.draft?.approvedByUserId) &&
      approve.data?.draft?.approvedByUserId !==
        approve.data?.draft?.submittedByUserId,
    {
      status: approve.status,
      draftStatus: approve.data?.draft?.status,
      approvedBy: approve.data?.draft?.approvedByUserId,
      submittedBy: approve.data?.draft?.submittedByUserId,
    },
  );

  // ------------------------------------------------------------------
  // T7 — approver posts the approved draft to the ledger
  const post = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/post`,
  );
  const jeId = post.data?.journalEntry?.id;
  record(
    "T7",
    "Approver posts approved draft → 201, JE created via postManualJournalEntry, draft.status='posted', JE.manualDraftId === draftId",
    post.status === 201 &&
      post.data?.idempotent === false &&
      post.data?.draft?.status === "posted" &&
      post.data?.draft?.postedJournalEntryId === jeId &&
      post.data?.journalEntry?.manualDraftId === draftId,
    {
      status: post.status,
      idempotent: post.data?.idempotent,
      draftStatus: post.data?.draft?.status,
      jeId,
      jeManualDraftId: post.data?.journalEntry?.manualDraftId,
      draftPostedJeId: post.data?.draft?.postedJournalEntryId,
    },
  );

  // ------------------------------------------------------------------
  // T8 — replay /post is idempotent (no duplicate JE)
  const replay = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/post`,
  );
  record(
    "T8",
    "Replayed /post → 200 idempotent=true, same JE id, no duplicate row",
    replay.status === 200 &&
      replay.data?.idempotent === true &&
      replay.data?.journalEntry?.id === jeId,
    {
      status: replay.status,
      idempotent: replay.data?.idempotent,
      jeId: replay.data?.journalEntry?.id,
    },
  );

  // Confirm by-memo there is exactly one ledger row
  const list = await api(
    approver,
    "GET",
    `/api/accounting/journal-entries?status=posted&limit=500`,
  );
  const memoMatch = (list.data?.entries ?? []).filter(
    (e) => e.memo === editBody.payload.memo,
  );
  record(
    "T8-no-dup",
    "Ledger has exactly ONE posted JE for this draft (no duplicate row from replay)",
    memoMatch.length === 1 && memoMatch[0]?.id === jeId,
    { matchCount: memoMatch.length, matchedId: memoMatch[0]?.id, jeId },
  );

  // ------------------------------------------------------------------
  // T9 — once posted, draft cannot be edited / deleted / re-submitted
  const editPosted = await api(
    submitter,
    "PATCH",
    `/api/accounting/journal-entry-drafts/${draftId}`,
    buildPayload("T9-after-post"),
  );
  const delPosted = await api(
    submitter,
    "DELETE",
    `/api/accounting/journal-entry-drafts/${draftId}`,
  );
  const submitPosted = await api(
    submitter,
    "POST",
    `/api/accounting/journal-entry-drafts/${draftId}/submit`,
  );
  record(
    "T9",
    "Posted draft is locked: PATCH→409, DELETE→409, /submit→409",
    editPosted.status === 409 &&
      delPosted.status === 409 &&
      submitPosted.status === 409,
    {
      patch: editPosted.status,
      del: delPosted.status,
      submit: submitPosted.status,
    },
  );

  // ------------------------------------------------------------------
  // T10 — full reject path on a SECOND draft
  const create2 = await api(
    submitter,
    "POST",
    "/api/accounting/journal-entry-drafts",
    buildPayload("T10-reject-path"),
  );
  const d2 = create2.data?.draft?.id;
  await api(submitter, "POST", `/api/accounting/journal-entry-drafts/${d2}/submit`);
  // Reject without reason → 400
  const rejectNoReason = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${d2}/reject`,
    {},
  );
  // Reject with valid reason → 200
  const reject = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${d2}/reject`,
    { reason: "Wrong account on credit line. Please fix." },
  );
  // Resubmit allowed after rejection
  const resubmit = await api(
    submitter,
    "POST",
    `/api/accounting/journal-entry-drafts/${d2}/submit`,
  );
  record(
    "T10",
    "Reject flow: 400 without reason, 200 with reason → status='rejected', resubmit allowed → status='submitted'",
    rejectNoReason.status === 400 &&
      reject.status === 200 &&
      reject.data?.draft?.status === "rejected" &&
      reject.data?.draft?.rejectionReason &&
      resubmit.status === 200 &&
      resubmit.data?.draft?.status === "submitted",
    {
      noReason: rejectNoReason.status,
      reject: {
        status: reject.status,
        draftStatus: reject.data?.draft?.status,
        reason: reject.data?.draft?.rejectionReason,
      },
      resubmit: {
        status: resubmit.status,
        draftStatus: resubmit.data?.draft?.status,
      },
    },
  );

  // ------------------------------------------------------------------
  // T11 — invalid state transitions
  // Approve a draft that's only in 'draft' (never submitted) → 409
  const create3 = await api(
    submitter,
    "POST",
    "/api/accounting/journal-entry-drafts",
    buildPayload("T11-invalid-transitions"),
  );
  const d3 = create3.data?.draft?.id;
  const approveDraft = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${d3}/approve`,
  );
  const postDraft = await api(
    approver,
    "POST",
    `/api/accounting/journal-entry-drafts/${d3}/post`,
  );
  record(
    "T11",
    "Cannot approve a 'draft' (never submitted), cannot /post a non-approved draft → 409 INVALID_STATE_TRANSITION",
    approveDraft.status === 409 &&
      approveDraft.data?.code === "INVALID_STATE_TRANSITION" &&
      postDraft.status === 409 &&
      postDraft.data?.code === "INVALID_STATE_TRANSITION",
    {
      approve: { status: approveDraft.status, code: approveDraft.data?.code },
      post: { status: postDraft.status, code: postDraft.data?.code },
    },
  );
  // cleanup
  await api(submitter, "DELETE", `/api/accounting/journal-entry-drafts/${d3}`);

  // ------------------------------------------------------------------
  // T12 — activity_log has all 6 event types for this draft
  // Use admin notifications/activity feed. We use a direct query helper
  // route if available; otherwise pull recent activity and filter by
  // referenceId.
  const activityResp = await api(
    approver,
    "GET",
    `/api/dashboard/recent-activity?limit=500`,
  );
  const rows = Array.isArray(activityResp.data) ? activityResp.data : [];
  // Filter to rows that reference draft #draftId
  const draftEvents = rows.filter(
    (r) =>
      Number(r.referenceId ?? r.reference_id) === draftId &&
      (r.referenceType === "manual_journal_entry_draft" ||
        r.reference_type === "manual_journal_entry_draft"),
  );
  const types = new Set(draftEvents.map((r) => r.type));
  const wanted = [
    "manual_je_draft_created",
    "manual_je_draft_edited",
    "manual_je_draft_submitted",
    "manual_je_draft_approved",
    "manual_je_draft_posted",
  ];
  const presentForDraft = wanted.filter((t) => types.has(t));
  // Plus: a 'manual_je_draft_rejected' must exist for the SECOND draft
  const d2Events = rows.filter(
    (r) =>
      Number(r.referenceId ?? r.reference_id) === d2 &&
      (r.referenceType === "manual_journal_entry_draft" ||
        r.reference_type === "manual_journal_entry_draft"),
  );
  const d2Types = new Set(d2Events.map((r) => r.type));
  // Plus: a 'journal_entry_posted' must reference the JE
  const jePostedRows = rows.filter(
    (r) =>
      r.type === "journal_entry_posted" &&
      Number(r.referenceId ?? r.reference_id) === jeId,
  );
  record(
    "T12",
    "activity_log carries all 6 event types: created, edited, submitted, approved, rejected, posted (+ ledger journal_entry_posted)",
    presentForDraft.length === wanted.length &&
      d2Types.has("manual_je_draft_rejected") &&
      jePostedRows.length === 1,
    {
      draftEventTypes: Array.from(types).sort(),
      d2EventTypes: Array.from(d2Types).sort(),
      jePostedRowCount: jePostedRows.length,
      activityEndpointFound: rows.length > 0,
    },
  );

  // ------------------------------------------------------------------
  // T13 — JE detail row carries manualDraftId AND idempotency.key='manual-draft-{id}'
  const jeDetail = await api(
    approver,
    "GET",
    `/api/accounting/journal-entries/${jeId}`,
  );
  record(
    "T13",
    "Posted JE row links back to draft: journalEntry.manualDraftId === draftId AND evidence_snapshot.idempotency.key === 'manual-draft-{id}'",
    jeDetail.status === 200 &&
      jeDetail.data?.journalEntry?.manualDraftId === draftId &&
      jeDetail.data?.journalEntry?.evidenceSnapshot?.idempotency?.key ===
        `manual-draft-${draftId}`,
    {
      manualDraftId: jeDetail.data?.journalEntry?.manualDraftId,
      idempotencyKey:
        jeDetail.data?.journalEntry?.evidenceSnapshot?.idempotency?.key,
      expectedKey: `manual-draft-${draftId}`,
    },
  );

  // ------------------------------------------------------------------
  const passes = results.filter((r) => r.pass).length;
  const failures = results.filter((r) => !r.pass);
  log("--- Task #29B summary:", {
    total: results.length,
    passes,
    failures: failures.length,
    failed: failures.map((f) => f.id),
  });
  const dir = path.resolve("evidence/task29b");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task29b-summary.json"),
    JSON.stringify(
      { results, passes, total: results.length, draftId, draft2Id: d2, jeId },
      null,
      2,
    ),
  );
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
