import { join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  aggregateUsage,
  createAccountStore,
  createAgencyClientStore,
  createInviteStore,
  createSessionStore,
  createSettingsStore,
  createSocialConnectionStore,
  resolveOrgId,
  roleHasPermission,
  EmailAlreadyRegisteredError,
  toPublicAccount,
  ACCOUNT_ROLES,
  type Account,
  type AccountPermission,
  type AccountRole,
  type AgencyClientInput,
  type AccountSettingsInput
} from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import { PlatformSchema, RunConfigSchema } from "@vvugc/shared-schema";
import { runAcceptance, runCycle } from "@vvugc/orchestrator";
import {
  getReviewItem,
  listReviewItems,
  setReviewItemStatus,
  deleteReviewItemsByOrg
} from "@vvugc/review-queue";
import { createPlanStore } from "@vvugc/shared-billing";
import { z } from "zod";
import { checkRunQuota } from "./quota.js";
import { deleteSecurityEventsForAccount, deleteSecurityEventsForOrg, listSecurityEvents, writeSecurityEvent } from "./security-events.js";
import { createPipelineJobStore } from "./jobs.js";
import { createMfaChallengeStore, createMfaStore } from "./mfa.js";
import { generateTotpSecret, otpauthTotpUrl, verifyTotpCode } from "./totp.js";
import { purgeOrgRuns } from "./runs.js";
import {
  createGoogleOAuthState,
  createOAuthNonceStore,
  exchangeGoogleAuthorizationCode,
  fetchGoogleYouTubeChannel,
  googleAuthorizationUrl,
  verifyGoogleOAuthState
} from "./google-oauth.js";
import { resolveSocialTokenEncryptionKey } from "./social-token-key.js";

