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
  setReviewItemsStatus
} from "@vvugc/review-queue";
import { listRuns } from "./runs.js";
import { renderDashboardPage } from "./render.js";
import { createBasicAuthMiddleware, resolveCredentials } from "./auth.js";

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
