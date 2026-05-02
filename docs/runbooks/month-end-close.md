# Run a month-end close

## When to use this
Once a calendar month is over and all in-period transactions are entered, approved, and posted. Typical cadence: by the 5th business day of the next month.

## Prerequisites
- Admin or approver role.
- The blocked queue is **empty** for the period being closed (open it and confirm — see [Resolve a blocked-queue item](resolve-blocked-queue.md)).
- All bank statements for the period have been imported and reconciled.

## Step-by-step
1. Sidebar → **Month End**. You'll see a list of months and their statuses (Open, In progress, Closed).
2. Click the month you're closing. The detail page shows a checklist:
   - All approvals cleared
   - Blocked queue empty for this period
   - All bank reconciliations complete for this period
   - Trial balance balances
3. Tick through the checklist. Anything red means there's a blocker — fix it before continuing. Don't override a red check.
4. Click **Run trial balance** at the top. Confirm the **Total debits = Total credits** at the bottom. If it doesn't balance, **stop**. Open `/admin/integrity` (admin) and run a sweep — there is a data integrity issue that must be fixed before close.
5. Run any **adjusting entries** required for this period (depreciation, accruals, prepaid amortisation). See [Post a manual journal entry](post-manual-journal-entry.md).
6. Re-run trial balance to confirm it still balances after adjustments.
7. Click **Close period**. Confirm. The period is now locked — no more postings can land in it without an admin reopening it.

## Common gotchas
- **A bill payment dated inside the period landed after close.** Don't try to edit the period — ask an admin to reopen, post the entry, then re-close.
- **Trial balance won't balance.** Almost always means a posted journal entry got into a strange state. Run the integrity sweep (`pnpm --filter @workspace/api-server run integrity:sweep` or `/admin/integrity` UI) — every check should return n=0.
- **"Reopen period" is needed often.** That's a smell. Tighten the close checklist instead of normalising reopens.

## What success looks like
- Period is **Closed**. The badge in **Month End** flips green.
- Future postings into that period are rejected with a clear error.
- The close is logged in the activity log with your name, the timestamp, and the trial-balance totals at the moment of close.

## Escalate to
Senior bookkeeper for any close that requires more than two adjusting entries. Admin for any reopen.
