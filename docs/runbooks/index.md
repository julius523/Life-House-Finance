# 5-minute tour

Welcome to the Life House Finance Portal. This page is your map. Each link below opens a short runbook (1 page, under 5 minutes to read).

## What you can do here

- **Submit an expense** with or without a receipt — [Submit an expense](submit-expense.md)
- **Review and approve** other people's expenses (approvers / admins) — [Review and approve an expense](review-approve-expense.md)
- **Enter a vendor bill and record its payment** — [Enter a bill and record its payment](enter-bill-record-payment.md)
- **Post a manual journal entry** for adjustments (admins / approvers) — [Post a manual journal entry](post-manual-journal-entry.md)
- **Unblock items** stuck in the accounting queue — [Resolve a blocked-queue item](resolve-blocked-queue.md)
- **Run month-end close** — [Run a month-end close](month-end-close.md)
- **Generate and share reports** — [Generate and share a report](reports-and-scheduled-exports.md)
- **Invite people and manage roles** (admins) — [Invite and manage users](invite-manage-users.md)

## How help works in the app

- The **Help** item in the sidebar opens this drawer at any time.
- On every major page you'll see a **Help with this page** link in the top-right — that opens the runbook for the page you're on.
- All runbooks live in the repo at `docs/runbooks/` and are checked into version control. Edit them with the rest of the codebase.

## Roles in one sentence each

- **Submitter** — submits their own expenses and bills.
- **Approver** — reviews and approves other people's items, posts manual journal entries.
- **Admin** — everything above, plus user management, period locks, integrity tools, accounting settings.

## Who to escalate to

- Anything you can't unblock in 5 minutes → message the on-call admin in Slack `#finance-ops`.
- Suspected data integrity issue → admin only, run `/admin/integrity` first.
