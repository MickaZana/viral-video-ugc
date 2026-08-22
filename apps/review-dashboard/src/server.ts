import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createAppMetrics, installLifecycleHandlers, reportError, requestIdMiddleware } from "@vvugc/shared-metrics";
import { loadEnv, validateProductionEnv } from "@vvugc/shared-config";
import { PlatformSchema, ReviewItemStatusSchema } from "@vvugc/shared-schema";
import {
  listReviewItems,
  getReviewItem,
  setReviewItemStatus,
  setReviewItemsStatus,
  replaceReviewItem
} from "@vvugc/review-queue";
import { regenerateScene, regenerateScript } from "@vvugc/orchestrator";
import { getPublishAdapter } from "@vvugc/mcp-publish";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { join, resolve, sep } from "node:path";
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { listRuns } from "./runs.js";
import { listTrackedCreators } from "./creators.js";
import { createBasicAuthMiddleware, resolveCredentials } from "./auth.js";
import { registerAccountRoutes } from "./accounts.js";
import { renderAccountPage } from "./account-page.js";
import { registerBillingRoutes, registerStripeWebhookRoute } from "./billing.js";
// import { registerBatchRoutes } from "./batch-routes.js";
// import { registerSoulIdRoutes } from "./soul-id-routes.js";
import { createPublicAssetUrl, registerPublicAssetRoute } from "./public-assets.js";
import { runDueClientSchedules, startClientScheduler } from "./scheduler.js";
import { createPipelineJobStore, startPipelineJobWorker } from "./jobs.js";
import { DEMO_PREVIEW_STATS, DEMO_PREVIEW_CREATORS, DEMO_PREVIEW_RUNS, DEMO_PREVIEW_QUEUE } from "./demo-preview-data.js";
import { getAuthContext, getOrgId, type AuthedRequest } from "./auth-context.js";
import { pruneRetainedLogs } from "./retention.js";
import { MODEL_CATALOG, groupModelsByResult } from "./models.js";
import { createAccountStore, createSocialConnectionStore, resolveOrgId } from "@vvugc/shared-auth";
import { refreshGoogleAccessToken } from "./google-oauth.js";
import { resolveSocialTokenEncryptionKey } from "./social-token-key.js";
import { isLLMLive } from "./llm-gate.js";

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const logger = pino({ name: "vvugc-review-dashboard" });
const startedAt = Date.now();
const credentials = resolveCredentials(logger);
const { metricsMiddleware, metricsHandler } = createAppMetrics("review-dashboard");

// --- C-1 Tenant Isolation Infrastructure ---
const operatorAccountStore = createAccountStore(join(loadEnv().VVUGC_RUNS_DIR, "accounts.json"));

/**
 * Resolves the calling user's orgId for tenant scoping.
 * - Session-authenticated (control-panel SPA): returns their org's ID
 * - Operator (Basic Auth): returns undefined (cross-org visibility intentional)
 */
function resolveRequestOrg(req: Request & { accountId?: string }): string | undefined {
  if (!req.accountId) return undefined;
  const account = operatorAccountStore.findById(req.accountId);
  if (!account) return undefined;
  return resolveOrgId(account);
}

const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

async function clientPublishAccessToken(item: { orgId?: string; clientId?: string; platform: string }): Promise<string | undefined> {
  if (!item.orgId || !item.clientId) return undefined;
  const env = loadEnv();
  const encryptionKey = resolveSocialTokenEncryptionKey();
  const store = createSocialConnectionStore(join(env.VVUGC_RUNS_DIR, "social-connections.json"), encryptionKey);
  const connection = store.list(item.orgId, item.clientId).find((entry) => entry.platform === item.platform);
  if (!connection) throw new Error(`Connect the client's ${item.platform} account before publishing`);
  const secrets = store.getSecrets(item.orgId, connection.id);
  if (!secrets) throw new Error("The client's publishing credentials could not be decrypted");

  if (item.platform !== "youtube_shorts" || connection.status !== "expired") return secrets.accessToken;
  if (!secrets.refreshToken) throw new Error("The client's YouTube authorization expired; reconnect YouTube");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required to refresh YouTube authorization");
  }
  const refreshed = await refreshGoogleAccessToken({
    refreshToken: secrets.refreshToken,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET
  });
  store.connect(item.orgId, {
    clientId: item.clientId,
    platform: "youtube_shorts",
    accountLabel: connection.accountLabel,
    providerAccountId: connection.providerAccountId,
    accessToken: refreshed.accessToken,
    refreshToken: secrets.refreshToken,
    expiresAt: refreshed.expiresAt
  });
  return refreshed.accessToken;
}

