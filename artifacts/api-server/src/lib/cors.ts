/**
 * CORS allowlist for the finance-portal API.
 *
 * Origins are stored *and* compared in lower case because DNS host names
 * are case-insensitive but Origin headers preserve the case from the
 * URL the browser was loaded from. A user landing on
 * `https://Lifehouseaccounting.replit.app` (capital L) would otherwise
 * send `Origin: https://Lifehouseaccounting.replit.app`, which fails an
 * exact-string match against the lowercase `lifehouseaccounting.replit.app`
 * stored in REPLIT_DOMAINS — and then the cors middleware throws an
 * Error("CORS: origin '...' is not allowed") which surfaces as a bare
 * HTTP 500 to the user. Lowercasing both sides removes that footgun.
 */
function normalize(origin: string): string {
  return origin.trim().toLowerCase();
}

function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  if (devDomain) {
    origins.add(normalize(`https://${devDomain}`));
  }
  const prodDomains = process.env["REPLIT_DOMAINS"];
  if (prodDomains) {
    for (const d of prodDomains.split(",")) {
      const trimmed = d.trim();
      if (trimmed) origins.add(normalize(`https://${trimmed}`));
    }
  }
  if (process.env["NODE_ENV"] !== "production") {
    origins.add("http://localhost");
    origins.add("http://localhost:3000");
    origins.add("http://localhost:5173");
  }
  return origins;
}

export const allowedOrigins = buildAllowedOrigins();

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins.has(normalize(origin));
}
