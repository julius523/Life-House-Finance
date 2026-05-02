# Admin emergency runbook

For the on-call admin at 2am. Each scenario is one screen tall. Follow
top-to-bottom; do not skip the validation step.

Escalate to: the engineering owner of record (commit history of
`replit.md` is the source of truth for who that is). For database
emergencies that require restoring a backup, see
[admin-backup-restore.md](admin-backup-restore.md).

---

## Scenario 1 — Production login is down

**Detection signal**
- Multiple users report "I get an error when I sign in".
- `curl` to `https://lifehouseaccounting.replit.app/api/auth/login`
  with a real email + bad password returns HTTP 500 (the bare
  cloud-frontend HTML page) instead of HTTP 401 with
  `{"error":"Invalid email or password"}`.

**First action**
1. `curl -i https://lifehouseaccounting.replit.app/api/healthz` —
   if it returns 503, the body names the broken probe (db / schema /
   scheduler / env). Skip to the matching scenario below.
2. If `/healthz` returns 200 but login still 500s, repeat the curl
   from step 1 with `-H "Origin: https://Lifehouseaccounting.replit.app"`
   (capital L). A 500 here is the case-sensitive CORS bug — the
   deployment is serving stale code from before commit `80644f4`.
   Re-publish from the most recent main commit.
3. Otherwise, check the deployment logs in the Replit dashboard for
   "CORS:" or "bcrypt" stack traces.

**Escalation**
- If re-publishing does not fix it within 15 minutes, page the
  engineering owner. Do not attempt to roll back schema changes —
  the publish flow handles that.

**Recovery validation**
- A cold curl to `/api/auth/login` with a known-bad password returns
  HTTP 401 with the JSON body. A real user signs in successfully.

---

## Scenario 2 — Cannot post journal entries

**Detection signal**
- Approvers report "Post" returns an error.
- Activity log shows no `journal_entry_posted` events in the last
  hour during business hours.

**First action**
1. `curl -i https://lifehouseaccounting.replit.app/api/healthz` —
   confirm `db.ok` and `schema.ok` are true.
2. Sign in as an admin and open `/admin/integrity` — if any check
   shows a non-zero count, see Scenario 5.
3. Confirm the active period is not locked: `/admin/accounting-periods`
   should show the current month with `lockedAt: null`. If it is
   locked, the approver is trying to post into a closed period —
   that is intentional, not an outage.
4. Check the api-server logs for the error returned to the user.
   The most common real failure is the
   `journal_entries_lock` trigger rejecting an UPDATE attempt — the
   message includes "journal_entries are immutable". This means a
   future bug or a hand-run script tried to mutate a posted JE; the
   trigger correctly blocked it. The fix is in code, not in data.

**Escalation**
- If `/healthz` is green and the period is open and the integrity
  sweep is clean, page the engineering owner with the exact error
  message from the user.

**Recovery validation**
- A test approver successfully posts a $1 manual JE in a sandbox
  account and reverses it.

---

## Scenario 3 — Blocked-queue jam

**Detection signal**
- `/accounting/blocked` shows >10 items, or a single item has been
  stuck for >24h.
- Submitters report "my expense was approved but it's not in the
  ledger".

**First action**
1. Open the blocked queue and read the `accounting_block_reason`
   column on the top item. The reason is human-readable and
   prescriptive (e.g. "no chart-of-accounts mapping for category X").
2. Follow the resolution steps in
   [resolve-blocked-queue.md](resolve-blocked-queue.md).
3. If many items share the same reason, fix the underlying mapping
   once (CoA mapping, missing program, etc.) — the next scheduler
   tick will retry every blocked item that matches.

**Escalation**
- If the block reason is "internal error" or empty, page the
  engineering owner — the bridge code is failing in an unexpected
  way and the operator cannot resolve it from the UI.

**Recovery validation**
- Blocked-queue count returns to baseline (≤ 1 transient item per
  hour during business hours).

---

## Scenario 4 — Scheduled exports stopped

**Detection signal**
- Recipients report "I haven't received the daily export".
- `GET /api/healthz` shows `scheduler.ok: false` with detail
  "scheduler last ticked Xms ago" or "scheduler timer not running".

**First action**
1. Restart the api-server workflow — the scheduler runs in-process
   and is restored on boot.
2. Open the schedule list at `/scheduled-exports` and check the
   "consecutive failures" column. Any schedule at 3 failures has
   been auto-paused — see the runbook for resuming it.
3. Confirm `SENDGRID_API_KEY` is present (`/api/healthz` env probe).

**Escalation**
- If `/healthz` shows scheduler stalled even after a restart, page
  the engineering owner. The scheduler tick is `setInterval`-based
  and a stuck `inFlight` flag will silently block all future ticks.

**Recovery validation**
- `/healthz` reports `scheduler.ok: true`. The next scheduled
  export at 02:00 UTC delivers successfully.

---

## Scenario 5 — Integrity sweep finding fired

**Detection signal**
- `/admin/integrity` page shows one or more checks with a non-zero
  count.
- `pnpm --filter @workspace/api-server run integrity:sweep` exits 0
  but the JSON shows a check with `count > 0`.

**First action**
1. Note the failing check name and sample IDs from the JSON output.
2. The sweep is read-only — it has not modified anything. There is
   no time pressure.
3. Look for a matching one-off repair script under
   `scripts/integrity/YYYY-MM-DD-*.sql` that addresses the same
   check. If one exists, follow the conventions documented in
   `replit.md` (single transaction, idempotent inserts,
   `RETURNING`-driven audit rows).
4. If no repair script exists, page the engineering owner with the
   check name and sample IDs. Do not write data fixes ad-hoc — the
   "Integrity sweep" section of `replit.md` documents the rules.

**Recovery validation**
- A repeat run of `integrity:sweep` shows the previously-failing
  check at `count: 0`. The fix is committed under
  `scripts/integrity/` and the run output is in the commit message.

---

## Other useful references

- [admin-backup-restore.md](admin-backup-restore.md) — backup +
  restore drill, full procedure.
- [admin-env-vars.md](admin-env-vars.md) — required environment
  variables.
- [resolve-blocked-queue.md](resolve-blocked-queue.md) — the
  user-facing version of Scenario 3.
- [month-end-close.md](month-end-close.md) — period locking.
