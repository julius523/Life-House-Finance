import { logger } from "./logger";

/**
 * Required environment variables. The api-server refuses to start if any
 * of these are missing — half-configured boots silently break in
 * production-specific ways (CORS errors, JWT failures, untraceable 500s)
 * and are much harder to diagnose later than a clean exit at startup.
 *
 * The full reference doc, including "what breaks if missing", is at
 * docs/runbooks/admin-env-vars.md. Keep both lists in sync.
 */
const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "PORT",
  "SESSION_SECRET",
  "REPLIT_DOMAINS",
  "INTEGRATION_API_KEY",
] as const;

/**
 * Optional environment variables. Listed here for visibility only — the
 * boot guard does NOT enforce these. Each one degrades a specific
 * feature when absent (documented in admin-env-vars.md).
 */
const OPTIONAL_ENV_VARS = [
  "SENDGRID_API_KEY",
  "NOTIFICATION_FROM_EMAIL",
  "NOTIFICATION_FROM_NAME",
  "OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "ACCOUNTING_AGENT_MODEL",
  "REPLIT_DEV_DOMAIN",
  "SEED_DEV_USERS",
  "MASTER_WIPE_PASSWORD",
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export function getMissingRequiredEnvVars(): RequiredEnvVar[] {
  const missing: RequiredEnvVar[] = [];
  for (const k of REQUIRED_ENV_VARS) {
    const v = process.env[k];
    if (v === undefined || v.trim() === "") missing.push(k);
  }
  return missing;
}

export function getRequiredEnvVarNames(): readonly RequiredEnvVar[] {
  return REQUIRED_ENV_VARS;
}

export function getOptionalEnvVarNames(): readonly string[] {
  return OPTIONAL_ENV_VARS;
}

/**
 * Boot-time guard. Logs a structured fatal record naming every missing
 * variable, then exits 1. Tests should NOT call this — they do not have
 * the production env populated and exit() would kill the test runner.
 */
export function assertRequiredEnvVarsOrExit(): void {
  const missing = getMissingRequiredEnvVars();
  if (missing.length === 0) {
    logger.info(
      { count: REQUIRED_ENV_VARS.length },
      "envCheck: all required environment variables present",
    );
    return;
  }
  logger.fatal(
    { missing, total: REQUIRED_ENV_VARS.length },
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `See docs/runbooks/admin-env-vars.md. Refusing to start.`,
  );
  process.exit(1);
}
