/**
 * Task #83 — Round-trip tests for the URL <-> editor-state codec on the
 * Journal Export Schedules page.
 *
 * The schedule editor is a modal dialog whose open/close state and filter
 * pickers are mirrored to the URL query string so a partially-configured
 * schedule can be shared via deep link (matching Task #72 on the
 * journal-entries list). These tests pin down:
 *   - read/build are inverses for every supported state
 *   - default values are stripped from the URL (clean shareable links)
 *   - missing/garbage values fall back to defaults instead of throwing
 *   - the `editing` param drives dialog open/close and "new" vs "edit:<id>"
 */

import { describe, it, expect } from "vitest";
import {
  readEditorFromSearch,
  buildEditorSearch,
} from "./journal-export-schedules";

describe("journal-export-schedules URL codec (Task #83)", () => {
  it("returns a closed dialog for an empty query string", () => {
    const s = readEditorFromSearch("");
    expect(s.editing).toBeNull();
    expect(s.filterStatus).toBe("all");
    expect(s.filterSource).toBe("all");
    expect(s.postedByFilter).toBe("any");
    expect(s.approverFilter).toBe("any");
    expect(s.cadence).toBe("weekly");
  });

  it("returns an empty search string when the dialog is closed", () => {
    expect(
      buildEditorSearch({
        editing: null,
        filterStatus: "posted",
        filterSource: "manual",
        postedByFilter: "12",
        approverFilter: "34",
        cadence: "daily",
      }),
    ).toBe("");
  });

  it("opens in 'new' mode and omits default filters", () => {
    const qs = buildEditorSearch({
      editing: { mode: "new" },
      filterStatus: "all",
      filterSource: "all",
      postedByFilter: "any",
      approverFilter: "any",
      cadence: "weekly",
    });
    expect(qs).toBe("editing=new");
    expect(readEditorFromSearch(qs).editing).toEqual({ mode: "new" });
  });

  it("round-trips a fully-configured edit URL", () => {
    const qs = buildEditorSearch({
      editing: { mode: "edit", id: 7 },
      filterStatus: "posted",
      filterSource: "expense",
      postedByFilter: "12",
      approverFilter: "34",
      cadence: "monthly",
    });
    // Order is fixed by the builder; document it so accidental reorders
    // get caught by review.
    expect(qs).toBe(
      "editing=7&status=posted&source=expense&postedBy=12&approver=34&cadence=monthly",
    );
    expect(readEditorFromSearch(qs)).toEqual({
      editing: { mode: "edit", id: 7 },
      filterStatus: "posted",
      filterSource: "expense",
      postedByFilter: "12",
      approverFilter: "34",
      cadence: "monthly",
    });
  });

  it("treats unknown enum values and non-numeric ids as defaults", () => {
    const s = readEditorFromSearch(
      "editing=banana&status=garbage&source=garbage&postedBy=abc&approver=&cadence=hourly",
    );
    expect(s.editing).toBeNull();
    expect(s.filterStatus).toBe("all");
    expect(s.filterSource).toBe("all");
    expect(s.postedByFilter).toBe("any");
    expect(s.approverFilter).toBe("any");
    expect(s.cadence).toBe("weekly");
  });

  it("accepts every documented source value", () => {
    for (const src of ["copilot", "manual", "expense", "bill"] as const) {
      const s = readEditorFromSearch(`editing=new&source=${src}`);
      expect(s.filterSource).toBe(src);
    }
  });

  it("accepts every documented cadence value", () => {
    for (const cad of ["daily", "weekly", "monthly"] as const) {
      const s = readEditorFromSearch(`editing=new&cadence=${cad}`);
      expect(s.cadence).toBe(cad);
    }
    // Default cadence (weekly) is omitted from the URL on the way out.
    const qsDaily = buildEditorSearch({
      editing: { mode: "new" },
      filterStatus: "all",
      filterSource: "all",
      postedByFilter: "any",
      approverFilter: "any",
      cadence: "daily",
    });
    expect(qsDaily).toBe("editing=new&cadence=daily");
  });

  it("derives a distinct session key for each editing target", () => {
    // Regression guard for the back/forward stale-nonFilter bug. The
    // hydration effect uses `editing.mode === 'new' ? 'new' : 'edit:<id>'`
    // as the session key; this test pins that those keys are distinct so a
    // navigation between ?editing=5 and ?editing=7 is detectable as a
    // session change.
    const a = readEditorFromSearch("editing=5").editing;
    const b = readEditorFromSearch("editing=7").editing;
    const c = readEditorFromSearch("editing=new").editing;
    expect(a).toEqual({ mode: "edit", id: 5 });
    expect(b).toEqual({ mode: "edit", id: 7 });
    expect(c).toEqual({ mode: "new" });
    // Same id parses to a structurally equal mode object.
    expect(readEditorFromSearch("editing=5").editing).toEqual(a);
  });

  it("preserves a leading editing= when the dialog is open with one filter", () => {
    const qs = buildEditorSearch({
      editing: { mode: "edit", id: 99 },
      filterStatus: "all",
      filterSource: "all",
      postedByFilter: "5",
      approverFilter: "any",
      cadence: "weekly",
    });
    expect(qs).toBe("editing=99&postedBy=5");
    expect(readEditorFromSearch(qs)).toEqual({
      editing: { mode: "edit", id: 99 },
      filterStatus: "all",
      filterSource: "all",
      postedByFilter: "5",
      approverFilter: "any",
      cadence: "weekly",
    });
  });
});
