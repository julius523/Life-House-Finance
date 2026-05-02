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
pnpm --filter @workspace/finance-portal test
