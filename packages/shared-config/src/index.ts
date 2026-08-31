import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

/**
 * pnpm sets INIT_CWD to the directory `pnpm` was invoked from — the repo
 * root, even when `pnpm --filter <pkg> run ...` changes the actual process
 * cwd into that package's directory. Anchoring the default runs dir here
 * (instead of process.cwd()) keeps the orchestrator and review-dashboard
 * reading/writing the same runs/ directory regardless of which package's
 * script launched them.
 */
const REPO_ROOT = process.env.INIT_CWD ?? process.cwd();

// Load .env from the repo root, NOT process.cwd() — previously `import "dotenv/config"`
// resolved .env relative to cwd, which pnpm sets to each package's own directory, so a
// `pnpm --filter <pkg> run ...` process (e.g. the orchestrator CLI) silently never saw
// the repo-root .env while a process launched from the repo root did. For a repo whose
// whole point is that every process shares one config (DATABASE_URL -> SUPABASE_DATABASE_URL
// determines whether the review-queue uses Postgres or the JSON file), that split made the
// pipeline and the dashboard pick different storage backends depending on how each was
// launched. Anchoring here (same REPO_ROOT as VVUGC_RUNS_DIR/VVUGC_DB_PATH defaults) makes
// env resolution and path defaults agree for every package.
//
// Skipped under Vitest: tests set their own process.env explicitly (see e.g.
// review-queue's db.test.ts), and previously never saw the developer's repo-root .env
// because the cwd-relative lookup missed it. Loading it now would inject real
// credentials (STRIPE_SECRET_KEY, META_APP_ID, SUPABASE_DATABASE_URL...) into suites
// that assert on their absence — that's a behavior change no test asked for. Guarding on
// VITEST (set by Vitest in both the runner and workers) keeps test env hermetic and
// deterministic while the app itself gets the unified .env it needs.
// Captured separately from the process.env merge above: dotenv's default config()
// never overwrites a name already present in process.env, so once loaded there is
// no way to tell "this value came from .env" from "this was already sitting in the
// ambient shell." XAI_API_KEY/GROK_API_KEY specifically need that distinction (see
// resolveXaiOrGrokKey below) — a stale personal XAI_API_KEY left set globally on a
// dev machine must never silently outrank this project's own configured
// GROK_API_KEY. dotenvFileValues holds only what .env itself declares; same VITEST
// guard as above (and for the same reason — never load real .env secrets into a
// test process), which is exactly why the precedence logic itself is factored out
// below as a pure function tests can exercise with synthetic values instead.
const dotenvFileValues: Record<string, string> = process.env.VITEST
  ? {}
  : loadDotenv({ path: join(REPO_ROOT, ".env"), quiet: true }).parsed ?? {};

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  /**
   * The Instagram Business/Creator Account ID making hashtag-search requests —
   * required by ig_hashtag_search and every {hashtag-id}/top_media call, per
   * https://developers.facebook.com/docs/instagram-api/guides/hashtag-search.
   * A Meta access token alone is not sufficient; this is a second, separate
   * required value. See packages/mcp-discovery/src/tools/meta.ts.
   */
  META_IG_BUSINESS_ACCOUNT_ID: z.string().optional(),
  KLING_ACCESS_KEY: z.string().optional(),
  KLING_SECRET_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  /** Pika is served through fal.ai's platform, not a standalone Pika API — see adapters/pika.ts. */
  FAL_KEY: z.string().optional(),
  /** Seedance 2.0 model ID on fal.ai — defaults to "fal-ai/seedance-2" if unset.
   *  Override for a specific tier (e.g. "fal-ai/seedance-2/fast"). */
  SEEDANCE_MODEL: z.string().optional(),
  /** Voiceover narration synced to burned-in captions — see packages/mcp-voiceover. Optional;
   *  select a vendor with the CLI's --voice-vendor flag, not just by setting a key here. */
  ELEVENLABS_API_KEY: z.string().optional(),
  /** Defaults to a stable built-in ElevenLabs voice if unset — see adapters/elevenlabs.ts. */
  ELEVENLABS_VOICE_ID: z.string().optional(),
  /** xAI's Grok Speech/TTS or Chat API — same key as any other xAI API usage. */
  XAI_API_KEY: z.string().optional(),
  /** Grok / xAI API key alias. */
  GROK_API_KEY: z.string().optional(),
  /** Defaults to xAI's "eve" voice if unset — see adapters/grok.ts. */
  GROK_VOICE_ID: z.string().optional(),
  /** ASR fallback for platforms without public caption tracks — see mcp-transcript/src/asr.ts. */
  OPENAI_API_KEY: z.string().optional(),
  /** Gemini image generation — fills in B-roll when a talking-head/photo vendor isn't
   *  configured, or (via a marketing-site script) generates demo-gallery stills. Select
   *  it with --video-vendor gemini; see packages/mcp-video-gen/src/adapters/gemini.ts. */
  GEMINI_API_KEY: z.string().optional(),
  /** Defaults to "gemini-2.5-flash-image" ("Nano Banana") if unset — see adapters/gemini.ts. */
  GEMINI_IMAGE_MODEL: z.string().optional(),
  /** Replicate (replicate.com) — a model-hosting platform, not a single vendor: one token
   *  gives access to many interchangeable text-to-video models. Select it with
   *  --video-vendor replicate; see packages/mcp-video-gen/src/adapters/replicate.ts. */
  REPLICATE_API_TOKEN: z.string().optional(),
  /** Model slug to run, e.g. "minimax/video-01" or "luma/ray-3.2" — defaults to
   *  replicate.ts's own DEFAULT_MODEL if unset. Per-model input schemas vary; an
   *  incompatible override surfaces as a clear error from Replicate's own API, not
   *  a silent misparse. */
  REPLICATE_MODEL: z.string().optional(),
  /** Publishing (packages/mcp-publish) — never called automatically by the pipeline, only
   *  from an explicit post-approval action (review-dashboard's POST /queue/:id/publish).
   *  A TikTok user access token with the video.publish scope, from a completed 3-legged
   *  OAuth flow — not the TIKTOK_CLIENT_KEY/SECRET pair discovery uses. */
  TIKTOK_ACCESS_TOKEN: z.string().optional(),
  /** A Facebook Page access token (not a user token) with pages_manage_posts. */
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_USER_ACCESS_TOKEN: z.string().optional(),
  /** The Meta App ID that owns the upload session — required by the Graph API's
   *  resumable Upload API (POST /<APP_ID>/uploads), separate from META_ACCESS_TOKEN
   *  (discovery's hashtag-search token) and META_PAGE_ACCESS_TOKEN above. */
  META_APP_ID: z.string().optional(),
  /** The destination Facebook Page's id — where publishToFacebookPage actually posts. */
  META_PAGE_ID: z.string().optional(),
  /** A YouTube OAuth access token with the youtube.upload scope. */
  YOUTUBE_ACCESS_TOKEN: z.string().optional(),
  /** Billing (packages/shared-billing) — placeholder-tier scaffolding, not live pricing.
   *  Secret key for server-side Stripe API calls (checkout session creation). */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Signing secret for verifying POST /webhooks/stripe payloads. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Real Stripe Price IDs for each placeholder tier in shared-billing/src/tiers.ts —
   *  checkout fails with a clear error for a tier whose Price ID isn't set, rather than
   *  falling back to a hardcoded price. */
  STRIPE_PRICE_ID_STARTER: z.string().optional(),
  STRIPE_PRICE_ID_GROWTH: z.string().optional(),
  STRIPE_PRICE_ID_AGENCY: z.string().optional(),
  VVUGC_DB_PATH: z.string().default(join(REPO_ROOT, "runs", "review-queue.json")),
  VVUGC_RUNS_DIR: z.string().default(join(REPO_ROOT, "runs")),
  /**
   * Opt-in Postgres backend for the review-queue store (packages/review-queue).
   * Unset: the JSON-file + lockfile store is used, which only guarantees safe
   * concurrent access from processes on the same machine/filesystem. Set this
   * when the dashboard and orchestrator run on different machines (e.g. the
   * dashboard as a long-running service, the orchestrator as a GitHub Actions
   * job) — a real database is required for that, not just a bigger lockfile.
   */
  DATABASE_URL: z.string().optional(),
  /** Forwards each marketing-site email-capture submission to this webhook (Zapier/Make/Sheets-via-Apps-Script/etc). Unset: submissions are only persisted locally. */
  WAITLIST_WEBHOOK_URL: z.string().optional(),
  /**
   * HTTP Basic Auth credentials for the review-dashboard (approve/reject a
   * candidate's finished video before it ships — not something to leave open
   * on a network). Both unset: the dashboard generates a random password at
   * startup and logs it once (see apps/review-dashboard/src/auth.ts) rather
   * than ever running unauthenticated — set these explicitly for a stable,
   * reusable login instead of a new password every restart.
   */
  DASHBOARD_USERNAME: z.string().optional(),
  DASHBOARD_PASSWORD: z.string().optional(),
  /**
   * HMAC secret for signing short-lived public video URLs (see
   * apps/review-dashboard/src/public-assets.ts) — used to hand a vendor API that
   * requires a publicly fetchable video_url (Instagram Reels' Content Publishing
   * API) a time-limited link into VVUGC_RUNS_DIR without exposing the whole
   * directory. Unset: an in-memory secret is generated at startup (fine — these
   * URLs only need to survive one publish attempt within the same process).
   */
  ASSET_SIGNING_SECRET: z.string().optional(),
  /** Master secret used to encrypt per-client social OAuth tokens at rest. */
  SOCIAL_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  /** Dedicated application AEAD key for TOTP secrets stored in Postgres. This
   * is intentionally distinct from OAuth-token encryption so key rotation and
   * access can be scoped independently. */
  MFA_ENCRYPTION_KEY: z.string().min(32).optional(),
  OAUTH_STATE_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  /**
   * Platform evolution feature flags (Phase B.5).
   * Default: disabled. Enable in development/test to access dormant features.
   * MUST be evaluated server-side — never trust frontend-supplied values.
   */
  VVUGC_AGENCY_CLIENTS_ENABLED: z.string().optional(),
  VVUGC_API_ENABLED: z.string().optional(),
  VVUGC_PLATFORM_ADMIN_ENABLED: z.string().optional(),
  VVUGC_WEBHOOKS_ENABLED: z.string().optional(),
  /**
   * Absolute origin (e.g. "https://myapp.example.com", no trailing slash) the
   * marketing-site is publicly reachable at — needed because og:image/twitter:image
   * meta tags must be absolute URLs per spec, and the server has no other way
   * to know its own public origin (it may sit behind a proxy/CDN with a
   * different host than what it binds to). Unset: falls back to deriving the
   * origin from each incoming request (fine for local/dev, but a proxy that
   * doesn't forward the original protocol/host will get it wrong — set this
   * explicitly for any real deployment).
   */
  PUBLIC_BASE_URL: z.string().optional(),
  /**
   * Number of reverse-proxy hops in front of this service (Express's `trust proxy`
   * setting — see https://expressjs.com/en/guide/behind-proxies.html). Controls
   * where `req.ip` and the rate limiter (express-rate-limit, keyed by IP by
   * default) read the client's real address from. Default 0: trust nothing,
   * `req.ip` is the direct TCP peer — correct for local dev and a directly
   * exposed container, but WRONG behind any load balancer/reverse proxy (Fly.io,
   * Railway, nginx, an ALB), where every request would appear to come from the
   * proxy's own IP and the rate limiter would bucket every real client together.
   * Set to 1 for a single reverse proxy in front (the common case); higher only
   * if you've deliberately chained more. Never set to `true`/unbounded — that
   * trusts X-Forwarded-For as far back as a client cares to spoof it.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  /**
   * Retention window (days) for the dashboard's append-only log streams
   * (audit.ndjson + security-events.ndjson — see apps/review-dashboard/src/
   * retention.ts). Older lines are dropped on a bounded schedule; the default of
   * 90 days is long enough to reconstruct what happened in any incident that
   * matters while keeping the files from growing without bound.
   */
  SECURITY_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  // ---------------------------------------------------------------------------
  // Video Worker
  // ---------------------------------------------------------------------------
  /** Two-key live gate: set to "true" to allow real provider API calls. */
  VVUGC_LLM_LIVE: z.string().optional(),
  /** MCP server URL for Higgsfield adapter connectivity. */
  MCP_SERVER_URL: z.string().optional(),
  /** Timeout in ms for establishing an MCP session connection. */
  MCP_CONNECT_TIMEOUT_MS: z.string().optional(),
  /** Maximum reconnect attempts before giving up on MCP. */
  MCP_MAX_RECONNECT_ATTEMPTS: z.string().optional(),
  /** Number of concurrent provider jobs to process. */
  VIDEO_WORKER_CONCURRENCY: z.string().optional(),
  /** Polling interval in ms between job-claim attempts. */
  VIDEO_WORKER_POLL_MS: z.string().optional(),
  /** Lease duration in ms before a claimed job is considered abandoned. */
  VIDEO_WORKER_LEASE_MS: z.string().optional(),
  /** Port for the video-worker health/metrics HTTP server. */
  VIDEO_WORKER_HEALTH_PORT: z.string().optional(),
  // ---------------------------------------------------------------------------
  // LipSync
  // ---------------------------------------------------------------------------
  /** Sync Labs API key for talking-head lipsync generation. */
  SYNC_LABS_API_KEY: z.string().optional(),
  /** HeyGen API key for talking-head lipsync generation. */
  HEYGEN_API_KEY: z.string().optional()
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Re-parses process.env on every call rather than caching — this object is
 * ~15 fields, Zod-parsing it is not a cost worth optimizing for, and caching
 * it previously made env vars that change mid-process (e.g. per-test-case in
 * a test suite) permanently stuck at whatever they were on first call.
 */
