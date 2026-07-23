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
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { listRuns } from "./runs.js";
import { renderDashboardPage } from "./render.js";
import { createBasicAuthMiddleware, resolveCredentials } from "./auth.js";
import { registerAccountRoutes } from "./accounts.js";
import { renderAccountPage } from "./account-page.js";
import { registerBillingRoutes, registerStripeWebhookRoute } from "./billing.js";
import { createPublicAssetUrl, registerPublicAssetRoute } from "./public-assets.js";
import { runDueClientSchedules, startClientScheduler } from "./scheduler.js";
import { createPipelineJobStore, startPipelineJobWorker } from "./jobs.js";
import { createSocialConnectionStore } from "@vvugc/shared-auth";
import { refreshGoogleAccessToken } from "./google-oauth.js";
import { resolveSocialTokenEncryptionKey } from "./social-token-key.js";

const require = createRequire(import.meta.url);
const logger = pino({ name: "vvugc-review-dashboard" });
const startedAt = Date.now();
const credentials = resolveCredentials(logger);
const { metricsMiddleware, metricsHandler } = createAppMetrics("review-dashboard");

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

app.use((req: Request & { scriptNonce?: string }, res, next) => {
  const scriptNonce = randomBytes(18).toString("base64");
  req.scriptNonce = scriptNonce;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${scriptNonce}'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`);
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
  res.json({ status: "ok", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
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
const { requireSession } = registerAccountRoutes(app);
registerBillingRoutes(app, requireSession);

// The self-service account page — public (session-cookie auth handled client-side),
// deliberately reachable without the operator Basic Auth below, same reasoning as
// the /accounts/* API routes it talks to. /account/join is the same page (its
// client-side JS reads ?token= to switch into invite-accept mode — see
// account-page.ts) under the exact URL account-page.ts's own invite flow hands
// the owner to send a teammate; without this second route it fell through past
// /account to the operator Basic Auth gate below and 401'd for every invited
// teammate, the same failure mode /tokens.css had before it was moved up here.
app.get(["/account", "/account/join"], (req: Request & { scriptNonce?: string }, res) => {
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

// Everything past this point approves/rejects content before it ships, or reveals
// its details (scripts, video paths, run history) — not safe to leave open.
app.use(authRateLimiter);
app.use(createBasicAuthMiddleware(credentials));

app.post(
  "/scheduler/run-due",
  asyncHandler(async (_req, res) => {
    res.json(await runDueClientSchedules());
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
    res.json(
      await listReviewItems({ status: statusParsed?.data, niche, platform: platformParsed?.data })
    );
  })
);

app.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const items = await listReviewItems();
    const pending = items.filter((i) => i.status === "pending").length;
    const approved = items.filter((i) => i.status === "approved").length;
    const rejected = items.filter((i) => i.status === "rejected").length;
    const estimatedCostUsd = listRuns().reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
    res.json({ pending, approved, rejected, estimatedCostUsd });
  })
);

app.get("/runs", (_req, res) => {
  res.json(listRuns());
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
    res.json({ updated: await setReviewItemsStatus(parsed.data.ids, "approved") });
  })
);

app.post(
  "/queue/bulk/reject",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "ids must contain 1–100 valid item identifiers" });
    res.json({ updated: await setReviewItemsStatus(parsed.data.ids, "rejected") });
  })
);

app.get(
  "/queue/:id",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  })
);

app.post(
  "/queue/:id/approve",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    await setReviewItemStatus(req.params.id, "approved");
    res.json({ ...item, status: "approved" });
  })
);

app.post(
  "/queue/:id/reject",
  asyncHandler<{ id: string }>(async (req, res) => {
    const item = await getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    await setReviewItemStatus(req.params.id, "rejected");
    res.json({ ...item, status: "rejected" });
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
        dryRun: Boolean(req.body?.dryRun),
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
        { videoVendor, dryRun: Boolean(req.body?.dryRun), outDir: regenerateWorkDir(item.runId) }
      );
      await replaceReviewItem(regenerated);
      res.json(regenerated);
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
    if (item.status !== "approved") {
      return res.status(409).json({ error: `item must be approved before publishing (current status: ${item.status})` });
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

app.get("/", (req: Request & { scriptNonce?: string }, res) => {
  res.type("html").send(renderDashboardPage(req.scriptNonce));
});

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
  const server = app.listen(port, () => {
    logger.info({ port }, "review dashboard listening");
  });
  startClientScheduler(Number(process.env.CLIENT_SCHEDULER_INTERVAL_MS ?? 60_000));
  startPipelineJobWorker(
    createPipelineJobStore(join(loadEnv().VVUGC_RUNS_DIR, "pipeline-jobs.json")),
    Number(process.env.PIPELINE_JOB_INTERVAL_MS ?? 1_000)
  );
  installLifecycleHandlers(server, logger);
}
