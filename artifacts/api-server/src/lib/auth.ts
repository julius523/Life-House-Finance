import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, type UserRow } from "@workspace/db";
import { eq } from "drizzle-orm";

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
  role: "admin" | "approver" | "submitter";
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
  return toAuthUser(user);
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  loadUserFromCookie(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      req.authUser = user;
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
