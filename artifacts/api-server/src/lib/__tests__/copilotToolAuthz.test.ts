/**
 * Task #116 / Task #126 — Accounting Copilot Authorization
 *
 * Regression tests for the TOOL_ROLE_SCOPES access matrix.
 *
 * Verifies that:
 *   1. Submitters are denied the seven sensitive tools that expose
 *      privileged organization-wide accounting data:
 *        - get_current_record
 *        - get_open_tasks
 *        - get_missing_receipts
 *        - get_reconciliation_status
 *        - search_internal_policies
 *        - get_accounting_dimensions  (Task #126: was incorrectly submitter-accessible)
 *        - search_chart_of_accounts   (Task #126: was incorrectly submitter-accessible)
 *   2. Admin and approver are still allowed on each of those tools.
 *   3. Submitter access is preserved for the non-privileged tools
 *      that submitters legitimately need:
 *        - get_current_page_context
 *        - draft_memo
 *        - escalate_to_human
 *
 * These are pure unit tests of `isToolAllowedForRole` — no database is
 * touched and no OpenAI connection is required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolAllowedForRole } from "../copilotTools";

const PRIVILEGED_TOOLS = [
  "get_current_record",
  "get_open_tasks",
  "get_missing_receipts",
  "get_reconciliation_status",
  "search_internal_policies",
  "get_accounting_dimensions",
  "search_chart_of_accounts",
] as const;

const SUBMITTER_TOOLS = [
  "get_current_page_context",
  "draft_memo",
  "escalate_to_human",
] as const;

// ---------------------------------------------------------------------------
// 1. Privileged tools must deny submitters (the core regression guard).
// ---------------------------------------------------------------------------

for (const tool of PRIVILEGED_TOOLS) {
  test(`submitter is denied access to privileged tool: ${tool}`, () => {
    const result = isToolAllowedForRole(tool, "submitter");
    assert.equal(
      result.allowed,
      false,
      `Expected submitter to be denied '${tool}' but got allowed=true`,
    );
    assert.ok(
      !result.allowed && result.reason.includes("submitter"),
      `Denial reason should mention 'submitter', got: ${!result.allowed && result.reason}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Admin and approver must still be allowed on all privileged tools.
// ---------------------------------------------------------------------------

for (const tool of PRIVILEGED_TOOLS) {
  for (const role of ["admin", "approver"] as const) {
    test(`${role} is allowed access to privileged tool: ${tool}`, () => {
      const result = isToolAllowedForRole(tool, role);
      assert.equal(
        result.allowed,
        true,
        `Expected ${role} to be allowed '${tool}' but got denied`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Submitter access is preserved for tools they legitimately need.
// ---------------------------------------------------------------------------

for (const tool of SUBMITTER_TOOLS) {
  test(`submitter retains access to non-privileged tool: ${tool}`, () => {
    const result = isToolAllowedForRole(tool, "submitter");
    assert.equal(
      result.allowed,
      true,
      `Expected submitter to be allowed '${tool}' but got denied`,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Admin-only drafting tools remain inaccessible to submitters.
// ---------------------------------------------------------------------------

for (const tool of ["create_followup_task", "draft_journal_entry"] as const) {
  test(`submitter is denied admin-only drafting tool: ${tool}`, () => {
    const result = isToolAllowedForRole(tool, "submitter");
    assert.equal(result.allowed, false);
  });
}

// ---------------------------------------------------------------------------
// 5. Unknown tools are always denied (closed-world policy).
// ---------------------------------------------------------------------------

test("unknown tool is denied for every role", () => {
  for (const role of ["admin", "approver", "submitter"] as const) {
    const result = isToolAllowedForRole("nonexistent_tool", role);
    assert.equal(
      result.allowed,
      false,
      `Expected every role to be denied an unknown tool; got allowed=true for ${role}`,
    );
  }
});