export function loadEnv(): Env {
  const env = { ...process.env };
  if (!env.DATABASE_URL && env.SUPABASE_DATABASE_URL) {
    env.DATABASE_URL = env.SUPABASE_DATABASE_URL;
  }
  return EnvSchema.parse(env);
}

/** Keys of Env whose value is an optional secret/string — everything requireEnvVar
 *  can sensibly be asked for. Excludes non-string config like TRUST_PROXY_HOPS. */
type StringEnvKey = Exclude<keyof Env, "TRUST_PROXY_HOPS" | "SECURITY_LOG_RETENTION_DAYS">;

/**
 * XAI_API_KEY and GROK_API_KEY name the same xAI credential. Resolution order:
 * this project's .env value for the requested name, then .env's value for the
 * alias name, then whatever's left in the ambient OS/shell environment for
 * either name. .env always wins over the ambient shell — a stale personal
 * XAI_API_KEY exported globally on a dev machine (from some other project, an
 * old trial, a shell profile) must never silently shadow this project's own
 * configured GROK_API_KEY.
 *
 * Pure and exported (rather than reading dotenvFileValues/process.env
 * directly) so shared-config's own tests can exercise the precedence rule
 * with synthetic values — the module-level dotenvFileValues is itself
 * VITEST-guarded to empty (see above), so there'd otherwise be no way to test
 * this logic without either loading real .env secrets into a test process or
 * never covering the ".env beats ambient shell" behavior at all.
 */
