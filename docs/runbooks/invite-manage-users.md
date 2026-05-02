# Invite and manage users

## When to use this
A new staff member starts and needs access; someone leaves and needs to be removed; someone's role changes.

## Prerequisites
- Admin role.

## Step-by-step (invite a new user)
1. Sidebar → **Admin**.
2. **Add user** (top-right of the Users table).
3. Fill in:
   - **First name**, **Last name** — used in approvals and audit logs.
   - **Email** — must be unique, and must be the email they'll actually log in with.
   - **Role** — pick the smallest role that lets them do their job:
     - **Submitter** — submits their own expenses and bills.
     - **Approver** — reviews other people's items, posts manual journal entries.
     - **Admin** — full access including user management and period locks.
   - **Initial password** — generate a strong one and share it via a secure channel (1Password, Signal). Tell them to change it on first login.
4. Save. They can sign in immediately.

## Step-by-step (change a role)
1. Find the user in the **Users** table → **Edit**.
2. Change the **Role**. Save. The role takes effect on their next request — they may need to refresh.

## Step-by-step (offboard a user)
1. Find the user → **Edit**.
2. Either set the role to **Disabled** (the recommended default — preserves their history but blocks login), or **Delete** if they were never used. Disabled is safer for audit.
3. If they had pending approvals assigned to them, reassign those manually from the **Approvals** queue first.

## What success looks like
- New user can sign in at the production URL with the credentials you sent.
- Disabled users get a clear "account disabled" error on login attempt.
- Role changes are reflected immediately in the sidebar and on every protected page.

## Common gotchas
- **Don't reuse a deleted user's email.** Disable instead. Reusing emails muddies the audit trail.
- **The `automation@lifehousereentry.com` user is hidden from the Users table** and is not editable from the UI. It's the API-key service account for the Apps Script automation. Do not try to recreate it.
- **A user reports they "can't see X"** — first check their role. Most "missing button" reports are role gates working as designed.

## Escalate to
The on-call admin or the engineering team only if a role change doesn't take effect after the user signs out and back in.
