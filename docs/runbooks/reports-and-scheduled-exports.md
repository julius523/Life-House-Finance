# Generate and share a report

## When to use this
- You need a one-off report (this month's P&L for the board pack).
- You need a recurring CSV export delivered to someone on a schedule (weekly journal export to the auditor).

## Prerequisites
- Approver or admin role for most reports. Submitters can see their own activity only.

## Step-by-step (one-off report)
1. Sidebar → **Reports**.
2. Pick the report you want:
   - **Profit & Loss** — income and expenses for a date range.
   - **Balance Sheet** — assets, liabilities, equity at a point in time.
   - **Trial Balance** — every account, debit and credit columns, totals must match.
   - **Journal Entries** — raw GL transactions for a date range.
3. Set the **date range** and any **filters** (program, account, source).
4. Click **Run**. The report renders in the page.
5. To share:
   - **Download CSV** — use this for the auditor or for further analysis in a spreadsheet.
   - **Print / Save PDF** — use the browser's print dialog (Ctrl/Cmd+P → "Save as PDF") for board packs.

## Step-by-step (scheduled CSV export)
1. Sidebar → **Accounting** → **Journal Export Schedules** (admin-only).
2. **New schedule**.
3. Pick the **report**, the **frequency** (daily / weekly / monthly), the **filters** (date window is auto-rolled — e.g. "previous calendar week"), and the **email recipients**.
4. Optional but recommended: click **Send test now** to confirm the recipients receive the file before going live.
5. Save. The schedule will run at the configured time and email the CSV.

## Sharing a deep-link to a report
- After running a report with filters, copy the URL from the address bar — it encodes every filter you picked, so the recipient sees exactly the same view.
- The same is true on the **Schedule editor** dialog: the **Copy share link** button (when present) gives a URL that re-opens the dialog with all picker selections restored.

## What success looks like
- The CSV downloads with the right rows and totals.
- For schedules: the test email arrives within ~1 minute, with the CSV attached.

## Common errors
- **"Trial Balance Total debits ≠ Total credits"** — do not share this report. Stop and run the integrity sweep (see [Month-end close](month-end-close.md) → gotchas).
- **"Scheduled export delivery failed"** — open the schedule's send-log; the most common cause is a stale recipient address. Update and retry.
- **CSV is empty** — your filters are too narrow. Widen the date range and re-run.

## Escalate to
Admin for any schedule changes. Senior bookkeeper if a report's totals don't match a previously published version.
