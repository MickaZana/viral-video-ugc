import { join } from "node:path";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { aggregateUsage, createAccountStore, createSessionStore, EmailAlreadyRegisteredError, toPublicAccount } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";

const SESSION_COOKIE = "vvugc_session";
const isProduction = process.env.NODE_ENV === "production";

/**
 * Minimal manual cookie parsing rather than adding the `cookie`/`cookie-parser`
 * dependency — the format this needs (a single httpOnly session token, no
 * signing/encryption beyond the session store's own random token) doesn't need
 * a general-purpose cookie library, matching this repo's existing preference
 * for small hand-rolled utilities over new dependencies for simple parsing
 * (see shared-http's fetchWithRetry instead of an HTTP client library).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function sessionCookieHeader(token: string, maxAgeSec: number): string {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSec}`];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookieHeader(): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

export interface AuthedRequest extends Request {
  accountId?: string;
}

/**
 * Account signup/login is separate from the dashboard's existing single-operator
 * HTTP Basic Auth (auth.ts) — Basic Auth stays exactly as it is (it gates the
 * approve/reject queue for whoever operates this dashboard instance), while
 * accounts are the beginning of the customer-facing, multi-tenant surface (each
 * agency/brand gets its own login and usage view — see @vvugc/shared-auth).
 * Deliberately additive: nothing here changes what Basic Auth already protects.
 */
export function registerAccountRoutes(app: Express): { requireSession: RequestHandler } {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const accountStore = createAccountStore(join(VVUGC_RUNS_DIR, "accounts.json"));
  const sessionStore = createSessionStore(join(VVUGC_RUNS_DIR, "sessions.json"));

  // Same rationale as server.ts's authRateLimiter for Basic Auth — slows credential
  // stuffing/brute force against signup+login without penalizing normal use.
  const accountRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many attempts — try again later" }
  });

  const requireSession: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? sessionStore.verify(token) : undefined;
    if (!session) return res.status(401).json({ error: "not authenticated" });
    req.accountId = session.accountId;
    next();
  };

  app.post("/accounts/signup", accountRateLimiter, (req: Request, res: Response) => {
    const { email, password, orgName } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    let account;
    try {
      account = accountStore.signUp(email, password, typeof orgName === "string" ? orgName : undefined);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    res.status(201).json({ account: toPublicAccount(account) });
  });

  app.post("/accounts/login", accountRateLimiter, (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    const account = accountStore.authenticate(email, password);
    if (!account) return res.status(401).json({ error: "invalid email or password" });

    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    res.json({ account: toPublicAccount(account) });
  });

  app.post("/accounts/logout", (req: Request, res: Response) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessionStore.revoke(token);
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  });

  app.get("/accounts/me", requireSession, (req: AuthedRequest, res: Response) => {
    const account = accountStore.findById(req.accountId!);
    if (!account) return res.status(401).json({ error: "not authenticated" });
    res.json({ account: toPublicAccount(account) });
  });

  app.get("/accounts/usage", requireSession, (req: AuthedRequest, res: Response) => {
    res.json(aggregateUsage(req.accountId!, VVUGC_RUNS_DIR));
  });

  return { requireSession };
}
