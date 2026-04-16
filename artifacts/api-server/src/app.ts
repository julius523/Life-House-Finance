import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./lib/auth";
import { ensureTodaySnapshot } from "./lib/dailySnapshot";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Gate all /api/* except authentication and health behind the session cookie.
app.use("/api", (req, res, next) => {
  const url = req.url.split("?")[0] ?? "";
  if (
    url === "/healthz" ||
    url.startsWith("/auth/") ||
    url === "/auth/login" ||
    url === "/auth/logout" ||
    url === "/auth/me"
  ) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

// Ensure today's snapshot exists before any mutating request runs, so a restore
// can always revert to the state at the start of the day.
app.use("/api", (req, _res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  const url = req.url.split("?")[0] ?? "";
  if (
    url.startsWith("/auth/") ||
    url === "/admin/restore-day" ||
    url === "/admin/wipe-data"
  ) {
    next();
    return;
  }
  ensureTodaySnapshot()
    .catch(() => undefined)
    .finally(() => next());
});

app.use("/api", router);

export default app;