export function resolveXaiOrGrokKeyFrom(
  key: "XAI_API_KEY" | "GROK_API_KEY",
  dotenvValues: { XAI_API_KEY?: string; GROK_API_KEY?: string },
  ambientEnv: { XAI_API_KEY?: string; GROK_API_KEY?: string }
): string | undefined {
  const aliasKey = key === "XAI_API_KEY" ? "GROK_API_KEY" : "XAI_API_KEY";
  return dotenvValues[key] || dotenvValues[aliasKey] || ambientEnv[key] || ambientEnv[aliasKey];
}

/**
 * Every distinct known xAI credential value, in the same trust order as
 * resolveXaiOrGrokKeyFrom (this project's .env first, then the ambient
 * shell) — for call sites that want to retry a live 403 ("no credits/
 * permission") against a different key rather than fail outright once the
 * top pick turns out to be unfunded. Always includes at least the value
 * requireEnvVar("XAI_API_KEY"|"GROK_API_KEY") would have returned, first.
 */
export function xaiGrokKeyCandidatesFrom(
  dotenvValues: { XAI_API_KEY?: string; GROK_API_KEY?: string },
  ambientEnv: { XAI_API_KEY?: string; GROK_API_KEY?: string }
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const v of [dotenvValues.GROK_API_KEY, dotenvValues.XAI_API_KEY, ambientEnv.GROK_API_KEY, ambientEnv.XAI_API_KEY]) {
    if (v && !seen.has(v)) {
      seen.add(v);
      candidates.push(v);
    }
  }
  return candidates;
}

