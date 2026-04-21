/**
 * Task #104 — Tests for the Integrity Findings UI.
 *
 * Covers:
 *   - sortChecks ordering (severity → -count → name).
 *   - groupAndOrderChecks: critical hoist + fixed category order, drops
 *     zero-count rows.
 *   - linkForSampleRef per kind (incl. opaque kinds → null).
 *   - buildIntegrityCsvRows: header order, multi-row per check, the
 *     "count > 0 with zero sample refs" case, zero-count omission, and
 *     visual-truncation vs CSV-completeness.
 *   - IntegrityReportView render: critical-hoist + categorized sections
 *     in the right order, link wiring, all-OK banner-only state.
 *   - AdminIntegrityPage: loading skeleton, error banner with retry,
 *     Re-run disabled while fetching.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import type { IntegritySweepReport } from "@workspace/db/integrity-types";

// ---- Mocks must be hoisted -------------------------------------------------
const { useQueryMock, customFetchMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  customFetchMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: (...args: unknown[]) => customFetchMock(...args),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import AdminIntegrityPage, {
  IntegrityReportView,
  buildIntegrityCsvRows,
  groupAndOrderChecks,
  linkForSampleRef,
  sortChecks,
} from "./admin-integrity";

afterEach(() => {
  vi.clearAllMocks();
});

function check(
  partial: Partial<IntegritySweepReport["checks"][number]>,
): IntegritySweepReport["checks"][number] {
  return {
    key: "k",
    name: "Check",
    category: "structural",
    severity: "info",
    count: 1,
    sampleRefs: [],
    ...partial,
  };
}

function withRouter(node: React.ReactNode) {
  return <WouterRouter base="">{node}</WouterRouter>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("sortChecks", () => {
  it("orders by severity, then descending count, then name asc", () => {
    const sorted = sortChecks([
      check({ key: "a", name: "Bravo", severity: "warning", count: 5 }),
      check({ key: "b", name: "Alpha", severity: "critical", count: 1 }),
      check({ key: "c", name: "Alpha", severity: "warning", count: 5 }),
      check({ key: "d", name: "Echo", severity: "info", count: 99 }),
      check({ key: "e", name: "Delta", severity: "warning", count: 10 }),
    ]).map((c) => c.key);
    // critical first; then warnings sorted by count desc then name asc;
    // info last.
    expect(sorted).toEqual(["b", "e", "c", "a", "d"]);
  });
});

describe("groupAndOrderChecks", () => {
  it("hoists every critical with count > 0 and groups the rest in fixed order", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T00:00:00.000Z",
      ok: false,
      totalChecks: 6,
      failingChecks: 5,
      checks: [
        check({
          key: "rem1",
          category: "remediation",
          severity: "warning",
          count: 3,
        }),
        check({
          key: "crit1",
          category: "structural",
          severity: "critical",
          count: 2,
        }),
        check({
          key: "struct1",
          category: "structural",
          severity: "warning",
          count: 4,
        }),
        check({
          key: "miss1",
          category: "missing_bridge",
          severity: "info",
          count: 1,
        }),
        check({
          key: "zero",
          category: "structural",
          severity: "warning",
          count: 0,
        }),
        check({
          key: "crit-zero",
          category: "reversal",
          severity: "critical",
          count: 0,
        }),
      ],
    };
    const g = groupAndOrderChecks(report);
    expect(g.critical.map((c) => c.key)).toEqual(["crit1"]);
    expect(g.categorized.map((s) => s.category)).toEqual([
      "structural",
      "missing_bridge",
      "remediation",
    ]);
    // crit1 was hoisted out of the structural section, leaving only
    // struct1 there.
    expect(g.categorized[0].checks.map((c) => c.key)).toEqual(["struct1"]);
  });

  it("returns no groups when every check has count 0", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T00:00:00.000Z",
      ok: true,
      totalChecks: 1,
      failingChecks: 0,
      checks: [check({ key: "k", count: 0 })],
    };
    const g = groupAndOrderChecks(report);
    expect(g.critical).toEqual([]);
    expect(g.categorized).toEqual([]);
  });
});

describe("linkForSampleRef", () => {
  it("maps each kind to the documented route or null", () => {
    expect(linkForSampleRef({ kind: "expense", id: "7" })).toBe(
      "/expenses/7",
    );
    expect(linkForSampleRef({ kind: "bill", id: "8" })).toBe("/bills/8");
    expect(linkForSampleRef({ kind: "journal_entry", id: "9" })).toBe(
      "/accounting/journal-entries/9",
    );
    expect(linkForSampleRef({ kind: "draft", id: "10" })).toBe(
      "/accounting/journal-entry-drafts/10",
    );
    expect(linkForSampleRef({ kind: "source_link", id: "11" })).toBeNull();
    expect(linkForSampleRef({ kind: "other", id: "12" })).toBeNull();
  });
});

describe("buildIntegrityCsvRows", () => {
  const report: IntegritySweepReport = {
    generatedAt: "2026-04-21T12:00:00.000Z",
    ok: false,
    totalChecks: 4,
    failingChecks: 3,
    checks: [
      check({
        key: "noSamples",
        name: "No samples but failing",
        category: "structural",
        severity: "critical",
        count: 5,
        sampleRefs: [],
      }),
      check({
        key: "multi",
        name: "Multi sample",
        category: "posted_line",
        severity: "warning",
        count: 30,
        sampleRefs: [
          { kind: "journal_entry", id: "1" },
          { kind: "journal_entry", id: "2" },
          { kind: "expense", id: "3" },
        ],
      }),
      check({
        key: "skip",
        name: "Zero count",
        category: "remediation",
        severity: "info",
        count: 0,
        sampleRefs: [],
      }),
    ],
  };

  it("emits the documented header in the documented order", () => {
    const rows = buildIntegrityCsvRows(report);
    expect(rows[0]).toEqual([
      "generatedAt",
      "checkKey",
      "checkName",
      "category",
      "severity",
      "count",
      "sampleKind",
      "sampleId",
    ]);
  });

  it("emits one empty-sample row when count > 0 and sampleRefs is empty", () => {
    const rows = buildIntegrityCsvRows(report);
    const noSamples = rows.filter((r) => r[1] === "noSamples");
    expect(noSamples).toHaveLength(1);
    expect(noSamples[0]).toEqual([
      "2026-04-21T12:00:00.000Z",
      "noSamples",
      "No samples but failing",
      "structural",
      "critical",
      5,
      "",
      "",
    ]);
  });

  it("emits one row per sample ref, with full count repeated on each", () => {
    const rows = buildIntegrityCsvRows(report);
    const multi = rows.filter((r) => r[1] === "multi");
    expect(multi).toHaveLength(3);
    expect(multi.map((r) => [r[6], r[7]])).toEqual([
      ["journal_entry", "1"],
      ["journal_entry", "2"],
      ["expense", "3"],
    ]);
    // count column is the FULL count, not the number of sample rows.
    expect(multi.every((r) => r[5] === 30)).toBe(true);
  });

  it("omits zero-count checks entirely", () => {
    const rows = buildIntegrityCsvRows(report);
    expect(rows.some((r) => r[1] === "skip")).toBe(false);
  });

  it("includes every returned sample ref even when the UI would truncate", () => {
    // Simulate a check with more sample refs than the visual cap (10).
    const big: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 1,
      failingChecks: 1,
      checks: [
        check({
          key: "big",
          name: "Many",
          category: "posted_line",
          severity: "warning",
          count: 25,
          sampleRefs: Array.from({ length: 25 }, (_, i) => ({
            kind: "expense" as const,
            id: String(i + 1),
          })),
        }),
      ],
    };
    const rows = buildIntegrityCsvRows(big);
    // 25 sample rows + 1 header = 26
    expect(rows).toHaveLength(26);
    expect(rows[1][7]).toBe("1");
    expect(rows[25][7]).toBe("25");
  });
});

// ---------------------------------------------------------------------------
// Component rendering
// ---------------------------------------------------------------------------

describe("IntegrityReportView", () => {
  it("renders only the success banner when ok=true", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: true,
      totalChecks: 12,
      failingChecks: 0,
      checks: [],
    };
    render(withRouter(<IntegrityReportView report={report} />));
    expect(screen.getByTestId("integrity-all-ok")).toBeInTheDocument();
    expect(
      screen.queryByTestId("integrity-critical-section"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("integrity-section-structural"),
    ).not.toBeInTheDocument();
  });

  it("renders critical hoist + categorized sections with link wiring", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 4,
      failingChecks: 3,
      checks: [
        check({
          key: "crit_struct",
          name: "Critical structural",
          category: "structural",
          severity: "critical",
          count: 2,
          sampleRefs: [{ kind: "expense", id: "42" }],
        }),
        check({
          key: "warn_remed",
          name: "Warning remediation",
          category: "remediation",
          severity: "warning",
          count: 3,
          sampleRefs: [
            { kind: "journal_entry", id: "100" },
            { kind: "draft", id: "101" },
            { kind: "bill", id: "102" },
            { kind: "source_link", id: "opaque-xyz" },
          ],
        }),
        check({
          key: "info_post",
          name: "Info posted line",
          category: "posted_line",
          severity: "info",
          count: 1,
          sampleRefs: [],
        }),
      ],
    };
    const { container } = render(
      withRouter(<IntegrityReportView report={report} />),
    );

    // Critical section appears and is positioned BEFORE the categorized
    // sections in DOM order.
    const sections = container.querySelectorAll("[data-testid^='integrity-']");
    const ids = Array.from(sections)
      .map((el) => el.getAttribute("data-testid"))
      .filter(
        (id): id is string =>
          !!id &&
          (id === "integrity-critical-section" ||
            id.startsWith("integrity-section-")),
      );
    expect(ids).toEqual([
      "integrity-critical-section",
      "integrity-section-posted_line",
      "integrity-section-remediation",
    ]);

    // Critical row links the expense by id.
    const expenseLink = screen.getByTestId("sample-link-expense-42");
    expect(expenseLink).toHaveAttribute("href", "/expenses/42");

    // Remediation samples wire to their kind-specific routes.
    expect(screen.getByTestId("sample-link-journal_entry-100")).toHaveAttribute(
      "href",
      "/accounting/journal-entries/100",
    );
    expect(screen.getByTestId("sample-link-draft-101")).toHaveAttribute(
      "href",
      "/accounting/journal-entry-drafts/101",
    );
    expect(screen.getByTestId("sample-link-bill-102")).toHaveAttribute(
      "href",
      "/bills/102",
    );

    // Opaque kinds render the id but NO link.
    expect(
      screen.queryByTestId("sample-link-source_link-opaque-xyz"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("sample-ref-source_link-opaque-xyz"),
    ).toBeInTheDocument();
  });

  it("orders rows within a section by severity, then count desc, then name", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 4,
      failingChecks: 4,
      checks: [
        check({
          key: "z_warn_low",
          name: "Z warn low",
          category: "remediation",
          severity: "warning",
          count: 2,
        }),
        check({
          key: "a_warn_high",
          name: "A warn high",
          category: "remediation",
          severity: "warning",
          count: 9,
        }),
        check({
          key: "m_info",
          name: "M info",
          category: "remediation",
          severity: "info",
          count: 100,
        }),
      ],
    };
    render(withRouter(<IntegrityReportView report={report} />));
    const section = screen.getByTestId("integrity-section-remediation");
    const rows = within(section).getAllByTestId(/^integrity-check-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "integrity-check-a_warn_high",
      "integrity-check-z_warn_low",
      "integrity-check-m_info",
    ]);
  });

  it("shows a 'showing N of <count>' hint when sample refs visually truncate", () => {
    const sampleRefs = Array.from({ length: 15 }, (_, i) => ({
      kind: "expense" as const,
      id: String(i + 1),
    }));
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 1,
      failingChecks: 1,
      checks: [
        check({
          key: "many",
          name: "Many",
          category: "posted_line",
          severity: "warning",
          count: 200,
          sampleRefs,
        }),
      ],
    };
    render(withRouter(<IntegrityReportView report={report} />));
    expect(screen.getByTestId("integrity-trunc-many").textContent).toMatch(
      /showing 10 of 200/,
    );

    // Even though the UI only renders 10, the CSV export still contains
    // all 15 returned sample refs.
    const rows = buildIntegrityCsvRows(report);
    const sampleRows = rows.filter((r) => r[1] === "many");
    expect(sampleRows).toHaveLength(15);
  });
});

// ---------------------------------------------------------------------------
// Page-level loading / error / Re-run gating
// ---------------------------------------------------------------------------

describe("AdminIntegrityPage", () => {
  it("renders a loading skeleton and disables Re-run while fetching", () => {
    useQueryMock.mockReturnValueOnce({
      data: undefined,
      error: null,
      isFetching: true,
      refetch: vi.fn(),
    });
    render(withRouter(<AdminIntegrityPage />));
    expect(screen.getByTestId("integrity-loading")).toBeInTheDocument();
    const rerun = screen.getByTestId("integrity-rerun");
    expect(rerun).toBeDisabled();
    expect(screen.getByTestId("integrity-export")).toBeDisabled();
  });

  it("renders an inline error with a Retry button on failure", () => {
    const refetch = vi.fn();
    useQueryMock.mockReturnValueOnce({
      data: undefined,
      error: new Error("boom"),
      isFetching: false,
      refetch,
    });
    render(withRouter(<AdminIntegrityPage />));
    expect(screen.getByTestId("integrity-error")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    const retry = screen.getByTestId("integrity-retry");
    expect(retry).not.toBeDisabled();
  });

  it("renders the report and enables CSV export once data is loaded", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 2,
      failingChecks: 1,
      checks: [
        check({
          key: "x",
          name: "X",
          category: "structural",
          severity: "warning",
          count: 1,
          sampleRefs: [{ kind: "expense", id: "1" }],
        }),
      ],
    };
    useQueryMock.mockReturnValueOnce({
      data: report,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(withRouter(<AdminIntegrityPage />));
    expect(screen.getByTestId("integrity-export")).not.toBeDisabled();
    expect(screen.getByTestId("integrity-rerun")).not.toBeDisabled();
    expect(
      screen.getByTestId("integrity-section-structural"),
    ).toBeInTheDocument();
  });

  it("renders only the success banner (no metadata line) when ok=true", () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: true,
      totalChecks: 7,
      failingChecks: 0,
      checks: [],
    };
    useQueryMock.mockReturnValueOnce({
      data: report,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(withRouter(<AdminIntegrityPage />));
    expect(screen.getByTestId("integrity-all-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("integrity-meta")).not.toBeInTheDocument();
  });

  it("shows inline feedback when clipboard copy fails", async () => {
    const report: IntegritySweepReport = {
      generatedAt: "2026-04-21T12:00:00.000Z",
      ok: false,
      totalChecks: 1,
      failingChecks: 1,
      checks: [
        check({
          key: "x",
          name: "X",
          category: "structural",
          severity: "warning",
          count: 1,
          sampleRefs: [{ kind: "expense", id: "77" }],
        }),
      ],
    };
    useQueryMock.mockReturnValueOnce({
      data: report,
      error: null,
      isFetching: false,
      refetch: vi.fn(),
    });
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(withRouter(<AdminIntegrityPage />));
    const copyBtn = screen.getByTestId("sample-copy-expense-77");
    copyBtn.click();
    const err = await screen.findByTestId("sample-copy-error-expense-77");
    expect(err).toHaveTextContent("denied");
  });
});
