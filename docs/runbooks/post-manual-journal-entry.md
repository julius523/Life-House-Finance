# Post a manual journal entry

## When to use this
For accounting adjustments that don't have a natural expense or bill source: reclassifications, accruals, depreciation, opening balances, corrections of posted entries, etc.

## Prerequisites
- Approver or admin role.
- You know exactly which accounts to debit and credit, and the totals balance to the cent.
- The period you're posting into is **open** (check **Month End**).

## Step-by-step
1. Sidebar → **Accounting** → **Journal Entries** → **New entry**.
2. **Date** — must fall in an open period.
3. **Memo** — one short sentence: what this is and why. Other humans will read this in six months.
4. Add lines. Each line needs:
   - **Account** (debit or credit side)
   - **Amount** — positive number; the debit/credit column tells the system which side
   - **Program** — required on every line
   - **Description** (optional, but recommended for non-obvious lines)
5. Watch the **Debit total** and **Credit total** at the bottom. They must match. The **Post** button stays disabled until they do.
6. (Optional) Save as a **Draft** instead of posting — useful for entries you want a colleague to look at before committing. Drafts persist across sessions.
7. Click **Post**. The entry is now in the GL and immutable. To correct it, use **Reverse and replace** from the entry detail page (do not try to edit in place — entries are locked).

## Reversing a posted entry
1. Open the entry → **Reverse and replace**.
2. The system creates an automatic reversal (mirror image), and lets you draft the corrected replacement on the same screen.
3. Post the replacement; both the reversal and the new entry are linked to the original for audit.

## What success looks like
- Entry shows up in the **Journal Entries** list with status **Posted**, source **manual**.
- Trial balance still balances.

## Common errors
- **"Entry is unbalanced"** — debits ≠ credits. Recount. The two totals at the bottom are your truth.
- **"Period is locked"** — pick a date in an open period, or ask an admin to temporarily reopen.
- **"Account is archived / non-postable"** — pick a different account; archived accounts cannot accept new postings.

## Escalate to
Admin for period reopens. Senior bookkeeper for any entry over $10,000 or anything touching restricted-fund accounts.
