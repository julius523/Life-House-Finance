import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, type UserRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  AUTOMATION_USER_EMAIL,
  extractBearerToken,
  isValidApiKey,
} from "./apiKey";

const COOKIE_NAME = "lh_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getSecret(): string {
  const s = process.env["SESSION_SECRET"];
  if (s && s.length >= 16) return s;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production (min 16 chars)."
    );
  }
  return "life-house-dev-secret-do-not-use-in-production-please-set-SESSION_SECRET";
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
}

export function encodeSession(userId: number): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string): { userId: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expiresAtStr, sig] = parts;
  if (!userIdStr || !expiresAtStr || !sig) return null;
  const payload = `${userIdStr}.${expiresAtStr}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expiresAtStr)) return null;
  const userId = Number(userIdStr);
  if (!Number.isInteger(userId)) return null;
  return { userId };
}

export function setSessionCookie(res: Response, userId: number): void {
  const token = encodeSession(userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export type AuthUser = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "approver" | "submitter" | "service";
};

declare module "express-serve-static-core" {
  interface Request {
    authUser?: AuthUser;
  }
}

export function toAuthUser(u: UserRow): AuthUser {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role as AuthUser["role"],
  };
}

export async function loadUserFromCookie(
  req: Request
): Promise<AuthUser | null> {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    COOKIE_NAME
  ];
  if (!raw) return null;
  const decoded = decodeSession(raw);
  if (!decoded) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, decoded.userId));
  if (!user || !user.isActive) return null;
  // Defense in depth: the service account should never be able to mint
  // a cookie session, but if one is somehow ever set (e.g. in a test
  // harness), reject the cookie. Service auth must come from the
  // bearer-token path below.
  if (user.role === "service") return null;
  return toAuthUser(user);
}

/**
 * Loads the seeded automation@lifehousereentry.com row when the request
 * presents a valid INTEGRATION_API_KEY bearer token. Returns null when
 * no token is presented, the key is unset/invalid, or the seeded row
 * is missing/inactive/has been re-roled.
 *
 * This is checked BEFORE the cookie path in requireAuth — so a single
 * request that includes both a cookie and a bearer token always runs
 * as the service account (i.e. tokens win). That's the safe default
 * because cookies are ambient and would otherwise let a logged-in
 * browser tab silently elevate any cross-origin request that happened
 * to also carry the bearer header.
 */
export async function loadServiceUserFromBearer(
  req: Request,
): Promise<AuthUser | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  if (!isValidApiKey(token)) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, AUTOMATION_USER_EMAIL));
  if (!user || !user.isActive) return null;
  if (user.role !== "service") return null;
  return toAuthUser(user);
}

/**
 * Lazy, process-lifetime cache of the seeded automation user's row id.
 * Used by formatReceipt to derive `entrySource` from the receipt's
 * uploadedBy FK without joining on every row. The lookup is performed
 * at most once per process; if it misses (e.g. seedUsers hasn't run
 * yet on a brand-new DB) we re-attempt on the next call instead of
 * caching the null.
 */
let cachedAutomationUserId: number | null = null;

export async function getAutomationUserId(): Promise<number | null> {
  if (cachedAutomationUserId !== null) return cachedAutomationUserId;
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, AUTOMATION_USER_EMAIL));
  if (!user) return null;
  cachedAutomationUserId = user.id;
  return cachedAutomationUserId;
}

/**
 * Test hook: force-reset the automation-user-id cache so a test can
 * mutate the seeded row and re-observe the lookup. Production code
 * never calls this.
 */
export function __resetAutomationUserIdCacheForTests(): void {
  cachedAutomationUserId = null;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Bearer token first: when an automation client sends both a cookie
  // and a bearer token (e.g. an Apps Script that ran in a browser tab
  // before), we want it to authenticate as the service account, not as
  // whatever user happens to have a cookie sitting around.
  //
  // Fail-closed rule: if the caller sent ANY Authorization header we
  // do NOT silently fall back to cookie auth on a bad bearer. A typo'd
  // or rotated key from an automation client must surface as 401 so
  // the operator notices, instead of quietly running as some
  // unrelated cookie user that may have ambient access.
  const hasAuthHeader = typeof req.headers["authorization"] === "string"
    && req.headers["authorization"].trim().length > 0;
  loadServiceUserFromBearer(req)
    .then(async (serviceUser) => {
      if (serviceUser) {
        req.authUser = serviceUser;
        next();
        return;
      }
      if (hasAuthHeader) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const cookieUser = await loadUserFromCookie(req);
      if (!cookieUser) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      req.authUser = cookieUser;
      next();
    })
    .catch((err) => {
      req.log?.error({ err }, "Auth middleware failure");
      res.status(500).json({ error: "Auth error" });
    });
}

export function requireRole(
  ...roles: Array<AuthUser["role"]>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!req.authUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.authUser.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
