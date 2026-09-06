#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Schema parity gate: verifies that `drizzle-kit push` actually applied
# every table/column declared in the Drizzle schema. This is our
# substitute for a per-migration rollback annotation gate (the repo
# uses drizzle-kit push, not migration files). A failure here means the
# DB is out of sync with the code that's about to ship — refuse to
# continue. See docs/runbooks/admin-env-vars.md "Drizzle migrations".
pnpm --filter @workspace/scripts run schema-parity-check
pnpm --filter @workspace/api-server test
# NODE_ENV=test forced explicitly, not inherited: this script gets called
# from the droplet's deploy.sh with the API server's real production .env
# already sourced into the shell (NODE_ENV=production) so the build steps
# after this can see DATABASE_URL/PORT/etc. Vitest/React honor an
# already-set NODE_ENV instead of defaulting to 'test', and the
# production build of react-dom strips test-utils' act() entirely --
# confirmed live 2026-09-06, this is why the finance-portal suite looked
# "flaky": it deterministically fails whenever NODE_ENV=production is
# already in the calling shell (every real droplet deploy) and
# deterministically passes when run standalone with a clean environment.
NODE_ENV=test pnpm --filter @workspace/finance-portal test