/** Real-module-state wrapper around xaiGrokKeyCandidatesFrom — see that function's
 *  doc for the precedence rule and why the logic itself lives in a pure function. */
export function xaiGrokKeyCandidates(): string[] {
  return xaiGrokKeyCandidatesFrom(dotenvFileValues, loadEnv());
}

/**
 * Adapters call this at the point a vendor call is actually made, not at
 * startup — keeps --dry-run runnable with zero configured API keys.
 */
export function requireEnvVar(key: StringEnvKey): string {
  const env = loadEnv();
  const value = key === "XAI_API_KEY" || key === "GROK_API_KEY"
    ? resolveXaiOrGrokKeyFrom(key, dotenvFileValues, env)
    : env[key];
  if (!value) {
    throw new Error(
      `Missing required env var "${key}". Set it in .env or your shell before running this stage live (not --dry-run).`
    );
  }
  return value;
}

export function validateProductionEnv(env: Env = loadEnv()): void {
  const required: Array<keyof Env> = [
    "DATABASE_URL",
    "DASHBOARD_USERNAME",
    "DASHBOARD_PASSWORD",
    "ASSET_SIGNING_SECRET",
    "SOCIAL_TOKEN_ENCRYPTION_KEY",
    "MFA_ENCRYPTION_KEY",
    "OAUTH_STATE_SECRET",
    "PUBLIC_BASE_URL"
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Production configuration is incomplete. Missing: ${missing.join(", ")}`);
  }
  if (!env.PUBLIC_BASE_URL!.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must use https:// in production");
  }
  if (env.DASHBOARD_PASSWORD!.length < 16) {
    throw new Error("DASHBOARD_PASSWORD must be at least 16 characters in production");
  }
}
