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
  KLING_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  PIKA_API_KEY: z.string().optional(),
  VVUGC_DB_PATH: z.string().default(join(REPO_ROOT, "runs", "review-queue.json")),
  VVUGC_RUNS_DIR: z.string().default(join(REPO_ROOT, "runs"))
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (!cached) {
    cached = EnvSchema.parse(process.env);
  }
  return cached;
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
