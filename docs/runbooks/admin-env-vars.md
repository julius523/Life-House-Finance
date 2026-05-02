# Environment variables checklist

This is the canonical list of every environment variable the production
api-server reads. The boot guard in `src/lib/envCheck.ts` exits 1 if any
**Required** variable is missing — the application refuses to run
half-configured rather than fail in subtle production-only ways.

Keep this file in sync with `REQUIRED_ENV_VARS` and `OPTIONAL_ENV_VARS`
in `artifacts/api-server/src/lib/envCheck.ts`.

## Required (api-server refuses to start without these)

| Name | Secret? | Purpose | What breaks if missing |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string for the primary DB. Set automatically by Replit when the managed Postgres is provisioned. | All DB calls throw at boot. App cannot start. |
| `PORT` | no | TCP port the Express listener binds to. Wired by the artifact runtime. | Boot throws "PORT environment variable is required". |
| `SESSION_SECRET` | yes | HMAC key for signed session cookies. | Login still issues cookies but they cannot be verified across restarts; users get logged out and admin actions become unverifiable. Auth code throws when `NODE_ENV=production`. |
| `REPLIT_DOMAINS` | no | Comma-separated list of public hostnames. Sourced from the deployment runtime. Used to populate the CORS allowlist. | Browser requests from the public site are rejected by CORS — login returns HTTP 500 with a bare "CORS: origin '...' is not allowed" body (the failure mode that broke prod login on 2026-05-02). |
| `INTEGRATION_API_KEY` | yes | Bearer token presented by the Apps Script automation at `automation@lifehousereentry.com`. Must be ≥ 32 chars. | The service-role bearer path always returns 401, breaking the Apps Script credit/receipt automation. |

## Optional (degrade specific features when absent)

| Name | Secret? | Purpose | What degrades |
| --- | --- | --- | --- |
| `SENDGRID_API_KEY` | yes | SendGrid SMTP API key for outgoing email. | Notifications log a warning and are not delivered. Scheduled CSV exports auto-pause after 3 consecutive failures. |
| `NOTIFICATION_FROM_EMAIL` | no | `From:` header on outgoing notifications. | Notifications log a warning and are not delivered. |
| `NOTIFICATION_FROM_NAME` | no | Friendly name in the `From:` header. | Falls back to the `DEFAULT_SENDER_NAME` constant. |
| `OPENAI_API_KEY` | yes | Direct-to-OpenAI key used by the legacy accounting agent path. | Accounting agent endpoints return a configuration error. |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | yes | Replit AI-integrations proxy key for the Copilot. | Copilot endpoints return 503. |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | no | Replit AI-integrations proxy base URL. | Copilot client falls back to default OpenAI URL — likely unauthorised. |
| `ACCOUNTING_AGENT_MODEL` | no | Model name pinned for the legacy accounting agent. | Defaults to `gpt-5.4`. |
| `REPLIT_DEV_DOMAIN` | no | Local dev preview hostname. Used to populate dev-side CORS allowlist. | Dev preview blocked by CORS. |
| `SEED_DEV_USERS` | no | Set to `true` only in `NODE_ENV=development` to insert the synthetic seed accounts (`dev-admin1@dev-only.example` etc.). The startup guard halts the process if this flag is set in any non-development environment. | Dev users not seeded. Setting it in production is a hard exit. |

## Drizzle migrations

This repo does **not** ship a `lib/db/migrations/` directory. Schema
changes are applied by:
1. Editing `lib/db/src/schema/*.ts`.
2. Running `pnpm --filter @workspace/db run push` against development.
3. Re-publishing — Replit's publish flow diffs dev → prod and applies
   the SQL automatically (see `.local/skills/database/references/database-migrations-on-publish.md`).

There are therefore no per-migration rollback annotations. Rollback is
"restore from the most recent backup" — see
`docs/runbooks/admin-backup-restore.md`.

## Verifying

- `GET /api/healthz` returns 200 only when DB ping, schema sanity,
  scheduler liveness, and required env vars are all green. It returns
  503 with a structured JSON body listing the failing probe(s)
  otherwise. The Replit deployment startup probe targets this endpoint
  (see `artifacts/api-server/.replit-artifact/artifact.toml`).
- The boot log emits `envCheck: all required environment variables
  present` when the guard passes.
