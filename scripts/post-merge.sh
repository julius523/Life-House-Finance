#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/finance-portal test
