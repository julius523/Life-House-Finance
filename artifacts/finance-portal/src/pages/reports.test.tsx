/**
 * Task #75 — Regression test that the Reports page survives partial date
 * typing in the From/To inputs.
 *
 * Background: prior to Task #60 the Reports page rendered dates with
 * `format(new Date(fromDate), ...)`, which throws `RangeError: Invalid
 * time value` on partial input like "2025-01-1". Because dates are
 * rendered during the render phase, that error white-screened the whole
 * page. Task #60 introduced `safeFormatDate` + `isValidRange` to gate
 * formatting and queries on a complete YYYY-MM-DD value.
 *
 * This test mounts the Reports page (with API hooks stubbed so we don't
 * need a backend) and exercises three failure modes that used to crash:
 *   1. Clearing the From input.
 *   2. Typing a partial date "2025-01-1" into the From input.
 *   3. Inverting the range (From > To).
 *
 * For each case we assert: (a) the page is still mounted and (b) no
 * `RangeError: Invalid time value` was thrown / logged. The inverted
 * case additionally asserts the warning banner appears instead of a
 * crash.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => {
  const noopQuery = () => ({
    data: undefined,
    isLoading: false,
    error: null,
  });
  return {
    useGetFinancialSummaryReport: noopQuery,
    useGetTrialBalanceReport: noopQuery,
    useGetAccountActivityReport: noopQuery,
    useGetReconciliationReport: noopQuery,
    useListAccountingPeriods: noopQuery,
    useListJournalEntryDrafts: noopQuery,
    getAccountActivityReport: vi.fn(async () => ({
      lines: [],
      totals: { debits: "0.00", credits: "0.00" },
    })),
    ListJournalEntryDraftsScope: { all: "all", mine: "mine" },
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import ReportsPage from "./reports";

const RANGE_ERROR_PATTERN = /Invalid time value|RangeError/i;

function captureConsoleErrors() {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args);
  });
  return {
    errors,
    restore: () => spy.mockRestore(),
  };
}

describe("Reports page — partial date input regression (Task #65 / #75)", () => {
  let consoleCapture: ReturnType<typeof captureConsoleErrors>;
  let windowErrors: ErrorEvent[];
  const onWindowError = (e: ErrorEvent) => windowErrors.push(e);

  beforeEach(() => {
    consoleCapture = captureConsoleErrors();
    windowErrors = [];
    window.addEventListener("error", onWindowError);
  });

  afterEach(() => {
    window.removeEventListener("error", onWindowError);
    consoleCapture.restore();
  });

  function assertNoInvalidTimeValue() {
    const flat = consoleCapture.errors
      .map((args) =>
        (args as unknown[])
          .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
          .join(" "),
      )
      .join("\n");
    expect(flat).not.toMatch(RANGE_ERROR_PATTERN);
    for (const e of windowErrors) {
      expect(`${e.message} ${String(e.error)}`).not.toMatch(RANGE_ERROR_PATTERN);
    }
  }

  it("does not crash when the From input is cleared", () => {
    render(<ReportsPage />);
    const fromInput = screen.getByLabelText("From") as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "" } });

    // The page is still mounted (heading present) and the gating banner
    // is shown instead of an error / unmounted tree.
    expect(
      screen.getByRole("heading", { name: /Reports/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("banner-invalid-range")).toBeInTheDocument();
    assertNoInvalidTimeValue();
  });

  it("does not crash on partial date input like '2025-01-1'", () => {
    render(<ReportsPage />);
    const fromInput = screen.getByLabelText("From") as HTMLInputElement;

    // jsdom normalizes invalid values on <input type="date"> to the
    // empty string before React's onChange reads them, so dispatching
    // "2025-01-1" through the input element ends up with state === ""
    // (which is itself one of the values that used to crash the page).
    // The cleared-input test below exercises the same downstream code
    // path; this case documents the partial-keystroke intent and pins
    // the behavior so it cannot regress without the test failing.
    fireEvent.change(fromInput, { target: { value: "2025-01-1" } });
    expect(fromInput.value).toBe("");
    expect(
      screen.getByRole("heading", { name: /Reports/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("banner-invalid-range")).toBeInTheDocument();
    assertNoInvalidTimeValue();
  });

  it("does not crash when the To input is cleared", () => {
    render(<ReportsPage />);
    const toInput = screen.getByLabelText("To") as HTMLInputElement;

    fireEvent.change(toInput, { target: { value: "" } });

    expect(
      screen.getByRole("heading", { name: /Reports/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("banner-invalid-range")).toBeInTheDocument();
    assertNoInvalidTimeValue();
  });

  it("shows the inverted-range warning banner when From > To (no crash)", () => {
    render(<ReportsPage />);
    const fromInput = screen.getByLabelText("From") as HTMLInputElement;
    const toInput = screen.getByLabelText("To") as HTMLInputElement;

    fireEvent.change(toInput, { target: { value: "2025-01-01" } });
    fireEvent.change(fromInput, { target: { value: "2025-12-31" } });

    expect(
      screen.getByRole("heading", { name: /Reports/i, level: 1 }),
    ).toBeInTheDocument();
    const banner = screen.getByTestId("banner-invalid-range");
    expect(banner).toBeInTheDocument();
    // The inverted-specific copy lives inside the banner.
    expect(banner.textContent ?? "").toMatch(
      /must be on or before the .To. date/i,
    );
    assertNoInvalidTimeValue();
  });
});
