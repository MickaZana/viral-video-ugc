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
  KLING_ACCESS_KEY: z.string().optional(),
  KLING_SECRET_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  /** Pika is served through fal.ai's platform, not a standalone Pika API — see adapters/pika.ts. */
  FAL_KEY: z.string().optional(),
  /** ASR fallback for platforms without public caption tracks — see mcp-transcript/src/asr.ts. */
  OPENAI_API_KEY: z.string().optional(),
  VVUGC_DB_PATH: z.string().default(join(REPO_ROOT, "runs", "review-queue.json")),
  VVUGC_RUNS_DIR: z.string().default(join(REPO_ROOT, "runs"))
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

/**
 * Adapters call this at the point a vendor call is actually made, not at
 * startup — keeps --dry-run runnable with zero configured API keys.
 */
export function requireEnvVar(key: keyof Env): string {
  const env = loadEnv();
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing required env var "${key}". Set it in .env or your shell before running this stage live (not --dry-run).`
    );
  }
  return value;
}