const isProduction = process.env.NODE_ENV === "production";
const SESSION_COOKIE = isProduction ? "__Host-vvugc_session" : "vvugc_session";

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
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${maxAgeSec}`];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookieHeader(): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

export interface AuthedRequest extends Request {
  accountId?: string;
  auditActor?: string;
}

function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`vvugc-csrf:${sessionToken}`).digest("base64url");
}

function equalToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Same rationale as server.ts's own asyncHandler (kept explicit even though Express 5
// forwards async rejections on its own) — duplicated rather than imported since these
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
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate"]),
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  cadence: z.enum(["weekly", "manual"])
});

const ClientInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  niche: z.string().trim().min(1).max(200),
  brandVoice: z.string().trim().min(1).max(500),
  locale: z.string().trim().min(2).max(35).default("en"),
  platforms: z.array(PlatformSchema).min(1),
  targetDurationSec: z.number().int().min(15).max(60),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate"]),
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  cadence: z.enum(["weekly", "manual"]),
  active: z.boolean().default(true)
});

/**
 * Account signup/login is separate from the dashboard's existing single-operator
 * HTTP Basic Auth (auth.ts) — Basic Auth stays exactly as it is (it gates the
 * approve/reject queue for whoever operates this dashboard instance), while
 * accounts are the beginning of the customer-facing, multi-tenant surface (each
 * agency/brand gets its own login and usage view — see @vvugc/shared-auth).
 * Deliberately additive: nothing here changes what Basic Auth already protects.
 *
 * Settings/usage/billing are keyed by orgId (resolveOrgId(account)), not the raw
 * session accountId — every member of an org (owner + invited teammates) shares
 * one set of each, which is the actual point of multi-seat access.
 */
export function registerAccountRoutes(app: Express): { requireSession: RequestHandler } {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const accountStore = createAccountStore(join(VVUGC_RUNS_DIR, "accounts.json"));
  const sessionStore = createSessionStore(join(VVUGC_RUNS_DIR, "sessions.json"));
  const settingsStore = createSettingsStore(join(VVUGC_RUNS_DIR, "account-settings.json"));
  const clientStore = createAgencyClientStore(join(VVUGC_RUNS_DIR, "agency-clients.json"));
  const inviteStore = createInviteStore(join(VVUGC_RUNS_DIR, "invites.json"));
  const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));
  const tokenEncryptionKey = resolveSocialTokenEncryptionKey();
  const socialStore = createSocialConnectionStore(join(VVUGC_RUNS_DIR, "social-connections.json"), tokenEncryptionKey);
  const jobStore = createPipelineJobStore(join(VVUGC_RUNS_DIR, "pipeline-jobs.json"));
  const oauthNonceStore = createOAuthNonceStore(join(VVUGC_RUNS_DIR, "oauth-nonces.json"));
  const mfaStore = createMfaStore(join(VVUGC_RUNS_DIR, "mfa.json"));
  const mfaChallengeStore = createMfaChallengeStore(join(VVUGC_RUNS_DIR, "mfa-challenges.json"));

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
    // Browser fetch/form mutations carry Origin. Service clients without a browser
    // cookie context remain usable; the SameSite cookie and global origin check are
    // the first line, while this explicit token prevents same-origin gadget attacks.
    if (req.headers.origin && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const supplied = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
      if (!token || !equalToken(supplied, csrfTokenFor(token))) {
        return res.status(403).json({ error: "invalid CSRF token" });
      }
    }
    req.accountId = session.accountId;
    req.auditActor = `account:${session.accountId}`;
    next();
  };

  /** Resolves the authenticated account, 401ing if the session's accountId somehow
   *  doesn't map to a real account (e.g. deleted after the session was issued). */
  function requireAccount(req: AuthedRequest, res: Response): Account | undefined {
    const account = accountStore.findById(req.accountId!);
    if (!account) {
      res.status(401).json({ error: "not authenticated" });
      return undefined;
    }
    return account;
  }

  /** Resolves the account and 403s if its role lacks the given permission. Returns the
   *  account (so callers can fall through to using it) or undefined after writing the
   *  error response. Every mutation route gates through this — the UI hides what a role
   *  can't do, but a direct API hit gets a real 403, not just a hidden button. */
  function requirePermission(permission: AccountPermission): (req: AuthedRequest, res: Response) => Account | undefined {
    return (req, res) => {
      const account = requireAccount(req, res);
      if (!account) return undefined;
      if (!roleHasPermission(account.role, permission)) {
        res.status(403).json({ error: `requires the ${permission} permission` });
        return undefined;
      }
      return account;
    };
  }

  const clientIp = (req: Request): string | undefined => {
    const forwarded = req.headers["x-forwarded-for"];
    return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
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
    writeSecurityEvent({
      type: "account.created",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "role: owner (org creator)"
    });
    res.status(201).json({ account: toPublicAccount(account) });
  });

  app.post("/accounts/login", accountRateLimiter, (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    const account = accountStore.authenticate(email, password);
    if (!account) {
      writeSecurityEvent({ type: "login.failed", email, ip: clientIp(req) });
      return res.status(401).json({ error: "invalid email or password" });
    }

    // Step one of a two-step login when the account has two-factor enabled: the
    // password is correct, but instead of a session the client gets a short-lived,
    // single-use challenge token it must redeem with a valid TOTP code (see
    // POST /accounts/mfa/challenge). No session cookie is set here — knowing the
    // password alone no longer grants access to an MFA-protected account.
    const mfa = mfaStore.get(account.id);
    if (mfa?.confirmedAt) {
      const challenge = mfaChallengeStore.create(account.id);
      writeSecurityEvent({
        type: "login.mfa_challenge",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req)
      });
      return res.json({ mfaRequired: true, mfaToken: challenge.token, expiresAt: challenge.expiresAt });
    }

    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    writeSecurityEvent({
      type: "login.succeeded",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ account: toPublicAccount(account), csrfToken: csrfTokenFor(session.token) });
  });

  // Step two of an MFA login: redeem the challenge token from /accounts/login
  // with the account's current authenticator code. The challenge is single-use
  // (consumed by this handler whether it succeeds or fails), so a leaked token
  // can't be brute-forced — each attempt needs a fresh challenge. Public (no
  // session cookie exists yet at this point in the flow).
  app.post("/accounts/mfa/challenge", accountRateLimiter, (req: Request, res: Response) => {
    const { mfaToken, code } = req.body ?? {};
    if (typeof mfaToken !== "string" || typeof code !== "string") {
      return res.status(400).json({ error: "mfaToken and code are required" });
    }
    const challenge = mfaChallengeStore.consume(mfaToken);
    if (!challenge) return res.status(400).json({ error: "MFA challenge is invalid or has expired — log in again" });
    const account = accountStore.findById(challenge.accountId);
    const mfa = account ? mfaStore.get(account.id) : undefined;
    if (!account || !mfa?.confirmedAt) {
      return res.status(400).json({ error: "MFA is not enabled for this account" });
    }
    if (!verifyTotpCode(mfa.secret, code)) {
      writeSecurityEvent({
        type: "login.mfa_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req)
      });
      return res.status(401).json({ error: "invalid authentication code" });
    }
    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    writeSecurityEvent({
      type: "login.mfa_succeeded",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ account: toPublicAccount(account), csrfToken: csrfTokenFor(session.token) });
  });

  app.post("/accounts/logout", requireSession, (req: Request, res: Response) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessionStore.revoke(token);
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  });

  app.get("/accounts/me", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    res.json({
      account: toPublicAccount(account),
      csrfToken: sessionToken ? csrfTokenFor(sessionToken) : undefined,
      mfaEnabled: Boolean(mfaStore.get(account.id)?.confirmedAt)
    });
  });

  app.get("/accounts/usage", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json(aggregateUsage(resolveOrgId(account), VVUGC_RUNS_DIR));
  });

  app.get("/accounts/settings", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json(settingsStore.get(resolveOrgId(account)));
  });

  app.put("/accounts/settings", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("settings.manage")(req, res);
    if (!account) return;
    const parsed = SettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    res.json(settingsStore.upsert(resolveOrgId(account), parsed.data as AccountSettingsInput));
  });

  app.get("/accounts/clients", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({ clients: clientStore.listByOrg(resolveOrgId(account)) });
  });

  app.get("/accounts/social-connections", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    if (clientId && !clientStore.getForOrg(resolveOrgId(account), clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.json({ connections: socialStore.list(resolveOrgId(account), clientId) });
  });

  app.post("/accounts/social-connections", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const parsed = z.object({
      clientId: z.string().min(1),
      platform: PlatformSchema,
      accountLabel: z.string().trim().min(1).max(200),
      providerAccountId: z.string().trim().min(1).max(200).optional(),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      expiresAt: z.string().datetime().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid social connection" });
    if (!clientStore.getForOrg(resolveOrgId(account), parsed.data.clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.status(201).json({ connection: socialStore.connect(resolveOrgId(account), parsed.data) });
  });

  app.delete("/accounts/social-connections/:id", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!socialStore.disconnect(resolveOrgId(account), id)) return res.status(404).json({ error: "connection not found" });
    res.status(204).end();
  });

  app.post("/accounts/clients/:clientId/oauth/google/start", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    const orgId = resolveOrgId(account);
    if (!clientStore.getForOrg(orgId, clientId)) return res.status(404).json({ error: "client not found" });
    const env = loadEnv();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.OAUTH_STATE_SECRET) {
      return res.status(503).json({ error: "Google OAuth is not configured" });
    }
    const created = createGoogleOAuthState(orgId, clientId, env.OAUTH_STATE_SECRET);
    oauthNonceStore.add(created.value.nonce);
    res.json({
      authorizationUrl: googleAuthorizationUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
        state: created.state
      })
    });
  });

  app.get(
    "/oauth/google/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const env = loadEnv();
      if (!code || !state || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.OAUTH_STATE_SECRET) {
        return res.status(400).send("Google OAuth callback is incomplete");
      }
      const verified = verifyGoogleOAuthState(state, env.OAUTH_STATE_SECRET);
      if (!verified || !oauthNonceStore.consume(verified.nonce)) return res.status(400).send("OAuth state is invalid, expired, or already used");
      if (!clientStore.getForOrg(verified.orgId, verified.clientId)) return res.status(404).send("Client not found");
      const tokens = await exchangeGoogleAuthorizationCode({
        code,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI
      });
      const channel = await fetchGoogleYouTubeChannel(tokens.accessToken);
      socialStore.connect(verified.orgId, {
        clientId: verified.clientId,
        platform: "youtube_shorts",
        accountLabel: channel.label,
        providerAccountId: channel.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt
      });
      res.redirect("/account?oauth=google-connected");
    })
  );

  app.post(
    "/accounts/clients/:clientId/acceptance",
    requireSession,
    runRateLimiter,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
      const orgId = resolveOrgId(account);
      const client = clientStore.getForOrg(orgId, clientId);
      if (!client) return res.status(404).json({ error: "client not found" });
      const live = req.body?.live === true;
      // Dry-run acceptance is free and safe; a live run spends a real (potentially paid)
      // vendor chain, so it's gated by the stricter permission.
      if (!roleHasPermission(account.role, live ? "pipeline.run.live" : "pipeline.run")) {
        return res.status(403).json({ error: live ? "requires the pipeline.run.live permission" : "requires the pipeline.run permission" });
      }
      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        orgId,
        accountId: orgId,
        clientId,
        niche: client.niche,
        brandVoice: client.brandVoice,
        locale: client.locale,
        platforms: client.platforms,
        targetDurationSec: client.targetDurationSec,
        videoVendor: client.videoVendor,
        voiceVendor: client.voiceVendor,
        dryRun: !live,
        createdAt: new Date().toISOString()
      });
      const evidence = await runAcceptance(config, { onProgress: () => {} });
      res.status(evidence.passed ? 200 : 422).json(evidence);
    })
  );

  app.get("/accounts/jobs", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    if (clientId && !clientStore.getForOrg(resolveOrgId(account), clientId)) return res.status(404).json({ error: "client not found" });
    res.json({ jobs: await jobStore.list(resolveOrgId(account), clientId) });
  });

  app.post("/accounts/jobs", requireSession, runRateLimiter, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("pipeline.run")(req, res);
    if (!account) return;
    const orgId = resolveOrgId(account);
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : "";
    const client = clientStore.getForOrg(orgId, clientId);
    if (!client || !client.active) return res.status(404).json({ error: "client not found" });

    // Quota is enforced at enqueue time (this route) AND again immediately before
    // execution (processNextPipelineJob in jobs.ts) — enqueueing a job whose plan is
    // already exhausted would only waste a queue slot and then fail at execution anyway.
    const plan = planStore.get(orgId);
    const quota = checkRunQuota(plan, aggregateUsage(orgId, VVUGC_RUNS_DIR));
    if (!quota.allowed) {
      return res.status(402).json({ error: quota.reason });
    }

    const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : randomUUID();
    const config = RunConfigSchema.parse({
      runId: randomUUID(),
      orgId,
      accountId: orgId,
      clientId,
      niche: client.niche,
      platforms: client.platforms,
      brandVoice: client.brandVoice,
      locale: client.locale,
      targetDurationSec: client.targetDurationSec,
      videoVendor: client.videoVendor,
      voiceVendor: client.voiceVendor,
      dryRun: req.body?.live !== true,
      createdAt: new Date().toISOString()
    });
    const job = await jobStore.enqueue(orgId, clientId, config, idempotencyKey);
    res.status(job.status === "queued" ? 202 : 200).json({ job });
  });

  app.get("/accounts/jobs/:id", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await jobStore.get(resolveOrgId(account), id);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({ job });
  });

  app.delete("/accounts/jobs/:id", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("jobs.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Distinguish "no such job in your org" (404) from "your job, but it can't be
    // cancelled in its current state" (409) — without the pre-check, another tenant's
    // job id would answer 409 and reveal that an id exists somewhere in the store.
    if (!await jobStore.get(resolveOrgId(account), id)) {
      return res.status(404).json({ error: "job not found" });
    }
    if (!await jobStore.cancel(resolveOrgId(account), id)) return res.status(409).json({ error: "job cannot be cancelled" });
    res.status(204).end();
  });

  app.post("/accounts/jobs/:id/replay", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("jobs.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Same 404-vs-409 split as DELETE above — another tenant's job must read as
    // "not found", not "exists but isn't replayable".
    if (!await jobStore.get(resolveOrgId(account), id)) {
      return res.status(404).json({ error: "job not found" });
    }
    const job = await jobStore.replay(resolveOrgId(account), id);
    if (!job) return res.status(409).json({ error: "only a dead-letter job can be replayed" });
    res.json({ job });
  });

  app.post("/accounts/clients", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ClientInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    res.status(201).json({ client: clientStore.create(resolveOrgId(account), parsed.data as AgencyClientInput) });
  });

  app.put("/accounts/clients/:clientId", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ClientInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    const client = clientStore.update(resolveOrgId(account), clientId, parsed.data as AgencyClientInput);
    if (!client) return res.status(404).json({ error: "client not found" });
    res.json({ client });
  });

  app.delete("/accounts/clients/:clientId", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    if (!clientStore.archive(resolveOrgId(account), clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.status(204).end();
  });

  app.get(
    "/accounts/review-items",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
      if (clientId && !clientStore.getForOrg(resolveOrgId(account), clientId)) {
        return res.status(404).json({ error: "client not found" });
      }
      res.json({
        items: await listReviewItems({
          orgId: resolveOrgId(account),
          clientId
        })
      });
    })
  );

  app.get(
    "/accounts/review-items/:id",
    requireSession,
    asyncHandler<{ id: string }>(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const itemId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const item = await getReviewItem(itemId);
      if (!item || item.orgId !== resolveOrgId(account)) return res.status(404).json({ error: "review item not found" });
      res.json({ item });
    })
  );

  for (const status of ["approved", "rejected"] as const) {
    app.post(
      `/accounts/review-items/:id/${status === "approved" ? "approve" : "reject"}`,
      requireSession,
      asyncHandler<{ id: string }>(async (req: AuthedRequest, res: Response) => {
        const account = requirePermission("review.manage")(req, res);
        if (!account) return;
        const itemId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const item = await getReviewItem(itemId);
        if (!item || item.orgId !== resolveOrgId(account)) {
          return res.status(404).json({ error: "review item not found" });
        }
        await setReviewItemStatus(item.id, status);
        res.json({ id: item.id, status });
      })
    );
  }

  // Self-service "Run now" — builds a RunConfig from the org's saved settings and runs
  // the real pipeline (discovery -> transcript -> script -> video-gen -> assembly -> QA ->
  // review queue), tagged with the org's id so it shows up in every member's usage view
  // and review items are attributable to the org, not just whichever member clicked
  // the button. Defaults to --dry-run (safe, no vendor credentials needed) unless the
  // caller explicitly asks for a live run — mirrors the CLI's own default posture.
  app.post(
    "/accounts/run",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const account = requirePermission("pipeline.run")(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);
      const requestedClientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
      const client = requestedClientId ? clientStore.getForOrg(orgId, requestedClientId) : undefined;
      if (requestedClientId && !client) return res.status(404).json({ error: "client not found" });
      if (client && !client.active) return res.status(409).json({ error: "client is archived" });
      const legacySettings = settingsStore.get(orgId);
      const settings = client ?? legacySettings;
      if (!settings.niche) return res.status(400).json({ error: "create a client before running" });

      const plan = planStore.get(orgId);
      const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
      const quota = checkRunQuota(plan, usage);
      if (!quota.allowed) {
        return res.status(402).json({ error: quota.reason });
      }

      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        niche: settings.niche,
        platforms: settings.platforms,
        brandVoice: settings.brandVoice,
        targetDurationSec: settings.targetDurationSec,
        videoVendor: settings.videoVendor,
        voiceVendor: settings.voiceVendor,
        accountId: orgId,
        orgId,
        clientId: client?.id,
        locale: client?.locale ?? "en",
        dryRun: req.body?.dryRun !== false,
        createdAt: new Date().toISOString()
      });

      const result = await runCycle(config, { onProgress: () => {} });
      res.json(result);
    })
  );

  app.get("/accounts/members", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({
      members: accountStore.listByOrg(resolveOrgId(account)).map(toPublicAccount),
      role: account.role,
      // Server-computed so the UI can't drift from the actual permission map — the
      // routes still enforce with roleHasPermission regardless of what the page shows.
      canManageTeam: roleHasPermission(account.role, "team.manage")
    });
  });

  // team.manage holders (owner + admins) can invite — a member hitting this directly
  // gets a real 403, not just a hidden button.
  app.post("/accounts/invite", requireSession, accountRateLimiter, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const { email, role } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    // The owner role is not grantable via invite — an org has exactly one owner (the
    // original signup), and transferring ownership is a deliberate separate flow.
    const requestedRole = role === undefined ? "editor" : role;
    if (!ACCOUNT_ROLES.includes(requestedRole as AccountRole) || requestedRole === "owner") {
      return res.status(400).json({ error: `role must be one of: ${ACCOUNT_ROLES.filter((r) => r !== "owner").join(", ")}` });
    }

    const orgId = resolveOrgId(account);
    const invite = inviteStore.create(orgId, email, account.id, requestedRole as AccountRole);
    writeSecurityEvent({
      type: "invite.sent",
      actorAccountId: account.id,
      orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: undefined,
      detail: `invited ${email} as ${requestedRole}`
    });
    // No email-sending infrastructure exists in this repo (see marketing-site's
    // WAITLIST_WEBHOOK_URL for the one place that does send anything externally) —
    // the invite link is returned directly for the owner to copy/send themselves,
    // same "no fake integration" posture as everywhere else unbuilt in this project.
    res.status(201).json({ inviteToken: invite.token, expiresAt: invite.expiresAt });
  });

  app.post("/accounts/invite/accept", accountRateLimiter, (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "token and a password (8+ characters) are required" });
    }

    const invite = inviteStore.verify(token);
    if (!invite) return res.status(400).json({ error: "invite is invalid or has expired" });

    let account;
    try {
      account = accountStore.signUpAsMember(invite.email, password, invite.orgId, invite.role);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
    inviteStore.consume(token);
    writeSecurityEvent({
      type: "invite.accepted",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: `role: ${invite.role}`
    });

    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    res.status(201).json({ account: toPublicAccount(account) });
  });

  // Self-service password change. Every session (including this one) is revoked so a
  // stolen or shared session can't survive a password reset — the client clears the
  // cookie and the user re-authenticates with the new password.
  app.post("/accounts/password", requireSession, accountRateLimiter, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    if (!accountStore.authenticate(account.email, currentPassword)) {
      writeSecurityEvent({
        type: "password.change_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req),
        detail: "incorrect current password"
      });
      return res.status(403).json({ error: "current password is incorrect" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "new password must differ from the current password" });
    }
    accountStore.updatePassword(account.id, newPassword);
    sessionStore.revokeAllForAccount(account.id);
    writeSecurityEvent({
      type: "password.changed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "all sessions revoked"
    });
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  });

  // Re-role a member (team.manage). The target's sessions are revoked so the new
  // permission set actually takes effect instead of lingering on an old session.
  app.put("/accounts/members/:id/role", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const role = req.body?.role;
    if (!ACCOUNT_ROLES.includes(role as AccountRole) || role === "owner") {
      return res.status(400).json({ error: `role must be one of: ${ACCOUNT_ROLES.filter((r) => r !== "owner").join(", ")}` });
    }
    const target = accountStore.findById(targetId);
    if (!target || target.orgId !== account.orgId) {
      return res.status(404).json({ error: "member not found" });
    }
    const updated = accountStore.setRole(account.orgId, targetId, role as AccountRole);
    // setRole refuses the org's owner — the owner role is not reassignable.
    if (!updated) return res.status(409).json({ error: "the org owner's role cannot be changed" });
    sessionStore.revokeAllForAccount(targetId);
    writeSecurityEvent({
      type: "member.role_changed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: targetId,
      detail: `role: ${target.role} -> ${role}`
    });
    res.json({ member: toPublicAccount(updated) });
  });

  // Remove a member (team.manage). Sessions are revoked so a removed member's existing
  // logins can't keep using org data through a still-valid cookie.
  app.delete("/accounts/members/:id", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const target = accountStore.findById(targetId);
    if (!target || target.orgId !== account.orgId) {
      return res.status(404).json({ error: "member not found" });
    }
    if (!accountStore.removeMember(account.orgId, targetId)) {
      // removeMember refuses the owner — an org must keep its owner.
      return res.status(409).json({ error: "the org owner cannot be removed" });
    }
    sessionStore.revokeAllForAccount(targetId);
    writeSecurityEvent({
      type: "member.removed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: targetId,
      detail: `removed ${target.email}`
    });
    res.status(204).end();
  });

  // Security audit view for the account page — team.manage holders see the whole org's
  // events; every other member sees only events tied to their own account (login history,
  // their own password change, the invite that brought them in, etc.).
  app.get("/accounts/security-events", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const orgId = resolveOrgId(account);
    const canSeeOrg = roleHasPermission(account.role, "team.manage");
    const requested = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 50;
    const events = listSecurityEvents().filter((event) => {
      if (canSeeOrg && event.orgId === orgId) return true;
      return event.actorAccountId === account.id || event.targetAccountId === account.id;
    });
    res.json({ events: events.slice(0, limit) });
  });

  // ── Two-factor authentication (TOTP) ────────────────────────────────────────
  // Enrollment is gated to team.manage (owner + admin) per the Phase 7 scope —
  // the roles whose compromise does the most damage. The LOGIN challenge itself
  // is role-agnostic (it gates whatever account has MFA enabled); this gate only
  // controls who can turn MFA on/off for their own account.

  // Starts enrollment: generates a fresh TOTP secret and stores it as PENDING
  // (no confirmedAt — doesn't gate login yet). The secret is returned once for
  // the user to scan/enter into their authenticator app; re-enrolling after a
  // refresh simply regenerates it.
  app.post("/accounts/mfa/enroll", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const existing = mfaStore.get(account.id);
    if (existing?.confirmedAt) {
      return res.status(409).json({ error: "two-factor authentication is already enabled" });
    }
    const secret = generateTotpSecret();
    mfaStore.put({
      accountId: account.id,
      secret,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    });
    writeSecurityEvent({
      type: "mfa.enrolled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "pending confirmation"
    });
    res.json({ secret, otpauthUrl: otpauthTotpUrl(account.email, secret) });
  });

  // Confirms a pending enrollment with the current TOTP code — the moment the
  // account becomes MFA-protected and login starts requiring the second factor.
  app.post("/accounts/mfa/verify", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const code = req.body?.code;
    if (typeof code !== "string") return res.status(400).json({ error: "code is required" });
    const pending = mfaStore.get(account.id);
    if (!pending || pending.confirmedAt) {
      return res.status(409).json({ error: "no pending two-factor enrollment to confirm" });
    }
    if (!verifyTotpCode(pending.secret, code)) {
      return res.status(401).json({ error: "invalid authentication code" });
    }
    mfaStore.put({ ...pending, confirmedAt: new Date().toISOString() });
    writeSecurityEvent({
      type: "mfa.enabled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ enabled: true });
  });

  // Disables MFA. Requires the account's CURRENT valid TOTP code — proving the
  // person disabling it still holds the authenticator, so a stolen session can't
  // silently strip the second factor off a protected account.
  app.post("/accounts/mfa/disable", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const code = req.body?.code;
    if (typeof code !== "string") return res.status(400).json({ error: "code is required" });
    const mfa = mfaStore.get(account.id);
    if (!mfa?.confirmedAt) return res.status(409).json({ error: "two-factor authentication is not enabled" });
    if (!verifyTotpCode(mfa.secret, code)) {
      return res.status(401).json({ error: "invalid authentication code" });
    }
    mfaStore.remove(account.id);
    writeSecurityEvent({
      type: "mfa.disabled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ enabled: false });
  });

  // ── Data export (GDPR-style access request) ─────────────────────────────────
  // Downloads everything the org has stored as one JSON bundle. Social
  // connection records are metadata-only — the encrypted tokens are intentionally
  // NOT exported (they're credentials, not user data, and exporting decrypted
  // credentials would create a whole second secret-management problem).
  app.get(
    "/accounts/export",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);
      const bundle = {
        generatedAt: new Date().toISOString(),
        orgId,
        account: toPublicAccount(account),
        members: accountStore.listByOrg(orgId).map(toPublicAccount),
        settings: settingsStore.get(orgId),
        clients: clientStore.listByOrg(orgId),
        socialConnections: socialStore.list(orgId),
        plan: planStore.get(orgId),
        usage: aggregateUsage(orgId, VVUGC_RUNS_DIR),
        reviewItems: await listReviewItems({ orgId }),
        jobs: await jobStore.list(orgId),
        securityEvents: listSecurityEvents().filter((event) => event.orgId === orgId)
      };
      res.setHeader("Content-Disposition", `attachment; filename="vvugc-export-${orgId}.json"`);
      res.type("application/json").send(JSON.stringify(bundle, null, 2));
    })
  );

  // ── Account deletion ────────────────────────────────────────────────────────
  // Self-service, confirmed with the password (re-authenticates the person making
  // the request, same posture as the password-change route). A member deletes
  // only their own account; the OWNER deleting their account deletes the entire
  // org — its members, settings, clients, runs, review items, jobs, billing state
  // and audit trail — since an org without its owner is meaningless.
  app.post("/accounts/delete-account", requireSession, accountRateLimiter, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const { confirm, password } = req.body ?? {};
    if (confirm !== "DELETE") {
      return res.status(400).json({ error: 'type "DELETE" to confirm account deletion' });
    }
    if (typeof password !== "string" || !accountStore.authenticate(account.email, password)) {
      writeSecurityEvent({
        type: "account.delete_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req),
        detail: "incorrect password"
      });
      return res.status(403).json({ error: "password is incorrect" });
    }

    const orgId = resolveOrgId(account);
    const isOwner = account.role === "owner";

    // Record the deletion BEFORE wiping data — after this point the event would
    // have nowhere to live.
    writeSecurityEvent({
      type: isOwner ? "org.deleted" : "account.deleted",
      actorAccountId: account.id,
      orgId,
      email: account.email,
      ip: clientIp(req),
      detail: isOwner ? "owner deleted the whole organization" : "member self-removed"
    });

    if (isOwner) {
      const memberIds = accountStore.listByOrg(orgId).map((member) => member.id);
      for (const memberId of memberIds) {
        sessionStore.revokeAllForAccount(memberId);
        mfaStore.remove(memberId);
      }
      accountStore.deleteOrg(orgId);
      inviteStore.deleteOrg(orgId);
      settingsStore.delete(orgId);
      clientStore.deleteOrg(orgId);
      socialStore.deleteOrg(orgId);
      planStore.delete(orgId);
      void jobStore.deleteOrg(orgId);
      void deleteReviewItemsByOrg(orgId);
      deleteSecurityEventsForOrg(orgId);
      purgeOrgRuns(orgId);
    } else {
      accountStore.deleteAccount(account.id);
      sessionStore.revokeAllForAccount(account.id);
      inviteStore.deleteByEmail(account.email);
      mfaStore.remove(account.id);
      deleteSecurityEventsForAccount(account.id);
    }

    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  });

  return { requireSession };
}
