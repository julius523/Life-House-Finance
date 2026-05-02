# Review and approve an expense

## When to use this
You're an approver or admin and you have items waiting in your Approvals queue. Aim to clear the queue at least once a day.

## Prerequisites
- Approver or admin role.
- A few minutes per item — don't rush approvals.

## Step-by-step
1. Open **Approvals** in the sidebar. The list shows everything in **Pending review** assigned to you (or org-wide if you're an admin).
2. Click an item to open its detail panel. Verify the four boxes:
   - **Receipt matches the amount and vendor.**
   - **Category is correct.** If it's wrong, fix it inline before approving (do not reject for a bad category — just correct it).
   - **Program is correct.** Same rule: fix inline rather than rejecting.
   - **Description is plausible** for the vendor and amount.
3. If everything is good → click **Approve**. The item posts to the GL immediately.
4. If something is off and the submitter needs to fix it → click **Reject**, pick a reason, and write one short sentence telling them exactly what to change. Vague rejects waste everyone's time.
5. If the item belongs to **you** personally, you'll see a banner — you cannot approve your own work. Ask another approver or an admin.

## Bulk-approve a batch
- Tick the rows that all look clean → **Approve selected**. Use sparingly: only when you've personally eyeballed every receipt in the selection.

## What success looks like
- Item moves out of your queue.
- Posted item shows up under **Accounting → Journal Entries** with source **expense**.

## Common errors
- **"Cannot approve own item"** — see step 5.
- **"Posting failed (mapping)"** — the category isn't mapped to a GL account yet. Don't approve. Open the [Resolve a blocked-queue item](resolve-blocked-queue.md) runbook.
- **"Posting failed (period locked)"** — admin needs to either reopen the period or the submitter needs to resubmit with a date in the open period.

## Escalate to
Admin (`#finance-ops`) for anything that won't post after a mapping fix, or anything that smells fraudulent.
