import crypto from "node:crypto";
import type { Request } from "express";

/**
 * Service-account API key auth. When INTEGRATION_API_KEY is set in the
 * environment, requests can authenticate by sending
 *
 *   Authorization: Bearer <INTEGRATION_API_KEY>
 *
 * instead of (or in addition to) the cookie session. Such requests run
 * as the seeded `automation@lifehousereentry.com` service account
 * (role="service"). The role grants:
 *
 *   - Read access to /credits, /credit-summary, /receipts, /bills, /expenses
 *   - POST /credits and POST /receipts
 *
 * and is explicitly excluded from every requireRole("admin", ...) /
 * requireRole("admin", "approver") gate, so all approval, deletion,
 * and admin endpoints return 403 for the service account.
 *
 * The key is matched with timing-safe comparison so a successful
 * match cannot be inferred from response time.
 *
 * The header lookup is case-insensitive — Express normalises header
 * names but we still do `.toLowerCase()` on the scheme prefix to be
 * defensive against clients that send "BEARER" or "bearer".
 */
export const AUTOMATION_USER_EMAIL = "automation@lifehousereentry.com";
export const AUTOMATION_DISPLAY_NAME = "Automation";
export const API_SOURCE_HEADER = "x-api-source";
export const API_SOURCE_DEFAULT = "automation";

/** Returns the configured API key, or null when the env var is unset. */
export function getConfiguredApiKey(): string | null {
  const raw = process.env["INTEGRATION_API_KEY"];
  if (!raw) return null;
  const trimmed = raw.trim();
  // Reject obviously-too-short keys so a typo'd "x" can't accidentally
  // unlock the whole API. 32 hex chars is the minimum we recommend.
  if (trimmed.length < 32) return null;
  return trimmed;
}

/**
 * Extract the bearer credential from the Authorization header. Returns
 * null when no header is present or it does not use the Bearer scheme.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return null;
  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== "bearer") return null;
  const token = trimmed.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * Returns true when `presented` matches the configured key using a
 * length-agnostic timing-safe compare. False when the env var is
 * unset or the strings differ.
 */
export function isValidApiKey(presented: string): boolean {
  const expected = getConfiguredApiKey();
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // crypto.timingSafeEqual requires equal-length buffers. For unequal
  // lengths we still hash both to a fixed digest so the comparison is
  // constant-time and reveals nothing about which side was longer.
  if (a.length !== b.length) {
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    crypto.timingSafeEqual(ha, hb);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pulls the X-API-Source header off the request, falling back to the
 * default tag when the caller did not provide one. Always returns a
 * non-empty string so it can be safely written to the activity log
 * without further normalisation.
 */
export function readApiSource(req: Request): string {
  const raw = req.headers[API_SOURCE_HEADER];
  if (typeof raw !== "string") return API_SOURCE_DEFAULT;
  const trimmed = raw.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : API_SOURCE_DEFAULT;
}
