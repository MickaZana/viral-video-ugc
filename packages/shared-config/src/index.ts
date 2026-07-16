import "dotenv/config";
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
  /** Voiceover narration synced to burned-in captions — see packages/mcp-voiceover. Optional;
   *  select a vendor with the CLI's --voice-vendor flag, not just by setting a key here. */
  ELEVENLABS_API_KEY: z.string().optional(),
  /** Defaults to a stable built-in ElevenLabs voice if unset — see adapters/elevenlabs.ts. */
  ELEVENLABS_VOICE_ID: z.string().optional(),
  /** xAI's Grok Speech/TTS API — same key as any other xAI API usage, not voiceover-specific. */
  XAI_API_KEY: z.string().optional(),
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
  /** Publishing (packages/mcp-publish) — never called automatically by the pipeline, only
   *  from an explicit post-approval action (review-dashboard's POST /queue/:id/publish).
   *  A TikTok user access token with the video.publish scope, from a completed 3-legged
   *  OAuth flow — not the TIKTOK_CLIENT_KEY/SECRET pair discovery uses. */
  TIKTOK_ACCESS_TOKEN: z.string().optional(),
  /** A Facebook Page access token (not a user token) with pages_manage_posts. */
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  /** The Meta App ID that owns the upload session — required by the Graph API's
   *  resumable Upload API (POST /<APP_ID>/uploads), separate from META_ACCESS_TOKEN
   *  (discovery's hashtag-search token) and META_PAGE_ACCESS_TOKEN above. */
  META_APP_ID: z.string().optional(),
  /** The destination Facebook Page's id — where publishToFacebookPage actually posts. */
  META_PAGE_ID: z.string().optional(),
  /** A YouTube OAuth access token with the youtube.upload scope. */
  YOUTUBE_ACCESS_TOKEN: z.string().optional(),
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
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0)
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Re-parses process.env on every call rather than caching — this object is
 * ~15 fields, Zod-parsing it is not a cost worth optimizing for, and caching
 * it previously made env vars that change mid-process (e.g. per-test-case in
 * a test suite) permanently stuck at whatever they were on first call.
 */
export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}

/** Keys of Env whose value is an optional secret/string — everything requireEnvVar
 *  can sensibly be asked for. Excludes non-string config like TRUST_PROXY_HOPS. */
type StringEnvKey = Exclude<keyof Env, "TRUST_PROXY_HOPS">;

/**
 * Adapters call this at the point a vendor call is actually made, not at
 * startup — keeps --dry-run runnable with zero configured API keys.
 */
export function requireEnvVar(key: StringEnvKey): string {
  const env = loadEnv();
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing required env var "${key}". Set it in .env or your shell before running this stage live (not --dry-run).`
    );
  }
  return value;
}
