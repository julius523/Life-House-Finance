#!/bin/bash
set -e

# Deploy script for the finance app on the droplet (2026-09-06).
#
# This repo's own scripts/post-merge.sh (install, drizzle push, schema
# parity gate, tests) was written for Replit's publish flow, which builds
# the app separately as part of publishing -- it was never actually a
# complete droplet deploy on its own, since nothing here ever ran the
# actual `pnpm build` for api-server/finance-portal. This script reuses
# post-merge.sh as-is (so its checks stay in sync with upstream changes
# to that file) and adds the build + env-loading + restart steps a
# droplet deploy actually needs on top of it.
#
# Runs as the dedicated `lhfinance` system user, not root (migrated off
# root 2026-09-06) -- every write/build/restart must happen as lhfinance
# or the build re-roots file ownership and `pm2 restart` targets the
# wrong PM2 daemon entirely (same lesson as the main app's migration).
echo "🚀 Deploying Life House Finance..."

su lhfinance -s /bin/bash -c '
  set -e
  export HOME=/home/lhfinance
  cd /var/www/life-house-finance

  git fetch origin main
  git reset --hard origin/main

  # lib/db/drizzle.config.ts and this apps env-var checks all read
  # straight off the shell environment -- nothing auto-sources the real
  # .env (which only lives under artifacts/api-server/) for these
  # workspace-root commands. See scripts/env-to-exports.cjs for why this
  # is not a plain `source`.
  node scripts/env-to-exports.cjs artifacts/api-server/.env > /tmp/finance-env.sh
  source /tmp/finance-env.sh
  rm -f /tmp/finance-env.sh

  bash scripts/post-merge.sh

  pnpm --filter @workspace/api-server run build
  # finance-portals vite.config.ts refuses to even load without BASE_PATH
  # set (PORT is already exported above from the same .env). This app is
  # served at the domain root (finance.lifehousereentry.org/), not a
  # subpath, so "/" is correct.
  BASE_PATH="/" pnpm --filter @workspace/finance-portal run build

  # --update-env: the env vars sourced above must actually reach the
  # restarted process, not just this shell -- confirmed live 2026-09-06
  # that a plain `pm2 restart` reuses PM2s previously-cached environment
  # and crash-loops on a missing DATABASE_URL even though this shell has
  # it.
  pm2 restart life-house-finance --update-env
  pm2 save
'

echo "✅ Finance deployment complete!"
