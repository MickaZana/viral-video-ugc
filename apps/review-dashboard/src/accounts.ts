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
  EmailAlreadyRegisteredError,
  toPublicAccount,
  type Account,
  type AgencyClientInput,
  type AccountSettingsInput
} from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import { PlatformSchema, RunConfigSchema } from "@vvugc/shared-schema";
import { runAcceptance, runCycle } from "@vvugc/orchestrator";
import {
  getReviewItem,
  listReviewItems,
  setReviewItemStatus
} from "@vvugc/review-queue";
import { createPlanStore } from "@vvugc/shared-billing";
import { z } from "zod";
import { checkRunQuota } from "./quota.js";
import { createPipelineJobStore } from "./jobs.js";
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
    res.json({ account: toPublicAccount(account), csrfToken: sessionToken ? csrfTokenFor(sessionToken) : undefined });
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
    const account = requireAccount(req, res);
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
    const account = requireAccount(req, res);
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
    const account = requireAccount(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!socialStore.disconnect(resolveOrgId(account), id)) return res.status(404).json({ error: "connection not found" });
    res.status(204).end();
  });

  app.post("/accounts/clients/:clientId/oauth/google/start", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
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
      if (live && account.role !== "owner") return res.status(403).json({ error: "only the org owner can run live acceptance" });
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
    const account = requireAccount(req, res);
    if (!account) return;
    const orgId = resolveOrgId(account);
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : "";
    const client = clientStore.getForOrg(orgId, clientId);
    if (!client || !client.active) return res.status(404).json({ error: "client not found" });
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
    const account = requireAccount(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!await jobStore.cancel(resolveOrgId(account), id)) return res.status(409).json({ error: "job cannot be cancelled" });
    res.status(204).end();
  });

  app.post("/accounts/jobs/:id/replay", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await jobStore.replay(resolveOrgId(account), id);
    if (!job) return res.status(409).json({ error: "only a dead-letter job can be replayed" });
    res.json({ job });
  });

  app.post("/accounts/clients", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const parsed = ClientInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    res.status(201).json({ client: clientStore.create(resolveOrgId(account), parsed.data as AgencyClientInput) });
  });

  app.put("/accounts/clients/:clientId", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
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
    const account = requireAccount(req, res);
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
        const account = requireAccount(req, res);
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
      const account = requireAccount(req, res);
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
      role: account.role
    });
  });

  // Only an owner can invite — a member (already limited to no-invite in the UI) hitting
  // this directly gets a real 403, not just a hidden button.
  app.post("/accounts/invite", requireSession, accountRateLimiter, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    if (account.role !== "owner") {
      return res.status(403).json({ error: "only the org owner can invite teammates" });
    }
    const { email } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }

    const invite = inviteStore.create(resolveOrgId(account), email, account.id);
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
      account = accountStore.signUpAsMember(invite.email, password, invite.orgId);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
    inviteStore.consume(token);

    const session = sessionStore.create(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    res.status(201).json({ account: toPublicAccount(account) });
  });

  return { requireSession };
}
