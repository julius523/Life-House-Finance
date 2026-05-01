function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  if (devDomain) {
    origins.add(`https://${devDomain}`);
  }
  const prodDomains = process.env["REPLIT_DOMAINS"];
  if (prodDomains) {
    for (const d of prodDomains.split(",")) {
      const trimmed = d.trim();
      if (trimmed) origins.add(`https://${trimmed}`);
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
  return allowedOrigins.has(origin);
}
