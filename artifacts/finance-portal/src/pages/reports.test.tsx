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

const {
  mockTrialBalanceData,
  getAccountActivityReportMock,
  mockSummaryOverride,
  useGetAccountActivityReportImpl,
} = vi.hoisted(() => ({
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
  mockSummaryOverride: { current: undefined as undefined | unknown },
  useGetAccountActivityReportImpl: {
    current: ((_args: unknown, _opts: unknown) => ({
      data: undefined as unknown,
      isLoading: false,
      error: null,
    })) as (
      args: { accountId: number; from?: string; to: string },
      opts?: { query?: { enabled?: boolean } },
    ) => { data: unknown; isLoading: boolean; error: unknown },
  },
}));

vi.mock("@workspace/api-client-react", () => {
  const noopQuery = () => ({
    data: undefined,
    isLoading: false,
    error: null,
  });
  return {
    useGetFinancialSummaryReport: () =>
      mockSummaryOverride.current
        ? {
            data: mockSummaryOverride.current,
            isLoading: false,
            error: null,
          }
        : mockTrialBalanceData.current
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
    useGetAccountActivityReport: (
      args: { accountId: number; from?: string; to: string },
      opts?: { query?: { enabled?: boolean } },
    ) => useGetAccountActivityReportImpl.current(args, opts),
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

  it("cancels an in-flight bulk activity export, stops further per-account fetches, skips the CSV, and re-enables all bulk buttons (Task #94)", async () => {
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

    // Defer each per-account fetch and reject with an AbortError when the
    // signal aborts so the loop sees the same shape as the real fetch.
    const deferreds: {
      reject: (e: unknown) => void;
      resolve: (v: unknown) => void;
      accountId: number;
    }[] = [];
    getAccountActivityReportMock.mockClear();
    getAccountActivityReportMock.mockImplementation(
      (
        { accountId }: { accountId: number },
        opts?: { signal?: AbortSignal },
      ) =>
        new Promise((resolve, reject) => {
          deferreds.push({ resolve, reject, accountId });
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

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
      const tbBtn = screen.getByTestId(
        "export-csv-tb-all-activity",
      ) as HTMLButtonElement;
      fireEvent.click(tbBtn);

      // Wait until the export is in flight (first fetch dispatched).
      await waitFor(() => {
        expect(deferreds.length).toBeGreaterThanOrEqual(1);
      });
      expect(tbBtn.textContent).toMatch(/Preparing/);

      // Cancel button should be rendered while the export is running.
      const cancelBtn = screen.getByTestId(
        "export-csv-tb-all-activity-cancel",
      ) as HTMLButtonElement;
      fireEvent.click(cancelBtn);

      // Bulk button returns to its idle label and re-enables.
      await waitFor(() => {
        expect(tbBtn.textContent).toMatch(/Download all activity/);
      });
      expect(tbBtn.disabled).toBe(false);

      // The cancel button is removed from the DOM once the export stops.
      expect(
        screen.queryByTestId("export-csv-tb-all-activity-cancel"),
      ).toBeNull();

      // No CSV was produced for the cancelled export.
      expect(createdBlobs.length).toBe(0);

      // Only the first per-account fetch was issued; the loop did not
      // continue after cancel.
      expect(getAccountActivityReportMock).toHaveBeenCalledTimes(1);
    } finally {
      anchorClickSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      mockTrialBalanceData.current = undefined;
    }
  });

  it("bulk activity CSV surfaces an ERROR row for a failed per-account fetch instead of silently skipping the account (Task #96)", async () => {
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
          accountId: 5000,
          code: "5000",
          name: "Program Expenses",
          type: "expense",
          subtype: null,
          normalBalance: "debit",
          isActive: true,
          debits: "200.00",
          credits: "0.00",
          balance: "200.00",
          balanceSide: "debit",
        },
      ],
      totals: {
        debits: "700.00",
        credits: "500.00",
        balanced: false,
        differenceCents: 20000,
      },
    };

    // Fail the middle account; other accounts succeed normally. The bulk
    // loop must catch the rejection and write an ERROR row instead of
    // silently dropping the section, so reviewers can see which account
    // failed.
    getAccountActivityReportMock.mockClear();
    getAccountActivityReportMock.mockImplementation(
      async ({ accountId }: { accountId: number }) => {
        if (accountId === 4000) {
          throw new Error("backend exploded for 4000");
        }
        return {
          lines: [
            {
              entryDate: "2025-01-15",
              entryNo: `JE-${accountId}-1`,
              entryMemo: "memo",
              lineMemo: "line",
              program: null,
              fund: null,
              debit: accountId === 101 ? "500.00" : "0.00",
              credit: accountId === 101 ? "0.00" : "200.00",
            },
          ],
          totals: {
            debits: accountId === 101 ? "500.00" : "0.00",
            credits: accountId === 101 ? "0.00" : "200.00",
          },
        };
      },
    );

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
      fireEvent.click(btn);

      await waitFor(() => {
        expect(getAccountActivityReportMock).toHaveBeenCalledTimes(3);
      });
      await waitFor(() => {
        expect(createdBlobs.length).toBe(1);
      });

      const csv = await createdBlobs[0].text();

      // Failed-account section is still present: ACCOUNT marker, header
      // row, and an ERROR row carrying the underlying error message — not
      // silently skipped.
      expect(csv).toContain("ACCOUNT,4000,Program Income");
      const lines = csv.split("\n");
      const failedIdx = lines.findIndex((l) =>
        l.startsWith("ACCOUNT,4000,Program Income"),
      );
      expect(failedIdx).toBeGreaterThanOrEqual(0);
      expect(lines[failedIdx + 1]).toMatch(/^entry_date,entry_no,/);
      expect(lines[failedIdx + 2]).toMatch(/^ERROR,/);
      expect(lines[failedIdx + 2]).toContain("backend exploded for 4000");

      // Other accounts still produce normal sections with their activity
      // rows and TOTALS — the failure didn't poison the rest of the file.
      expect(csv).toContain("ACCOUNT,1000,Operating Cash");
      expect(csv).toContain("JE-101-1");
      expect(csv).toContain("ACCOUNT,5000,Program Expenses");
      expect(csv).toContain("JE-5000-1");
      // The successful sections still emit their TOTALS line; the failed
      // section does not (it bailed out via the ERROR branch).
      const totalsLines = lines.filter((l) => l.startsWith("TOTALS,"));
      expect(totalsLines.length).toBeGreaterThanOrEqual(2);
    } finally {
      anchorClickSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      mockTrialBalanceData.current = undefined;
    }
  });

  it("P&L bulk activity button is rendered and disabled with the empty-state tooltip when there are zero income/expense accounts (Task #98)", () => {
    mockSummaryOverride.current = {
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
    };
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole("button", { name: /general ledger/i }));
    const plBtn = screen.getByTestId(
      "export-csv-pl-all-activity",
    ) as HTMLButtonElement;
    expect(plBtn).toBeInTheDocument();
    expect(plBtn.disabled).toBe(true);
    expect(plBtn.title).toMatch(/no profit & loss activity to export/i);
    const bsBtn = screen.getByTestId(
      "export-csv-bs-all-activity",
    ) as HTMLButtonElement;
    expect(bsBtn).toBeInTheDocument();
    expect(bsBtn.disabled).toBe(true);
    expect(bsBtn.title).toMatch(/no balance sheet activity to export/i);
    mockSummaryOverride.current = undefined;
  });

  it("P&L and Balance Sheet bulk activity buttons are disabled with the 'Switch to Ledger source' tooltip in operational mode (Task #98)", () => {
    mockSummaryOverride.current = {
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
        incomeByAccount: [
          { accountId: 4000, code: "4000", name: "Income", amount: 100 },
        ],
        expensesByAccount: [
          { accountId: 5000, code: "5000", name: "Expense", amount: 50 },
        ],
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
        cashAccounts: [
          { accountId: 1001, code: "1001", name: "Cash", balance: 100 },
        ],
        accountsReceivableAccounts: [],
        otherAssetAccounts: [],
        accountsPayableAccounts: [],
        otherLiabilityAccounts: [],
      },
    };
    render(<ReportsPage />);
    // Do NOT click the General Ledger toggle — we stay in operational mode.
    const plBtn = screen.getByTestId(
      "export-csv-pl-all-activity",
    ) as HTMLButtonElement;
    expect(plBtn.disabled).toBe(true);
    expect(plBtn.title).toMatch(/switch to ledger source/i);
    const bsBtn = screen.getByTestId(
      "export-csv-bs-all-activity",
    ) as HTMLButtonElement;
    expect(bsBtn.disabled).toBe(true);
    expect(bsBtn.title).toMatch(/switch to ledger source/i);
    mockSummaryOverride.current = undefined;
  });

  it("shows an inline error notice after a bulk export when one or more per-account fetches fail (Task #98)", async () => {
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

    getAccountActivityReportMock.mockClear();
    getAccountActivityReportMock.mockImplementation(
      async ({ accountId }: { accountId: number }) => {
        if (accountId === 4000) {
          throw new Error("simulated upstream 500");
        }
        return {
          lines: [],
          totals: { debits: "0.00", credits: "0.00" },
        };
      },
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
      const btn = screen.getByTestId("export-csv-tb-all-activity");
      fireEvent.click(btn);

      const notice = await screen.findByTestId(
        "bulk-error-notice-trial-balance",
      );
      expect(notice.textContent ?? "").toMatch(
        /downloaded with 1 error/i,
      );
      expect(notice.textContent ?? "").toMatch(/1 of 2 accounts/i);

      // Dismiss removes it.
      fireEvent.click(
        screen.getByTestId("bulk-error-notice-trial-balance-dismiss"),
      );
      await waitFor(() => {
        expect(
          screen.queryByTestId("bulk-error-notice-trial-balance"),
        ).toBeNull();
      });
    } finally {
      anchorClickSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      mockTrialBalanceData.current = undefined;
      getAccountActivityReportMock.mockReset();
      getAccountActivityReportMock.mockImplementation(async () => ({
        lines: [],
        totals: { debits: "0.00", credits: "0.00" },
      }));
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

/**
 * Task #86 — Bulk all-activity CSV per-account section equals per-account
 * export, byte-for-byte.
 *
 * The "Download all activity (CSV)" buttons (P&L and Balance Sheet) fan out
 * to the same /api/reports/account-activity endpoint that powers the
 * existing per-account "Download CSV" buttons inside each drilldown, then
 * concatenate the per-account sections into one workbook. If the bulk
 * builder ever drifts (different field, different totals rounding, missing
 * rows, off-by-one slicing) the audit-prep workbook would silently disagree
 * with the per-account exports reviewers double-check against.
 *
 * These tests:
 *   1. Render the Reports page with mocked summary data containing a
 *      handful of P&L / Balance Sheet accounts.
 *   2. Stub both `useGetAccountActivityReport` (drives the per-account
 *      drilldown UI + its "Download CSV" button) and the imperative
 *      `getAccountActivityReport` (drives the bulk fan-out) with a single
 *      shared activity factory so both code paths see identical lines.
 *   3. Click each per-account "Download CSV" button and capture the CSV
 *      blob.
 *   4. Click the bulk "Download all activity (CSV)" button and capture the
 *      bulk CSV blob.
 *   5. Slice each ACCOUNT section out of the bulk CSV and assert the
 *      header + data rows + TOTALS row match the per-account CSV body
 *      exactly (after stripping the per-account file's BOM and trailing
 *      CRLF, which the bulk file does not include between sections).
 *
 * Covers the P&L bulk export (uses both `from` + `to`) and the Balance
 * Sheet bulk export (uses `to` only — drilldowns are cumulative so the
 * sections also use only `to`).
 */
describe("Bulk all-activity CSV equals per-account CSV (Task #86)", () => {
  type ActivityLine = {
    lineId: number;
    journalEntryId: number;
    entryDate: string;
    entryNo: string;
    entryMemo: string | null;
    lineMemo: string | null;
    program: string | null;
    fund: string | null;
    debit: number;
    credit: number;
  };
  type ActivityReport = {
    lines: ActivityLine[];
    totals: { debits: number; credits: number };
  };

  // Deterministic activity-per-account factory shared by the per-account
  // hook stub and the bulk fan-out function stub. Even-coded accounts net
  // credit, odd-coded accounts net debit — so the rows include a mix of
  // values, programs, funds, memos, and nullable fields. This catches any
  // bulk-vs-per-account drift in field selection, ordering, csvMoney
  // rounding, or null handling.
  const activityFor = (accountId: number): ActivityReport => {
    const debitSide = accountId % 2 === 1;
    const lines: ActivityLine[] = [
      {
        lineId: accountId * 10 + 1,
        journalEntryId: accountId * 100 + 1,
        entryDate: "2025-03-15",
        entryNo: `JE-${accountId}-A`,
        entryMemo: `memo for ${accountId}`,
        lineMemo: null,
        program: "Programs",
        fund: null,
        debit: debitSide ? 250 : 0,
        credit: debitSide ? 0 : 250,
      },
      {
        lineId: accountId * 10 + 2,
        journalEntryId: accountId * 100 + 2,
        entryDate: "2025-03-20",
        entryNo: `JE-${accountId}-B`,
        entryMemo: null,
        lineMemo: "qty 3, rate 25.17",
        program: null,
        fund: "General",
        debit: debitSide ? 75.51 : 0,
        credit: debitSide ? 0 : 75.51,
      },
    ];
    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    return { lines, totals: { debits, credits } };
  };

  function makeSummary(opts: {
    incomeByAccount: { accountId: number; code: string; name: string; amount: number }[];
    expensesByAccount: { accountId: number; code: string; name: string; amount: number }[];
    cashAccounts: { accountId: number; code: string; name: string; balance: number }[];
    accountsReceivableAccounts: { accountId: number; code: string; name: string; balance: number }[];
    otherAssetAccounts: { accountId: number; code: string; name: string; balance: number }[];
    accountsPayableAccounts: { accountId: number; code: string; name: string; balance: number }[];
    otherLiabilityAccounts: { accountId: number; code: string; name: string; balance: number }[];
  }) {
    return {
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
        totalIncome: opts.incomeByAccount.reduce((s, a) => s + a.amount, 0),
        totalExpenses: opts.expensesByAccount.reduce((s, a) => s + a.amount, 0),
        netIncome:
          opts.incomeByAccount.reduce((s, a) => s + a.amount, 0) -
          opts.expensesByAccount.reduce((s, a) => s + a.amount, 0),
        incomeByProgram: [],
        expensesByProgram: [],
        uncategorizedIncome: 0,
        uncategorizedExpenses: 0,
        incomeByAccount: opts.incomeByAccount,
        expensesByAccount: opts.expensesByAccount,
      },
      balanceSheet: {
        cash: opts.cashAccounts.reduce((s, a) => s + a.balance, 0),
        cashOnHand: 0,
        accountsReceivable: opts.accountsReceivableAccounts.reduce(
          (s, a) => s + a.balance,
          0,
        ),
        otherAssets: opts.otherAssetAccounts.reduce((s, a) => s + a.balance, 0),
        accountsPayable: opts.accountsPayableAccounts.reduce(
          (s, a) => s + a.balance,
          0,
        ),
        otherLiabilities: opts.otherLiabilityAccounts.reduce(
          (s, a) => s + a.balance,
          0,
        ),
        equity: 0,
        totalAssets: 0,
        totalLiabilities: 0,
        cashAccounts: opts.cashAccounts,
        accountsReceivableAccounts: opts.accountsReceivableAccounts,
        otherAssetAccounts: opts.otherAssetAccounts,
        accountsPayableAccounts: opts.accountsPayableAccounts,
        otherLiabilityAccounts: opts.otherLiabilityAccounts,
      },
    };
  }

  // Splits a bulk CSV into a map of `code -> body string` where body is the
  // per-account section's header + data rows + TOTALS row, joined by CRLF.
  // The leading "ACCOUNT,<code>,<name>,group=..." marker row and the blank
  // separator after the section are dropped — they only exist in the bulk
  // file, not in per-account exports.
  function extractBulkSections(bulkCsv: string): Record<string, string> {
    const text = bulkCsv.replace(/^\uFEFF/, "").replace(/\r\n$/, "");
    const lines = text.split("\r\n");
    const out: Record<string, string> = {};
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^ACCOUNT,([^,]+),/);
      if (!m) continue;
      const code = m[1];
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j] !== "") {
        body.push(lines[j]);
        j++;
      }
      out[code] = body.join("\r\n");
      i = j;
    }
    return out;
  }

  // Strip the per-account file's BOM + trailing CRLF so its body is in the
  // exact same shape as a bulk section body.
  function stripPerAccountWrapping(csv: string): string {
    return csv.replace(/^\uFEFF/, "").replace(/\r\n$/, "");
  }

  let createdBlobs: Blob[];
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let anchorClickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdBlobs = [];
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob: Blob | MediaSource) => {
        createdBlobs.push(blob as Blob);
        return "blob:test";
      });
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    // Both the drilldown hook and the bulk fan-out function read from the
    // same activity factory so any divergence we observe is the bulk
    // builder's fault, not a mock-skew artifact.
    useGetAccountActivityReportImpl.current = (args, opts) => {
      const enabled = opts?.query?.enabled !== false;
      return {
        data: enabled ? activityFor(args.accountId) : undefined,
        isLoading: false,
        error: null,
      };
    };
    getAccountActivityReportMock.mockReset();
    getAccountActivityReportMock.mockImplementation(
      async (args: { accountId: number }) => activityFor(args.accountId),
    );
  });

  afterEach(() => {
    anchorClickSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    mockSummaryOverride.current = undefined;
    useGetAccountActivityReportImpl.current = () => ({
      data: undefined,
      isLoading: false,
      error: null,
    });
    getAccountActivityReportMock.mockReset();
    getAccountActivityReportMock.mockImplementation(async () => ({
      lines: [],
      totals: { debits: "0.00", credits: "0.00" },
    }));
  });

  async function downloadAndCapture(testId: string): Promise<string> {
    const startCount = createdBlobs.length;
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => {
      expect(createdBlobs.length).toBeGreaterThan(startCount);
    });
    return await createdBlobs[createdBlobs.length - 1].text();
  }

  it("P&L: bulk per-account sections are byte-equal to per-account CSV exports (uses from + to)", async () => {
    const incomeByAccount = [
      { accountId: 4000, code: "4000", name: "Program Income", amount: 250 },
      { accountId: 4100, code: "4100", name: "Grants, restricted", amount: 250 },
    ];
    const expensesByAccount = [
      { accountId: 5001, code: "5001", name: "Salaries", amount: 325.51 },
      { accountId: 5003, code: "5003", name: "Rent & utilities", amount: 325.51 },
    ];
    mockSummaryOverride.current = makeSummary({
      incomeByAccount,
      expensesByAccount,
      cashAccounts: [],
      accountsReceivableAccounts: [],
      otherAssetAccounts: [],
      accountsPayableAccounts: [],
      otherLiabilityAccounts: [],
    });

    render(<ReportsPage />);

    // The bulk PL button (and per-account drilldown rows) only render when
    // source === "ledger".
    fireEvent.click(
      screen.getByRole("button", { name: /general ledger/i }),
    );

    const allAccounts = [...incomeByAccount, ...expensesByAccount];

    // Capture each per-account CSV by expanding the drilldown row and
    // clicking its "Download CSV" button.
    const perAccount: Record<string, string> = {};
    for (const a of allAccounts) {
      const parentSlug = incomeByAccount.includes(a) ? "pl-income" : "pl-expense";
      fireEvent.click(
        screen.getByTestId(`pl-row-toggle-${parentSlug}-${a.accountId}`),
      );
      const dlBtn = await screen.findByTestId(
        `export-csv-pl-activity-${a.accountId}`,
      );
      const startCount = createdBlobs.length;
      fireEvent.click(dlBtn);
      await waitFor(() => {
        expect(createdBlobs.length).toBeGreaterThan(startCount);
      });
      perAccount[a.code] = await createdBlobs[createdBlobs.length - 1].text();
    }

    // Bulk export.
    const bulkCsv = await downloadAndCapture("export-csv-pl-all-activity");
    const sections = extractBulkSections(bulkCsv);

    // Sanity: bulk fan-out called exactly once per account with both
    // `from` and `to` (P&L is period-bounded).
    const bulkCalls = getAccountActivityReportMock.mock.calls.map(
      (c) => c[0] as { accountId: number; from?: string; to: string },
    );
    expect(bulkCalls).toHaveLength(allAccounts.length);
    for (const c of bulkCalls) {
      expect(c.from).toBeTruthy();
      expect(c.to).toBeTruthy();
    }

    // Per account: bulk section body must equal per-account CSV body.
    for (const a of allAccounts) {
      expect(sections[a.code]).toBeDefined();
      expect(sections[a.code]).toBe(stripPerAccountWrapping(perAccount[a.code]));
    }
    expect(Object.keys(sections).sort()).toEqual(
      allAccounts.map((a) => a.code).sort(),
    );
  });

  it("Balance Sheet: bulk per-account sections are byte-equal to per-account CSV exports (uses to only)", async () => {
    const cashAccounts = [
      { accountId: 1001, code: "1001", name: "Operating Checking", balance: 325.51 },
    ];
    const accountsReceivableAccounts = [
      { accountId: 1201, code: "1201", name: "Pledges receivable", balance: 325.51 },
    ];
    const otherAssetAccounts = [
      { accountId: 1501, code: "1501", name: "Prepaid insurance", balance: 325.51 },
    ];
    const accountsPayableAccounts = [
      { accountId: 2002, code: "2002", name: "Vendor A/P", balance: 250 },
    ];
    const otherLiabilityAccounts = [
      { accountId: 2200, code: "2200", name: "Deferred revenue", balance: 250 },
    ];
    mockSummaryOverride.current = makeSummary({
      incomeByAccount: [],
      expensesByAccount: [],
      cashAccounts,
      accountsReceivableAccounts,
      otherAssetAccounts,
      accountsPayableAccounts,
      otherLiabilityAccounts,
    });

    render(<ReportsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /general ledger/i }),
    );

    const groupSlugs: Array<{
      slug: string;
      list: { accountId: number; code: string; name: string; balance: number }[];
    }> = [
      { slug: "cash", list: cashAccounts },
      { slug: "accounts-receivable", list: accountsReceivableAccounts },
      { slug: "other-assets", list: otherAssetAccounts },
      { slug: "accounts-payable", list: accountsPayableAccounts },
      { slug: "other-liabilities", list: otherLiabilityAccounts },
    ];
    const allAccounts = groupSlugs.flatMap((g) => g.list);

    // Each Balance Sheet group row must be expanded before its account
    // children render. The group's testid is `bs-row-<slug>` and its
    // children appear under `bs-account-toggle-<accountId>`.
    const perAccount: Record<string, string> = {};
    for (const g of groupSlugs) {
      // Group toggles are rendered as <button aria-expanded ...>; walk the
      // DOM by finding any account-toggle inside the group's accounts list.
      for (const a of g.list) {
        // Open the parent group.
        const groupAccountsList = screen.queryByTestId(
          `bs-row-${g.slug}-accounts`,
        );
        if (!groupAccountsList) {
          // The `bs-row-<slug>` testid is on the group's toggle <button>
          // itself (see ExpandableRow), so click it directly to expand the
          // accounts list underneath.
          fireEvent.click(screen.getByTestId(`bs-row-${g.slug}`));
        }
        const accountToggle = await screen.findByTestId(
          `bs-account-toggle-${a.accountId}`,
        );
        fireEvent.click(accountToggle);
        const dlBtn = await screen.findByTestId(
          `export-csv-bs-activity-${a.accountId}`,
        );
        const startCount = createdBlobs.length;
        fireEvent.click(dlBtn);
        await waitFor(() => {
          expect(createdBlobs.length).toBeGreaterThan(startCount);
        });
        perAccount[a.code] = await createdBlobs[createdBlobs.length - 1].text();
      }
    }

    const bulkCsv = await downloadAndCapture("export-csv-bs-all-activity");
    const sections = extractBulkSections(bulkCsv);

    // Balance Sheet bulk export must use `to` only (no `from`) — drilldowns
    // are cumulative-through-toDate so the listed lines net to the
    // displayed balance.
    const bulkCalls = getAccountActivityReportMock.mock.calls.map(
      (c) => c[0] as { accountId: number; from?: string; to: string },
    );
    expect(bulkCalls).toHaveLength(allAccounts.length);
    for (const c of bulkCalls) {
      expect(c.from).toBeUndefined();
      expect(c.to).toBeTruthy();
    }

    for (const a of allAccounts) {
      expect(sections[a.code]).toBeDefined();
      expect(sections[a.code]).toBe(stripPerAccountWrapping(perAccount[a.code]));
    }
    expect(Object.keys(sections).sort()).toEqual(
      allAccounts.map((a) => a.code).sort(),
    );
  });

  /**
   * Task #95 — Pin the bulk file's account ordering, file-level preamble,
   * and ACCOUNT marker row format.
   *
   * The Task #86 byte-equality test above proves each per-account section
   * matches its per-account export, but it sorts section codes before
   * comparing — so a regression that reorders accounts, drops the preamble,
   * or changes the marker row would not fail. These tests pin those
   * structural details so any drift surfaces as a test failure instead of
   * a silently-different audit-prep workbook.
   */
  function parseAccountMarkers(
    bulkCsv: string,
  ): Array<{ code: string; name: string; group: string }> {
    const text = bulkCsv.replace(/^\uFEFF/, "").replace(/\r\n$/, "");
    const out: Array<{ code: string; name: string; group: string }> = [];
    for (const line of text.split("\r\n")) {
      const m = line.match(/^ACCOUNT,([^,]+),([^,]+),group=(.+)$/);
      if (m) out.push({ code: m[1], name: m[2], group: m[3] });
    }
    return out;
  }

  it("P&L bulk CSV: pins preamble rows, ACCOUNT marker format, and income-then-expense ordering (Task #95)", async () => {
    const incomeByAccount = [
      { accountId: 4000, code: "4000", name: "Program Income", amount: 250 },
      { accountId: 4100, code: "4100", name: "Grants", amount: 250 },
      { accountId: 4200, code: "4200", name: "Donations", amount: 250 },
    ];
    const expensesByAccount = [
      { accountId: 5001, code: "5001", name: "Salaries", amount: 325.51 },
      { accountId: 5003, code: "5003", name: "Rent", amount: 325.51 },
    ];
    mockSummaryOverride.current = makeSummary({
      incomeByAccount,
      expensesByAccount,
      cashAccounts: [],
      accountsReceivableAccounts: [],
      otherAssetAccounts: [],
      accountsPayableAccounts: [],
      otherLiabilityAccounts: [],
    });

    render(<ReportsPage />);
    fireEvent.click(screen.getByRole("button", { name: /general ledger/i }));

    const bulkCsv = await downloadAndCapture("export-csv-pl-all-activity");
    const text = bulkCsv.replace(/^\uFEFF/, "").replace(/\r\n$/, "");
    const lines = text.split("\r\n");

    // Preamble rows: report / range / generated / blank, in that order.
    expect(lines[0]).toBe("report,Profit & Loss — all account activity");
    expect(lines[1]).toMatch(
      /^range,\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}$/,
    );
    expect(lines[2]).toMatch(
      /^generated,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(lines[3]).toBe("");

    // ACCOUNT marker rows: format `ACCOUNT,<code>,<name>,group=<group>`,
    // listing income accounts (group=Income) before expense accounts
    // (group=Expense), each in the same order as the source arrays.
    const markers = parseAccountMarkers(bulkCsv);
    expect(markers).toEqual([
      ...incomeByAccount.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Income",
      })),
      ...expensesByAccount.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Expense",
      })),
    ]);
  });

  it("Balance Sheet bulk CSV: pins preamble rows, ACCOUNT marker format, and cash → A/R → other assets → A/P → other liabilities ordering (Task #95)", async () => {
    const cashAccounts = [
      { accountId: 1001, code: "1001", name: "Operating Checking", balance: 100 },
      { accountId: 1002, code: "1002", name: "Savings", balance: 100 },
    ];
    const accountsReceivableAccounts = [
      { accountId: 1201, code: "1201", name: "Pledges receivable", balance: 100 },
    ];
    const otherAssetAccounts = [
      { accountId: 1501, code: "1501", name: "Prepaid insurance", balance: 100 },
    ];
    const accountsPayableAccounts = [
      { accountId: 2002, code: "2002", name: "Vendor A/P", balance: 100 },
    ];
    const otherLiabilityAccounts = [
      { accountId: 2200, code: "2200", name: "Deferred revenue", balance: 100 },
    ];
    mockSummaryOverride.current = makeSummary({
      incomeByAccount: [],
      expensesByAccount: [],
      cashAccounts,
      accountsReceivableAccounts,
      otherAssetAccounts,
      accountsPayableAccounts,
      otherLiabilityAccounts,
    });

    render(<ReportsPage />);
    fireEvent.click(screen.getByRole("button", { name: /general ledger/i }));

    const bulkCsv = await downloadAndCapture("export-csv-bs-all-activity");
    const text = bulkCsv.replace(/^\uFEFF/, "").replace(/\r\n$/, "");
    const lines = text.split("\r\n");

    // Preamble rows: report / as_of / generated / blank, in that order.
    // Balance Sheet uses `as_of` (single date), not `range`, because the
    // report is point-in-time, not period-bounded.
    expect(lines[0]).toBe("report,Balance Sheet — all account activity");
    expect(lines[1]).toMatch(/^as_of,\d{4}-\d{2}-\d{2}$/);
    expect(lines[2]).toMatch(
      /^generated,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(lines[3]).toBe("");

    // ACCOUNT marker rows: format pinned and section ordering pinned to
    // cash → A/R → other assets → A/P → other liabilities.
    const markers = parseAccountMarkers(bulkCsv);
    expect(markers).toEqual([
      ...cashAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Assets:Cash",
      })),
      ...accountsReceivableAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Assets:Receivable",
      })),
      ...otherAssetAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Assets:Other",
      })),
      ...accountsPayableAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Liabilities:Payable",
      })),
      ...otherLiabilityAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        group: "Liabilities:Other",
      })),
    ]);
  });
});
