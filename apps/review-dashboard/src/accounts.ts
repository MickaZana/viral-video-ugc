import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  aggregateUsage,
  createAccountStore,
  createSessionStore,
  createSettingsStore,
  EmailAlreadyRegisteredError,
  toPublicAccount,
  type AccountSettingsInput
} from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import { PlatformSchema, RunConfigSchema } from "@vvugc/shared-schema";
import { runCycle } from "@vvugc/orchestrator";
import { z } from "zod";

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

// Same rationale as server.ts's own asyncHandler (Express 4 doesn't forward a rejected
// promise from an async handler on its own) — duplicated rather than imported since these
// are two independent route-registration modules, not worth a shared-utility extraction
// for four lines.
function asyncHandler<P = Record<string, string>>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const SettingsInputSchema = z.object({
  niche: z.string().min(1),
  brandVoice: z.string().min(1),
  platforms: z.array(PlatformSchema).min(1),
  targetDurationSec: z.number().int().min(15).max(60),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini"]),
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  cadence: z.enum(["weekly", "manual"])
});

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
  const settingsStore = createSettingsStore(join(VVUGC_RUNS_DIR, "account-settings.json"));

  // Triggering a run is a real (potentially paid, once live credentials are configured)
  // vendor call chain — same "every attempt counts" reasoning as regeneration/publishing.
  const runRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many run requests — try again later" }
  });

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

  app.get("/accounts/settings", requireSession, (req: AuthedRequest, res: Response) => {
    res.json(settingsStore.get(req.accountId!));
  });

  app.put("/accounts/settings", requireSession, (req: AuthedRequest, res: Response) => {
    const parsed = SettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    res.json(settingsStore.upsert(req.accountId!, parsed.data as AccountSettingsInput));
  });

  // Self-service "Run now" — builds a RunConfig from the account's saved settings and runs
  // the real pipeline (discovery -> transcript -> script -> video-gen -> assembly -> QA ->
  // review queue), tagged with accountId so it shows up in that account's usage and only
  // that account's review items. Defaults to --dry-run (safe, no vendor credentials needed)
  // unless the caller explicitly asks for a live run — mirrors the CLI's own default posture.
  app.post(
    "/accounts/run",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const settings = settingsStore.get(req.accountId!);
      if (!settings.niche) {
        return res.status(400).json({ error: "save settings (at least a niche) before running" });
      }

      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        niche: settings.niche,
        platforms: settings.platforms,
        brandVoice: settings.brandVoice,
        targetDurationSec: settings.targetDurationSec,
        videoVendor: settings.videoVendor,
        voiceVendor: settings.voiceVendor,
        accountId: req.accountId,
        dryRun: req.body?.dryRun !== false,
        createdAt: new Date().toISOString()
      });

      const result = await runCycle(config, { onProgress: () => {} });
      res.json(result);
    })
  );

  return { requireSession };
}
