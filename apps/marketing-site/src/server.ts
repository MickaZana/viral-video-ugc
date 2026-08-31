import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createAppMetrics, installLifecycleHandlers, reportError, requestIdMiddleware } from "@vvugc/shared-metrics";
import { loadEnv } from "@vvugc/shared-config";
import { renderPage, type VideoEntry } from "./render.js";
import { recordWaitlistSubmission } from "./waitlist.js";
import { renderPrivacyPolicy, renderTerms, type LegalIdentity } from "./legal.js";

const require = createRequire(import.meta.url);
const logger = pino({ name: "vvugc-marketing-site" });
const startedAt = Date.now();
const { metricsMiddleware, metricsHandler } = createAppMetrics("marketing-site");

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const manifestPath = join(__dirname, "..", "content", "video-manifest.json");

function loadManifest(): VideoEntry[] {
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

// Express 5 forwards a rejected async-handler promise to error-handling
// middleware on its own, so this is redundant-but-harmless now — kept explicit
// (rather than relying on the framework default) since recordWaitlistSubmission
// does real I/O (a webhook fetch) that can reject.
function asyncHandler<P = Record<string, string>>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export const app: Express = express();
// See TRUST_PROXY_HOPS in @vvugc/shared-config — without this, req.ip (and so the
// waitlist rate limiter below, which keys on it) reads the wrong address for every
// request once this sits behind any reverse proxy/load balancer.
const { TRUST_PROXY_HOPS } = loadEnv();
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(requestIdMiddleware);
app.use(metricsMiddleware);

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

// Liveness/readiness probe for container orchestrators.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
});

// Prometheus scrape target — see @vvugc/shared-metrics for why this stays
// unauthenticated (aggregate operational data, standard scraper convention).
app.get("/metrics", metricsHandler);

app.use(express.static(publicDir, { index: false }));
// @vvugc/design-tokens is a workspace CSS-only package (no build step) — resolve it
// through node_modules symlinking rather than a hardcoded relative repo path, so this
// keeps working regardless of where in the workspace this app is invoked from.
app.get("/tokens.css", (_req, res) => {
  res.type("css").sendFile(require.resolve("@vvugc/design-tokens"));
});

// og:image/twitter:image must be absolute URLs per spec. PUBLIC_BASE_URL is the
// authoritative source (needed behind a proxy/CDN that doesn't forward the real
// host); falling back to the request's own protocol/host covers local/dev use.
function resolveBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

app.get("/", (req, res) => {
  const template = readFileSync(join(publicDir, "index.html"), "utf-8");
  res.type("html").send(renderPage(loadManifest(), template, resolveBaseUrl(req)));
});

app.get("/api/manifest", (_req, res) => {
  res.json(loadManifest());
});

// /privacy and /terms — renderPrivacyPolicy()/renderTerms() (./legal.ts) were built
// and unit-tested (legal.test.ts) but never actually routed here; the OAuth-facing
// content they contain (added for Google's public-privacy-policy-URL requirement on
// the OAuth consent screen — review-dashboard's Google YouTube-connect flow) has
// never been reachable at all. LEGAL_ENTITY_NAME/LEGAL_PRIVACY_EMAIL/LEGAL_ADDRESS
// are real legal/compliance content this codebase has no authority to invent — checked
// once at module load (below), same "fail at boot, not on first real request" contract
// as DATABASE_URL's production check in review-dashboard's accounts.ts, rather than
// publishing a fabricated entity name or a fake contact email. The dev fallback used
// outside production is deliberately not plausible so it can't be mistaken for real
// configuration.
if (process.env.NODE_ENV === "production" && (!process.env.LEGAL_ENTITY_NAME || !process.env.LEGAL_PRIVACY_EMAIL)) {
  throw new Error(
    "LEGAL_ENTITY_NAME and LEGAL_PRIVACY_EMAIL are required in production — /privacy and /terms publish real legal content and must not fall back to a placeholder."
  );
}
function resolveLegalIdentity(): LegalIdentity {
  return {
    entityName: process.env.LEGAL_ENTITY_NAME || "[Configure LEGAL_ENTITY_NAME]",
    privacyEmail: process.env.LEGAL_PRIVACY_EMAIL || "configure-LEGAL_PRIVACY_EMAIL@example.invalid",
    address: process.env.LEGAL_ADDRESS
  };
}

app.get("/privacy", (_req, res) => {
  res.type("html").send(renderPrivacyPolicy(resolveLegalIdentity()));
});

app.get("/terms", (_req, res) => {
  res.type("html").send(renderTerms(resolveLegalIdentity()));
});

// Public, unauthenticated endpoint — without a limit, it's a disk-fill vector
// (unbounded rows appended to runs/waitlist.jsonl) and a way to hammer WAITLIST_WEBHOOK_URL.
const waitlistRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too many submissions — please try again later" }
});

app.post(
  "/api/waitlist",
  waitlistRateLimiter,
  asyncHandler(async (req, res) => {
    const result = await recordWaitlistSubmission(req.body?.email);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  })
);

// Error-handling middleware — must have exactly 4 params for Express to
// recognize it as such. Catches rejections forwarded by asyncHandler.
app.use((err: unknown, req: Request & { id?: string }, res: Response, _next: NextFunction) => {
  reportError(err, { requestId: req.id, method: req.method, path: req.path }, {
    service: "marketing-site",
    errorFile: join(loadEnv().VVUGC_RUNS_DIR, "errors.ndjson"),
    log: (record, message) => logger.error(record, message)
  });
  res.status(500).json({ ok: false, error: "internal error" });
});

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4320);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = app.listen(port, host, () => {
    logger.info({ host, port }, "marketing site listening");
  });
  installLifecycleHandlers(server, logger);
}
