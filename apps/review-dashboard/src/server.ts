import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createAppMetrics, installLifecycleHandlers, requestIdMiddleware } from "@vvugc/shared-metrics";
import { loadEnv } from "@vvugc/shared-config";
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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { listRuns } from "./runs.js";
import { renderDashboardPage } from "./render.js";
import { createBasicAuthMiddleware, resolveCredentials } from "./auth.js";
import { registerAccountRoutes } from "./accounts.js";

const require = createRequire(import.meta.url);
const logger = pino({ name: "vvugc-review-dashboard" });
const startedAt = Date.now();
const credentials = resolveCredentials(logger);
const { metricsMiddleware, metricsHandler } = createAppMetrics("review-dashboard");

export const app: Express = express();
// See TRUST_PROXY_HOPS in @vvugc/shared-config — without this, req.ip (and so the
// failed-login rate limiter below, which keys on it) reads the wrong address for
// every request once this sits behind any reverse proxy/load balancer.
const { TRUST_PROXY_HOPS } = loadEnv();
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);
app.use(express.json());
app.use(requestIdMiddleware);
app.use(metricsMiddleware);

// Express 4 (unlike 5) does not forward a rejected promise from an async
// handler to error-handling middleware on its own — an unhandled rejection
// there would otherwise hang the request instead of returning a response.
// Now load-bearing for the Postgres-backed review-queue store (postgres-store.ts),
// whose calls are real network I/O and can reject (e.g. connection dropped).
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
registerAccountRoutes(app);

// Everything past this point approves/rejects content before it ships, or reveals
// its details (scripts, video paths, run history) — not safe to leave open.
app.use(authRateLimiter);
app.use(createBasicAuthMiddleware(credentials));

app.get("/tokens.css", (_req, res) => {
  res.type("css").sendFile(require.resolve("@vvugc/design-tokens"));
});

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
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    res.json({ updated: await setReviewItemsStatus(ids, "approved") });
  })
);

app.post(
  "/queue/bulk/reject",
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    res.json({ updated: await setReviewItemsStatus(ids, "rejected") });
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
      const adapter = getPublishAdapter(item.platform);
      const caption = [item.script.hook, ...item.script.points, item.script.cta].join(" ");
      const result = await adapter.publish({ videoPath: item.videoPath, caption });

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

app.get("/", (_req, res) => {
  res.type("html").send(renderDashboardPage());
});

// Error-handling middleware — must have exactly 4 params for Express to
// recognize it as such. Catches rejections forwarded by asyncHandler.
app.use((err: unknown, req: Request & { id?: string }, res: Response, _next: NextFunction) => {
  logger.error({ requestId: req.id, method: req.method, path: req.path, err: String(err) }, "request failed");
  res.status(500).json({ error: "internal error" });
});

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4310);
  const server = app.listen(port, () => {
    logger.info({ port }, "review dashboard listening");
  });
  installLifecycleHandlers(server, logger);
}