export const app: Express = express();
// See TRUST_PROXY_HOPS in @vvugc/shared-config — without this, req.ip (and so the
// failed-login rate limiter below, which keys on it) reads the wrong address for
// every request once this sits behind any reverse proxy/load balancer.
const { TRUST_PROXY_HOPS } = loadEnv();
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);

// Must be registered before express.json() below — Stripe's webhook signature check
// needs the raw request body, which express.json() would otherwise already have
// consumed and replaced with a parsed object by the time any route handler runs.
registerStripeWebhookRoute(app);

app.use(express.json({ limit: "1mb" }));

// The control-panel SPA (served from this same origin below, so its session-cookie
// auth works without CORS) calls /api/* in dev and prod alike. Strip the prefix so
// those requests reach the real route paths (/api/queue -> /queue, /api/accounts/login
// -> /accounts/login). No-op for every non-/api request.
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/") || req.url === "/api") {
    req.url = req.url.replace(/^\/api/, "") || "/";
  }
  next();
});

app.use((req: Request & { scriptNonce?: string }, res, next) => {
  const scriptNonce = randomBytes(18).toString("base64");
  req.scriptNonce = scriptNonce;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'nonce-${scriptNonce}'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`);
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// Browser mutations carrying the session cookie must be same-origin. Non-browser
// API clients generally omit Origin and authenticate separately; an explicitly
// cross-origin browser request is rejected before it reaches any state change.
app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "cross-origin mutation rejected" });
  } catch {
    return res.status(403).json({ error: "invalid origin" });
  }
  next();
});

app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  res.on("finish", () => {
    const { VVUGC_RUNS_DIR } = loadEnv();
    mkdirSync(VVUGC_RUNS_DIR, { recursive: true });
    appendFileSync(
      join(VVUGC_RUNS_DIR, "audit.ndjson"),
      JSON.stringify({
        at: new Date().toISOString(),
        requestId: (req as Request & { id?: string }).id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ip: req.ip,
        actor: (req as Request & { auditActor?: string }).auditActor ?? "anonymous"
      }) + "\n"
    );
  });
  next();
});
app.use(requestIdMiddleware);
app.use(metricsMiddleware);

// Express 5 forwards a rejected async-handler promise to error-handling
// middleware on its own, so this is redundant-but-harmless now — kept explicit
// (rather than relying on the framework default) for the Postgres-backed
// review-queue store (postgres-store.ts), whose calls are real network I/O
// and can reject (e.g. connection dropped).
function asyncHandler<P = Record<string, string>>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

app.use((req: Request & { id?: string }, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info(
      { requestId: req.id, method: req.method, path: req.path, statusCode: res.statusCode, durationMs: Date.now() - start },
      "request handled"
    );
  });
  next();
});

// Liveness/readiness probe for container orchestrators — deliberately does not
// touch the review-queue JSON store, and stays unauthenticated, so a slow/locked
// file or missing credentials don't fail the probe. Registered before the auth
// middleware below on purpose — every other route requires it.
app.get("/healthz", (_req, res) => {
  const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  // Deep health check: verify database/store connectivity, not just process liveness.
  // listReviewItems is always async (supports Postgres + JSON-file backends).
  listReviewItems("pending")
    .then(() => res.json({ status: "ok", uptimeSeconds, db: "connected" }))
    .catch(() => res.status(503).json({ status: "degraded", uptimeSeconds, db: "unreachable" }));
});

// P1: Readiness probe — verifies all dependencies required for serving traffic.
// Separate from /healthz (liveness) so orchestrators can distinguish "process alive
// but not ready" from "process dead". /healthz = cheap liveness, /readyz = deep check.
app.get("/readyz", async (_req, res) => {
  try {
    await listReviewItems({ status: "pending" });
    const { VVUGC_RUNS_DIR } = loadEnv();
    const runsOk = existsSync(VVUGC_RUNS_DIR);
    if (!runsOk) throw new Error("VVUGC_RUNS_DIR not accessible");
    res.json({ status: "ready", db: "connected", storage: "accessible" });
  } catch (err) {
    res.status(503).json({ status: "not_ready", error: err instanceof Error ? err.message : "unknown" });
  }
});

// Prometheus scrape target — aggregate operational data (request counts/timings,
// process stats), not content, and unauthenticated to match the standard
// Prometheus/Kubernetes convention (see @vvugc/shared-metrics). Registered
// before the auth middleware below for the same reason /healthz is.
app.get("/metrics", metricsHandler);

// Basic Auth's timing-safe comparison (auth.ts) stops a timing attack, but does nothing
// to stop brute force at network speed — an attacker can still try thousands of passwords
// a minute. This slows repeated *failed* logins per-IP without limiting a legitimate,
// already-authenticated admin clicking around (skipSuccessfulRequests: true means only
// 401s count against the limit).
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many failed login attempts — try again later" }
});

// Account signup/login/logout are public endpoints (session-cookie-authenticated,
// not Basic-Auth-protected) — registered before the Basic Auth gate below so
// they stay reachable. /accounts/me and /accounts/usage guard themselves via
// requireSession (see accounts.ts). This is a separate, additive auth surface
// from the dashboard's own operator Basic Auth; neither one weakens the other.
const { requireSession, verifySessionRequest } = registerAccountRoutes(app, { logger });
registerBillingRoutes(app, requireSession);
// registerBatchRoutes(app, requireSession);
// Soul ID: identity training and status endpoints
// Uses a lightweight in-memory creator store adapter for now (same pattern as batch routes)
// registerSoulIdRoutes(app, { get: () => undefined, update: () => undefined } as any, requireSession);

// The self-service account page — public (session-cookie auth handled client-side),
// deliberately reachable without the operator Basic Auth below, same reasoning as
// the /accounts/* API routes it talks to. /account/join is the same page (its
// client-side JS reads ?token= to switch into invite-accept mode — see
// account-page.ts) under the exact URL account-page.ts's own invite flow hands
// the owner to send a teammate; without this second route it fell through past
// /account to the operator Basic Auth gate below and 401'd for every invited
// teammate, the same failure mode /tokens.css had before it was moved up here.
// /account used to be the HTML self-service page. The product workspace is the
// SPA now — bounce there. /account/join stays as the invite-accept page.
app.get("/account", (_req, res) => {
  res.redirect(302, "/app");
});
app.get(["/dashboard", "/account/join"], (req: Request & { scriptNonce?: string }, res) => {
  res.type("html").send(renderAccountPage(req.scriptNonce));
});

// Serves a single, signed, time-limited video URL per request — see
// public-assets.ts for why this needs to be reachable without the operator
// Basic Auth below (Instagram's Content Publishing API fetches it directly).
registerPublicAssetRoute(app);

// Registered here (public, no Basic Auth) rather than after the auth gate below —
// /account links to this and is itself public, so gating the stylesheet behind
// operator credentials silently broke it for every non-operator visitor: the
// <link> tag would 401, the browser drops the failed stylesheet with no visible
// error, and the page renders in unstyled default HTML. It's just CSS, nothing
// sensitive, so there's no reason it needs to be behind Basic Auth at all.
app.get("/tokens.css", (_req, res) => {
  res.type("css").sendFile(require.resolve("@vvugc/design-tokens"));
});

app.get(["/favicon.png", "/favicon.ico", "/logo.png"], (_req, res) => {
  const publicDir = resolve(__dirname, "../public");
  const fallback = resolve(publicDir, "logo.png");
  if (existsSync(fallback)) {
    res.type("png").sendFile(fallback);
  } else {
    res.status(404).end();
  }
});

// Read-only public preview endpoints for the marketing landing page's "live
// preview" frame (control-panel's Landing.tsx). They mirror the same data the
// authenticated tabs render, but deliberately expose only non-sensitive
// aggregates (stats, tracked creators, run summaries) plus a bounded slice of
// the review queue (scripts/scores/flags only — no raw transcripts or video
// paths). They're registered here, BEFORE the auth gate, so anonymous visitors
// can click around the landing page's preview; they return nothing a caller
// couldn't already see summarized in the marketing copy.
app.get(
  "/preview/stats",
  (_req, res) => {
    // P0: Public preview uses static synthetic data — never real customer data
    res.json(DEMO_PREVIEW_STATS);
  }
);

app.get("/preview/creators", (_req, res) => {
  // P0: Public preview uses static synthetic data — never real customer data
  res.json(DEMO_PREVIEW_CREATORS);
});

app.get("/preview/runs", (_req, res) => {
  // P0: Public preview uses static synthetic data — never real customer data
  res.json(DEMO_PREVIEW_RUNS);
});

app.get(
  "/preview/queue",
  (_req, res) => {
    // P0: Public preview uses static synthetic data — never real customer data
    res.json(DEMO_PREVIEW_QUEUE);
  }
);

// The control-panel SPA — the product workspace / landing (see the
// front-end). Served from this same origin so its session-cookie auth and CSRF
// protection work exactly as they do in dev (Vite proxies /api to this backend).
// Mounted at /app. Guests see sign-in; authenticated / redirects to /app/review. The hashed Vite assets are served at /assets. Optional —
// if the SPA hasn't been built in this checkout, /app simply 404s and the
// dashboard's own operator UI is unaffected.
const CONTROL_PANEL_DIST = fileURLToPath(new URL("../../control-panel/dist/", import.meta.url));
if (existsSync(CONTROL_PANEL_DIST)) {
  app.use("/assets", express.static(join(CONTROL_PANEL_DIST, "assets")));
  const spaIndex = join(CONTROL_PANEL_DIST, "index.html");
  const serveControlPanel = (_req: Request, res: Response) => {
    res.type("html").sendFile(spaIndex);
  };
  // Prefix mount = SPA fallback: /app and every /app/<anything> path return the
  // same index.html (the client is a single-page app; its hashed assets live
  // under /assets, not /app). Express 5's path-to-regexp no longer allows a bare
  // "*" wildcard, so a prefix-mount middleware is the correct shape here.
  app.use("/app", serveControlPanel);
}

// Product home is the SPA. Session -> review queue; guests -> sign-in.
// Registered before the operator Basic Auth gate so unauthenticated / is a
// 302, not a 401 challenge. Nested /app/* already SPA-fallbacks above.
app.get("/", (req, res) => {
  const session = verifySessionRequest(req);
  if (session) return res.redirect(302, "/app/review");
  return res.redirect(302, "/app");
});

// Everything past this point approves/rejects content before it ships, or reveals
// its details (scripts, video paths, run history) — not safe to leave open.
// Two valid ways to get past this gate:
//   1. a valid account session cookie (the control-panel SPA logs in via /accounts/*)
//   2. the operator's Basic Auth (DASHBOARD_USERNAME/DASHBOARD_PASSWORD)
// A request that carries neither is rejected. This is what lets the control-panel
// reach the data endpoints with a real user login rather than only operator creds.
app.use(authRateLimiter);
app.use((req: Request & { accountId?: string; auditActor?: string }, res: Response, next: NextFunction) => {
  const session = verifySessionRequest(req);
  if (session) {
    req.accountId = session.accountId;
    req.auditActor = `account:${session.accountId}`;
    return next();
  }
  return createBasicAuthMiddleware(credentials)(req, res, next);
});

app.post(
  "/scheduler/run-due",
  asyncHandler(async (req: Request & { accountId?: string }, res) => {
    // H-3 FIX: Session users can only trigger their own org's schedules
    const orgId = resolveRequestOrg(req);
    res.json(await runDueClientSchedules(orgId));
  })
);

app.get(
  "/queue",
  asyncHandler(async (req, res) => {
    const statusParsed = req.query.status ? ReviewItemStatusSchema.safeParse(req.query.status) : undefined;
    if (statusParsed && !statusParsed.success) {
      return res.status(400).json({
        error: `invalid "status" query param — expected one of: ${ReviewItemStatusSchema.options.join(", ")}`
      });
    }

    const platformParsed = req.query.platform ? PlatformSchema.safeParse(req.query.platform) : undefined;
    if (platformParsed && !platformParsed.success) {
      return res.status(400).json({
        error: `invalid "platform" query param — expected one of: ${PlatformSchema.options.join(", ")}`
      });
    }

    const niche = typeof req.query.niche === "string" && req.query.niche ? req.query.niche : undefined;
    const dryRunRaw = req.query.dryRun;
    const dryRun =
      dryRunRaw === "true" ? true : dryRunRaw === "false" ? false : undefined;

    // Batch-metadata filters (Atom E: Review Grouping) — applied in-memory
    // after the store query since ReviewItemFilter doesn't include these yet.
    const batchIdFilter = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    const productProfileIdFilter = typeof req.query.productProfileId === "string" ? req.query.productProfileId : undefined;
    const creatorProfileIdFilter = typeof req.query.creatorProfileId === "string" ? req.query.creatorProfileId : undefined;
    const templateIdFilter = typeof req.query.templateId === "string" ? req.query.templateId : undefined;

    // C-1: Tenant isolation
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });

    // C-2: Pagination
    const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    let items = await listReviewItems({ status: statusParsed?.data, niche, platform: platformParsed?.data, dryRun, orgId });

    if (batchIdFilter || productProfileIdFilter || creatorProfileIdFilter || templateIdFilter) {
      items = items.filter((item) => {
        const meta = item as Record<string, unknown>;
        if (batchIdFilter && meta.batchId !== batchIdFilter) return false;
        if (productProfileIdFilter && meta.productProfileId !== productProfileIdFilter) return false;
        if (creatorProfileIdFilter && meta.creatorProfileId !== creatorProfileIdFilter) return false;
        if (templateIdFilter && meta.templateId !== templateIdFilter) return false;
        return true;
      });
    }

    // C-2: Paginate after in-memory filters
    const page = items.slice(offset, offset + limit + 1);
    const hasMore = page.length > limit;
    res.json({ items: page.slice(0, limit), hasMore, total: items.length });
  })
);

app.get(
  "/stats",
  asyncHandler(async (req, res) => {
    // P0: Tenant-scoped stats — both review items AND runs are filtered by org
    const orgId = resolveRequestOrg(req as AuthedRequest);
    const items = await listReviewItems(orgId ? { orgId } : undefined);
    const pending = items.filter((i) => i.status === "pending").length;
    const approved = items.filter((i) => i.status === "approved").length;
    const rejected = items.filter((i) => i.status === "rejected").length;
    // P0 FIX: estimatedCostUsd was previously calculated across ALL tenants' runs
    const estimatedCostUsd = listRuns(orgId).reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    // Surfaced so the control-panel can disable live-only actions (publish,
    // regenerate-live) when this dashboard is running in mock mode.
    res.json({ pending, approved, rejected, estimatedCostUsd, isLLMLive: isLLMLive() });
  })
);

app.get("/runs", (req, res) => {
  // P0: Tenant-scoped — session users only see their org's runs
  const orgId = resolveRequestOrg(req as AuthedRequest);
  res.json(listRuns(orgId));
});

// Model catalog for the Video Generator / model-choice flow: every model the
// pipeline can invoke, grouped by desired result, with its per-consumption USD
// price. Registered after the auth gate (it's not sensitive, but it belongs to
// the logged-in app). The UI uses this to let a user pick a model based on the
// result they want and show the estimated cost before running.
app.get("/models", (_req, res) => {
  res.json({ models: MODEL_CATALOG, grouped: groupModelsByResult() });
});

// Control-panel connection: tracked creators derived from real run manifests.
// Registered after the Basic Auth gate (same as /queue and /runs) so this is
// never exposed unauthenticated — the SPA sends the same operator credentials.
app.get("/creators", (req, res) => {
  // P0: Tenant-scoped — session users only see creators from their org's runs
  const orgId = resolveRequestOrg(req as AuthedRequest);
  res.json({ creators: listTrackedCreators(orgId) });
});

// Bulk routes must be registered before the "/queue/:id/..." routes below — Express
// matches route patterns in registration order, and ":id" would otherwise greedily
// match the literal segment "bulk" (i.e. POST /queue/bulk/approve would 404 by hitting
// "/queue/:id/approve" with id="bulk" first). Found by an actual request during manual
// testing, not by the test suite alone — the route-order mistake produced a 404, not a
// type error, so nothing caught it until something actually hit the endpoint.
app.post(
  "/queue/bulk/approve",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "ids must contain 1–100 valid item identifiers" });
    // C-1: Tenant isolation on bulk operations
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    let ids = parsed.data.ids;
    if (orgId) {
      const ownItems = await Promise.all(ids.map((id) => getReviewItem(id)));
      ids = ids.filter((_, i) => ownItems[i]?.orgId === orgId);
    }
    res.json({ updated: await setReviewItemsStatus(ids, "approved") });
  })
);

app.post(
  "/queue/bulk/reject",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "ids must contain 1–100 valid item identifiers" });
    // C-1: Tenant isolation on bulk operations
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    let ids = parsed.data.ids;
    if (orgId) {
      const ownItems = await Promise.all(ids.map((id) => getReviewItem(id)));
      ids = ids.filter((_, i) => ownItems[i]?.orgId === orgId);
    }
    res.json({ updated: await setReviewItemsStatus(ids, "rejected") });
  })
);

app.get(
  "/queue/:id",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    // C-1: Tenant isolation
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    res.json(item);
  })
);

// Video playback for the control-panel History tab — an authenticated endpoint
// (registered after the auth gate above) that streams a finished video file for
// a review item. This is deliberately NOT the /public/assets/:token route:
// that one is an unauthenticated, signed, single-use URL for vendor fetches
// (Meta's Content Publishing API), whereas this one serves the video only to a
// logged-in caller of this dashboard. Same hardening as public-assets.ts —
// only files under VVUGC_RUNS_DIR are ever served, and anything that fails
// validation (unknown item, empty path, traversal, missing file) gets an
// indistinguishable 404 rather than an error that confirms why it failed.
app.get(
  "/media/:itemId",
  asyncHandler<{ itemId: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.itemId);
    if (!item || typeof item.videoPath !== "string" || !item.videoPath) {
      return res.status(404).json({ error: "not found" });
    }
    // C-1: Tenant isolation (placed after null guard)
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    // realpathSync resolves symlinks, preventing symlink-based traversal attacks
    const absPath = existsSync(resolve(item.videoPath)) ? realpathSync(resolve(item.videoPath)) : resolve(item.videoPath);
    const runsRoot = resolve(loadEnv().VVUGC_RUNS_DIR);
    if (absPath !== runsRoot && !absPath.startsWith(runsRoot + sep)) {
      return res.status(404).json({ error: "not found" });
    }
    if (!existsSync(absPath)) {
      return res.status(404).json({ error: "not found" });
    }
    const stat = statSync(absPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.sendFile(absPath, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  })
);

app.post(
  "/queue/:id/approve",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    await setReviewItemStatus(req.params.id, "approved");
    res.json({ ...item, status: "approved" });
  })
);

app.post(
  "/queue/:id/reject",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    await setReviewItemStatus(req.params.id, "rejected");
    res.json({ ...item, status: "rejected" });
  })
);

// Send back: undo an approve/reject decision — returns item to "pending" so
// the reviewer can reconsider. Cannot undo a published item (that's shipped).
app.post(
  "/queue/:id/send-back",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    if (item.publishedPostId) return res.status(409).json({ error: "cannot undo — item is already published" });
    if (item.status === "pending") return res.json(item); // Already pending, no-op
    await setReviewItemStatus(req.params.id, "pending");
    res.json({ ...item, status: "pending" });
  })
);

// Regenerating a scene or a whole script is a real (paid, for live video-gen vendors)
// vendor call, not a cheap operation — this deliberately does not run inside the bulk
// approve/reject rate limiter's "skip successful" carve-out; every regeneration attempt
// counts, successful or not.
const regenerateRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many regeneration requests — try again later" }
});

/** Work directory for a regeneration's new clip(s)/assembly output — kept under the
 *  same run's directory as everything else that run produced, not a fresh temp dir,
 *  so a regenerated video sits alongside the run it came from for debugging. */
function regenerateWorkDir(runId: string): string {
  return join(loadEnv().VVUGC_RUNS_DIR, runId, "regenerate", randomUUID());
}

app.post(
  "/queue/:id/regenerate-scene",
  regenerateRateLimiter,
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });

    const sceneIndex = Number(req.body?.sceneIndex);
    if (!Number.isInteger(sceneIndex)) {
      return res.status(400).json({ error: "sceneIndex (integer) is required" });
    }
    const videoVendor = req.body?.videoVendor ?? item.clips?.[0]?.vendor;
    if (!videoVendor) {
      return res.status(400).json({ error: "videoVendor is required (item has no stored clips to infer it from)" });
    }

    try {
      const regenerated = await regenerateScene(item, sceneIndex, {
        videoVendor,
        // Regeneration stays in mock mode unless real LLM spend is explicitly
        // enabled (VVUGC_LLM_LIVE=true); otherwise it is always a dry-run.
        dryRun: Boolean(req.body?.dryRun) || !isLLMLive(),
        outDir: regenerateWorkDir(item.runId)
      });
      await replaceReviewItem(regenerated);
      res.json(regenerated);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

app.post(
  "/queue/:id/regenerate-script",
  regenerateRateLimiter,
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });

    const { hook, points, cta } = req.body ?? {};
    if (typeof hook !== "string" || !Array.isArray(points) || typeof cta !== "string") {
      return res.status(400).json({ error: "hook (string), points (string[]), and cta (string) are required" });
    }
    const videoVendor = req.body?.videoVendor ?? item.clips?.[0]?.vendor;
    if (!videoVendor) {
      return res.status(400).json({ error: "videoVendor is required (item has no stored clips to infer it from)" });
    }

    try {
      const regenerated = await regenerateScript(
        item,
        { hook, points, cta },
        { videoVendor, dryRun: Boolean(req.body?.dryRun) || !isLLMLive(), outDir: regenerateWorkDir(item.runId) }
      );
      await replaceReviewItem(regenerated);
      res.json(regenerated);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

// Promote a dry-run (mock) item to a real, publishable render. Forces a live
// render regardless of the server's LLM mode — this is the explicit "make the
// mock real" action. After a successful render the item's dryRun flag is flipped
// to false so the publish route will accept it.
app.post(
  "/queue/:id/regenerate-live",
  regenerateRateLimiter,
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    if (!item.dryRun) {
      return res.status(409).json({ error: "item is already a live (real) render — nothing to promote" });
    }
    const videoVendor = req.body?.videoVendor ?? item.clips?.[0]?.vendor;
    if (!videoVendor) {
      return res.status(400).json({ error: "videoVendor is required (item has no stored clips to infer it from)" });
    }
    try {
      const regenerated = await regenerateScript(
        item,
        { hook: item.script.hook, points: item.script.points, cta: item.script.cta },
        { videoVendor, dryRun: false, outDir: regenerateWorkDir(item.runId) }
      );
      // regenerateScript spreads the original item, so dryRun would survive as true —
      // flip it off explicitly since this render is real.
      const promoted = { ...regenerated, dryRun: false };
      await replaceReviewItem(promoted);
      res.json(promoted);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);

// Publishing is only ever reachable from here — nowhere in conductor.ts calls
// mcp-publish. Gated on status === "approved" so this can't be used to post
// something a human hasn't signed off on, and can't double-post an item that's
// already been published.
app.post(
  "/queue/:id/publish",
  regenerateRateLimiter, // real vendor calls, same "every attempt counts" reasoning as regeneration
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const orgId = resolveRequestOrg(req as Request & { accountId?: string });
    if (orgId && item.orgId && item.orgId !== orgId) return res.status(404).json({ error: "not found" });
    if (item.status !== "approved") {
      return res.status(409).json({ error: `item must be approved before publishing (current status: ${item.status})` });
    }
    if (item.dryRun) {
      return res.status(409).json({
        error: "this is a dry-run (mock) item — it has no real asset to publish. Regenerate it live (VVUGC_LLM_LIVE=true) first."
      });
    }
    if (item.publishedPostId) {
      return res.status(409).json({ error: `item was already published (postId: ${item.publishedPostId})` });
    }

    try {
      const accessToken = await clientPublishAccessToken(item);
      const adapter = getPublishAdapter(item.platform, { accessToken });
      const caption = [item.script.hook, ...item.script.points, item.script.cta].join(" ");
      // Only Instagram Reels needs a publicly fetchable URL — computed lazily so
      // publishing to every other platform still works without PUBLIC_BASE_URL set.
      const publicVideoUrl =
        item.platform === "instagram_reels" ? createPublicAssetUrl(item.videoPath).url : undefined;
      const result = await adapter.publish({ videoPath: item.videoPath, caption, publicVideoUrl });

      const published = {
        ...item,
        publishedPostId: result.postId,
        publishedUrl: result.url,
        publishedAt: new Date().toISOString()
      };
      await replaceReviewItem(published);
      res.json(published);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })
);



// Error-handling middleware — must have exactly 4 params for Express to
// recognize it as such. Catches rejections forwarded by asyncHandler.
app.use((err: unknown, req: Request & { id?: string }, res: Response, _next: NextFunction) => {
  reportError(err, { requestId: req.id, method: req.method, path: req.path }, {
    service: "review-dashboard",
    errorFile: join(loadEnv().VVUGC_RUNS_DIR, "errors.ndjson"),
    log: (record, message) => logger.error(record, message)
  });
  res.status(500).json({ error: "internal error" });
});

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.env.NODE_ENV === "production") validateProductionEnv();
  const port = Number(process.env.PORT ?? 4310);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = app.listen(port, host, () => {
    logger.info({ host, port }, "review dashboard listening");
  });
  startClientScheduler(Number(process.env.CLIENT_SCHEDULER_INTERVAL_MS ?? 60_000));
  startPipelineJobWorker(
    createPipelineJobStore(join(loadEnv().VVUGC_RUNS_DIR, "pipeline-jobs.json")),
    Number(process.env.PIPELINE_JOB_INTERVAL_MS ?? 1_000)
  );
  // Prune the append-only audit/security-event logs once at boot and then daily —
  // bounded retention (SECURITY_LOG_RETENTION_DAYS) keeps these files from growing
  // without limit on a long-lived service.
  try {
    pruneRetainedLogs();
  } catch (err) {
    logger.error({ err }, "retention prune at startup failed");
  }
  setInterval(() => {
    try {
      pruneRetainedLogs();
    } catch (err) {
      logger.error({ err }, "retention prune failed");
    }
  }, 24 * 60 * 60 * 1000).unref();
  installLifecycleHandlers(server, logger);
}
