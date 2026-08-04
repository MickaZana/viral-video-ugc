import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One seeded temp store for the whole e2e run — set here (not per-test) so both
// globalSetup (which seeds it) and the webServer child process (which serves it)
// agree on the same path. File-based, so seeding order relative to server startup
// doesn't matter: the server reads the file fresh on every request, never caches
// it at boot.
//
// Guarded on VVUGC_DB_PATH not already being set: Playwright re-evaluates this
// config module independently in every worker process (a separate OS process per
// worker, not just a separate module scope), so an unconditional mkdtempSync here
// would hand each worker its own fresh temp dir instead of the one the root
// process already created and started the webServer against — invisible as long
// as tests only talk to the server over HTTP, but a real bug for any test (e.g.
// one that calls runCycle()/insertReviewItem in-process) that reads/writes the
// store directly from within a worker, since it would silently write to a
// different file than the one the running server actually serves. Workers inherit
// process.env from the root process at spawn time, so checking here reuses that
// same value instead of re-randomizing it.
if (!process.env.VVUGC_DB_PATH) {
  const e2eDir = mkdtempSync(join(tmpdir(), "vvugc-dashboard-e2e-"));
  process.env.VVUGC_DB_PATH = join(e2eDir, "queue.json");
  process.env.VVUGC_RUNS_DIR = join(e2eDir, "runs");
}

// The repo-root .env carries real database credentials (SUPABASE_DATABASE_URL is
// mapped to DATABASE_URL by shared-config's loadEnv), and dotenv never overrides a
// variable that's already set. The webServer block below already pins DATABASE_URL
// to "" — but globalSetup and any in-process store access inside a worker
// (operator-journey.spec.ts calls runCycle() in the test process) run in the
// Playwright root/worker processes, which inherit .env unless we clear the keys
// here too. Without this, seeds and dry-run output land in the developer's real
// Postgres while the server serves the temp JSON store — the exact split-brain the
// webServer env was already guarding against, just one process boundary over.
process.env.DATABASE_URL = "";
process.env.SUPABASE_DATABASE_URL = "";

const PORT = 4319;
const DASHBOARD_USERNAME = "e2e-user";
const DASHBOARD_PASSWORD = "e2e-password";
// Stripe webhook signature verification (stripe.webhooks.constructEvent) is pure
// local HMAC over these two values — it never calls out to Stripe's API, so a
// fixed test secret here is enough for customer-journey.spec.ts to simulate a
// real signed webhook without a live Stripe account. Never a real key.
const STRIPE_SECRET_KEY = "sk_test_e2e_placeholder";
// Exported so customer-journey.spec.ts can sign its own simulated webhook payload
// with the exact same secret the running server verifies against.
export const STRIPE_WEBHOOK_SECRET = "whsec_e2e_test_secret";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Every route but /healthz requires Basic Auth (see src/auth.ts) — this makes
    // every browser context in this suite answer the auth challenge automatically,
    // the same way a real user's saved browser credentials would.
    httpCredentials: { username: DASHBOARD_USERNAME, password: DASHBOARD_PASSWORD }
  },
  webServer: {
    command: "node dist/server.js",
    // A URL (not bare `port`) so Playwright's readiness probe waits for an actual
    // 2xx — /healthz is the one route that doesn't require auth, so this stays
    // correct now that every other route would otherwise answer 401 during startup.
    url: `http://localhost:${PORT}/healthz`,
    env: {
      PORT: String(PORT),
      VVUGC_DB_PATH: process.env.VVUGC_DB_PATH!,
      VVUGC_RUNS_DIR: process.env.VVUGC_RUNS_DIR!,
      // Browser tests must remain hermetic even when the developer's root .env
      // points at a real Supabase project.
      DATABASE_URL: "",
      SUPABASE_DATABASE_URL: "",
      DASHBOARD_USERNAME,
      DASHBOARD_PASSWORD,
      STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET,
      SOCIAL_TOKEN_ENCRYPTION_KEY: "e2e-social-token-encryption-key-at-least-32-characters"
    },
    reuseExistingServer: false,
    timeout: 15_000
  }
});
