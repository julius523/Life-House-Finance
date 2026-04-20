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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockTrialBalanceData, getAccountActivityReportMock } = vi.hoisted(
  () => ({
    mockTrialBalanceData: {
      current: undefined as
        | undefined
        | {
            fromDate: string | null;
            toDate: string | null;
            rows: Array<{
              accountId: number | null;
              code: string;
              name: string;
              type: string | null;
              subtype: string | null;
              normalBalance: "debit" | "credit";
              isActive: boolean;
              debits: string;
              credits: string;
              balance: string;
              balanceSide: "debit" | "credit";
            }>;
            totals: {
              debits: string;
              credits: string;
              balanced: boolean;
              differenceCents: number;
            };
          },
    },
    getAccountActivityReportMock: vi.fn(async () => ({
      lines: [],
      totals: { debits: "0.00", credits: "0.00" },
    })),
  }),
);

vi.mock("@workspace/api-client-react", () => {
  const noopQuery = () => ({
    data: undefined,
    isLoading: false,
    error: null,
  });
  return {
    useGetFinancialSummaryReport: () =>
      mockTrialBalanceData.current
        ? {
            data: {
              generatedAt: new Date().toISOString(),
              fromDate: "2025-01-01",
              toDate: "2025-12-31",
              expenseTotalsByStatus: [],
              billTotalsByStatus: [],
              spendByProgram: [],
              topVendors: [],
              missingReceiptCount: 0,
              missingReceiptAmount: 0,
              missingReceipts: [],
              bankReconciliation: {
                accounts: [],
                totals: { ledgerBalance: 0, statementBalance: 0, deltaCents: 0 },
              },
              profitAndLoss: {
                totalIncome: 0,
                totalExpenses: 0,
                netIncome: 0,
                incomeByProgram: [],
                expensesByProgram: [],
                uncategorizedIncome: 0,
                uncategorizedExpenses: 0,
                incomeByAccount: [],
                expensesByAccount: [],
              },
              balanceSheet: {
                cash: 0,
                cashOnHand: 0,
                accountsReceivable: 0,
                otherAssets: 0,
                accountsPayable: 0,
                otherLiabilities: 0,
                equity: 0,
                totalAssets: 0,
                totalLiabilities: 0,
                cashAccounts: [],
                accountsReceivableAccounts: [],
                otherAssetAccounts: [],
                accountsPayableAccounts: [],
                otherLiabilityAccounts: [],
              },
            },
            isLoading: false,
            error: null,
          }
        : { data: undefined, isLoading: false, error: null },
    useGetTrialBalanceReport: () => ({
      data: mockTrialBalanceData.current,
      isLoading: false,
      error: null,
    }),
    useGetAccountActivityReport: noopQuery,
    useGetReconciliationReport: noopQuery,
    useListAccountingPeriods: noopQuery,
    useListJournalEntryDrafts: noopQuery,
    getAccountActivityReport: getAccountActivityReportMock,
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

  it("Trial Balance bulk activity button is always rendered, but disabled when there are no rows to export (Task #84)", () => {
    mockTrialBalanceData.current = {
      fromDate: null,
      toDate: null,
      rows: [],
      totals: {
        debits: "0.00",
        credits: "0.00",
        balanced: true,
        differenceCents: 0,
      },
    };
    render(<ReportsPage />);
    const btn = screen.getByTestId(
      "export-csv-tb-all-activity",
    ) as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/no trial balance activity/i);
    mockTrialBalanceData.current = undefined;
  });

  it("Trial Balance bulk activity button fetches activity for every mapped account and produces a sectioned CSV (Task #84)", async () => {
    mockTrialBalanceData.current = {
      fromDate: null,
      toDate: null,
      rows: [
        {
          accountId: 101,
          code: "1000",
          name: "Operating Cash",
          type: "asset",
          subtype: "cash",
          normalBalance: "debit",
          isActive: true,
          debits: "500.00",
          credits: "0.00",
          balance: "500.00",
          balanceSide: "debit",
        },
        {
          accountId: 4000,
          code: "4000",
          name: "Program Income",
          type: "income",
          subtype: null,
          normalBalance: "credit",
          isActive: true,
          debits: "0.00",
          credits: "500.00",
          balance: "500.00",
          balanceSide: "credit",
        },
        {
          accountId: null,
          code: "(unmapped)",
          name: "legacy:misc",
          type: null,
          subtype: null,
          normalBalance: "debit",
          isActive: true,
          debits: "0.00",
          credits: "0.00",
          balance: "0.00",
          balanceSide: "debit",
        },
      ],
      totals: {
        debits: "500.00",
        credits: "500.00",
        balanced: true,
        differenceCents: 0,
      },
    };

    getAccountActivityReportMock.mockClear();
    getAccountActivityReportMock.mockImplementation(
      async ({ accountId }: { accountId: number }) => ({
        lines: [
          {
            entryDate: "2025-01-15",
            entryNo: `JE-${accountId}-1`,
            entryMemo: "memo",
            lineMemo: "line",
            program: null,
            fund: null,
            debit: accountId === 101 ? "500.00" : "0.00",
            credit: accountId === 101 ? "0.00" : "500.00",
          },
        ],
        totals: {
          debits: accountId === 101 ? "500.00" : "0.00",
          credits: accountId === 101 ? "0.00" : "500.00",
        },
      }),
    );

    // Stub anchor click + URL.createObjectURL so downloadCsv doesn't try to
    // navigate jsdom. Capture the resulting Blob so we can inspect the CSV.
    const createdBlobs: Blob[] = [];
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob: Blob | MediaSource) => {
        createdBlobs.push(blob as Blob);
        return "blob:test";
      });
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      render(<ReportsPage />);
      const btn = screen.getByTestId("export-csv-tb-all-activity");
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);

      await waitFor(() => {
        expect(getAccountActivityReportMock).toHaveBeenCalledTimes(2);
      });

      const calledIds = getAccountActivityReportMock.mock.calls
        .map((c) => (c[0] as { accountId: number }).accountId)
        .sort((a, b) => a - b);
      expect(calledIds).toEqual([101, 4000]);

      await waitFor(() => {
        expect(createdBlobs.length).toBe(1);
      });
      const csv = await createdBlobs[0].text();
      expect(csv).toContain("Trial Balance — all account activity");
      expect(csv).toContain("1000,Operating Cash");
      expect(csv).toContain("4000,Program Income");
      expect(csv).toContain("group=asset");
      expect(csv).toContain("group=income");
      expect(csv).toContain("JE-101-1");
      expect(csv).toContain("JE-4000-1");
      // Unmapped rows are surfaced as their own section with a NOTE marker
      // and the Trial-Balance-level totals (no per-line activity, since the
      // activity API requires a numeric accountId).
      expect(csv).toContain("(unmapped)");
      expect(csv).toContain("legacy:misc");
      expect(csv).toContain("group=unmapped");
      expect(csv).toContain("Per-line activity unavailable");
      expect(csv).toContain("TOTALS (from Trial Balance)");
    } finally {
      anchorClickSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      mockTrialBalanceData.current = undefined;
    }
  });

  it("shows 'Preparing N of M…' progress on the bulk activity button while exports are in flight (Task #85)", async () => {
    mockTrialBalanceData.current = {
      fromDate: null,
      toDate: null,
      rows: [
        {
          accountId: 101,
          code: "1000",
          name: "Operating Cash",
          type: "asset",
          subtype: "cash",
          normalBalance: "debit",
          isActive: true,
          debits: "500.00",
          credits: "0.00",
          balance: "500.00",
          balanceSide: "debit",
        },
        {
          accountId: 4000,
          code: "4000",
          name: "Program Income",
          type: "income",
          subtype: null,
          normalBalance: "credit",
          isActive: true,
          debits: "0.00",
          credits: "500.00",
          balance: "500.00",
          balanceSide: "credit",
        },
      ],
      totals: {
        debits: "500.00",
        credits: "500.00",
        balanced: true,
        differenceCents: 0,
      },
    };

    // Defer each per-account fetch so the test can observe the button label
    // updating between fetches.
    const deferreds: {
      resolve: (v: unknown) => void;
      accountId: number;
    }[] = [];
    getAccountActivityReportMock.mockClear();
    getAccountActivityReportMock.mockImplementation(
      ({ accountId }: { accountId: number }) =>
        new Promise((resolve) => {
          deferreds.push({ resolve, accountId });
        }),
    );

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => "blob:test");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      render(<ReportsPage />);
      const btn = screen.getByTestId(
        "export-csv-tb-all-activity",
      ) as HTMLButtonElement;
      fireEvent.click(btn);

      // Initial label after click: 0 of 2.
      await waitFor(() => {
        expect(btn.textContent).toMatch(/Preparing 0 of 2/);
      });
      expect(btn.disabled).toBe(true);

      // Resolve the first fetch -> label should advance to 1 of 2.
      await waitFor(() => {
        expect(deferreds.length).toBeGreaterThanOrEqual(1);
      });
      const first = deferreds[0]!;
      first.resolve({
        lines: [],
        totals: { debits: "0.00", credits: "0.00" },
      });
      await waitFor(() => {
        expect(btn.textContent).toMatch(/Preparing 1 of 2/);
      });

      // Resolve the second; the export then completes and the button returns
      // to its idle label.
      await waitFor(() => {
        expect(deferreds.length).toBe(2);
      });
      deferreds[1]!.resolve({
        lines: [],
        totals: { debits: "0.00", credits: "0.00" },
      });
      await waitFor(() => {
        expect(btn.textContent).toMatch(/Download all activity/);
      });
      expect(btn.disabled).toBe(false);
    } finally {
      anchorClickSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      mockTrialBalanceData.current = undefined;
    }
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
