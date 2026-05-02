# Backup + restore

How to take a logical Postgres backup of the production database, and
how to restore that backup into a throwaway database to verify it.

The procedure below was verified end-to-end against the development
database on 2026-05-02 (Task #139). It works against any Postgres 16
instance reachable by `psql`/`pg_dump` from a Replit shell.

## Prerequisites

- Shell access to the Replit project that owns the database (so
  `DATABASE_URL` is in scope).
- Postgres client tools on the path. On Replit they are pre-installed
  via the `postgresql-16` Nix module declared in `.replit`.
- Sufficient disk space in `/tmp` for the dump (the dev DB at the time
  of the drill produced an ~8 MB compressed dump).

## Backup procedure

```bash
# 1. Pick a destination path with a timestamp.
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=/tmp/lh-backup-${TS}.sql.gz

# 2. Take a logical, custom-format-friendly plain SQL dump and gzip it.
#    --no-owner / --no-acl strips role names so the dump can be restored
#    into a throwaway DB owned by a different user.
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip -9 > "$DUMP"

# 3. Confirm the dump is non-empty and inspect the header.
ls -lh "$DUMP"
gunzip -c "$DUMP" | head -20
```

For long-term storage, copy the `$DUMP` file out of `/tmp` (which is
ephemeral) into Object Storage or download it via the Replit file
browser.

## Restore procedure

```bash
# 1. Pick the dump to restore (most recent by default).
DUMP=$(ls -t /tmp/lh-backup-*.sql.gz | head -1)

# 2. Create a throwaway database. We never restore on top of the live
#    DB — we restore into a new DB and then point the application at
#    it (via DATABASE_URL) once the restore is verified.
RESTORE_DB=lh_restore_$(date -u +%s)
psql "$DATABASE_URL" -c "CREATE DATABASE \"$RESTORE_DB\""

# 3. Restore. --single-transaction wraps the entire restore so a
#    schema error rolls back rather than leaving a half-restored DB.
RESTORE_URL=$(echo "$DATABASE_URL" | sed -E "s|/[^/?]+(\?.*)?$|/$RESTORE_DB\1|")
gunzip -c "$DUMP" | psql "$RESTORE_URL" --single-transaction

# 4. Smoke check: the restored DB has the expected tables and rows.
psql "$RESTORE_URL" -c "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC
  LIMIT 20;
"

# 5. Run the integrity sweep against the restored DB. Override
#    DATABASE_URL just for this command — do NOT export it, or the
#    next process will keep talking to the throwaway DB.
DATABASE_URL=$RESTORE_URL pnpm --filter @workspace/api-server run integrity:sweep

# 6. (When you're done verifying.) Drop the throwaway DB.
psql "$DATABASE_URL" -c "DROP DATABASE \"$RESTORE_DB\""
```

The integrity sweep MUST exit 0 with all 32 checks at `count: 0`. If
any check reports a finding the dump captured a known-bad state — do
NOT promote the restore to production. See [admin-emergency.md](admin-emergency.md)
Scenario 5.

## Promoting a restore to production

The above procedure verifies the dump. To actually promote the
restored database to production, you must point the production
application at it. Replit production databases are managed and you
cannot freely swap `DATABASE_URL` — open a support ticket to have the
restored DB swapped in. Provide the dump file and the verification
output (sweep result) with the request.

## What is **not** in this procedure

- Continuous streaming replication. The dev/prod databases are
  Replit-managed Postgres; HA is provided by Replit, not by us.
- Encrypted-at-rest dump archives. If you need to ship the dump
  off-platform, encrypt the gzip output with `gpg -c` first and
  store the passphrase in the team password manager.
- Point-in-time recovery (PITR). Out of scope for V1 launch.

## Drill log

| Date | DB | Dump size | Restore time | Sweep result |
| --- | --- | --- | --- | --- |
| 2026-05-02 | dev | ~8 MB compressed | < 30s | 32/32 checks ok |
