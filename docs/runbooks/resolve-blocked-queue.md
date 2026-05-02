# Resolve a blocked-queue item

## When to use this
The blocked queue holds approved expenses and bills that **failed to post to the GL** because of a missing or invalid mapping. They sit here until someone fixes the mapping or marks them not-applicable. Drain the queue daily.

## Prerequisites
- Approver or admin role.
- Access to **Accounting → Remediation** (sidebar, under Accounting).

## Step-by-step (mapping fix path — the common case)
1. Sidebar → **Accounting** → **Remediation**. The badge on the sidebar shows how many are queued.
2. Each row tells you the item, the failure reason, and the recommended fix. The most common reason is **"Category is not mapped to a GL account"**.
3. Click the item → **Fix mapping**. You'll be sent to the category mapping page with the offending category pre-selected.
4. Pick the right GL account. Save. The system automatically retries the post for every item that was waiting on this mapping. The queue should shrink by more than one row if there was a backlog.
5. Confirm the item is now in **Accounting → Journal Entries** with status **Posted**.

## Step-by-step (not-applicable path)
Some items legitimately should not post — e.g. a personal expense that was put on the company card by mistake and is being reimbursed back. For these:
1. Open the item from the remediation queue → **Mark not applicable**.
2. Pick a reason from the dropdown.
3. Write a one-line note explaining what's happening instead (e.g. "Refunded to operating account on 2026-04-15, see deposit ID 2104").
4. Confirm. The item is now permanently excluded from posting and won't reappear.

## What success looks like
- The blocked-queue badge in the sidebar drops.
- For mapping fixes: the item now has a posted journal entry with source **expense** or **bill**.
- For not-applicable: the item is in the **Resolved** tab with your note attached.

## Common errors
- **"Account is archived"** — you picked an archived account. Pick a postable one.
- **"Period is locked"** — the original date is in a closed period. Either reopen the period (admin), or talk to the submitter about resubmitting with a date in the open period.
- **"Item already posted"** — someone else fixed it in parallel; refresh the page.

## Escalate to
Admin for period reopens or for any item that's been blocked more than 7 days.
