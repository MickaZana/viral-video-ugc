import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One seeded temp store for the whole e2e run — set here (not per-test) so both
// globalSetup (which seeds it) and the webServer child process (which serves it)
// agree on the same path. Same rationale as apps/review-dashboard's config: the
// control-panel SPA is served by the review-dashboard server itself, so this
// suite boots that server against an isolated temp store rather than the dev
// machine's real ./runs data.
//
// Guarded on VVUGC_DB_PATH not already being set: Playwright re-evaluates this
// config module independently in every worker process, so an unconditional
// mkdtempSync here would hand each worker its own fresh temp dir instead of the
// one the root process created and started the webServer against.
if (!process.env.VVUGC_DB_PATH) {
  const e2eDir = mkdtempSync(join(tmpdir(), "vvugc-control-panel-e2e-"));
  process.env.VVUGC_DB_PATH = join(e2eDir, "queue.json");
  process.env.VVUGC_RUNS_DIR = join(e2eDir, "runs");
}

// Clear real database credentials the same way review-dashboard's config does —
// the repo-root .env carries real Supabase/Postgres values that dotenv would
// otherwise load into the webServer child and any in-process store access, and
// the e2e store must stay hermetic.
process.env.DATABASE_URL = "";
process.env.SUPABASE_DATABASE_URL = "";

const PORT = 4339;
const DASHBOARD_USERNAME = "e2e-user";
const DASHBOARD_PASSWORD = "e2e-password";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The control-panel's data endpoints sit behind the dual-auth gate (account
    // session OR the operator's Basic Auth — see server.ts). After signup the
    // session cookie covers them; httpCredentials additionally answers the
    // Basic Auth challenge for any request where the session hasn't been
    // established yet, the same way a saved browser credential would.
    httpCredentials: { username: DASHBOARD_USERNAME, password: DASHBOARD_PASSWORD }
  },
  webServer: {
    // The control-panel SPA has no server of its own — it is served at /app by
    // the review-dashboard server, which this suite boots (built by pnpm -r run
    // build, which also produces the SPA dist the server mounts).
    command: "node ../review-dashboard/dist/server.js",
    // /healthz is the one route that answers without auth, so Playwright's
    // readiness probe waits on a real 2xx rather than a socket open.
    url: `http://localhost:${PORT}/healthz`,
    env: {
      PORT: String(PORT),
      VVUGC_DB_PATH: process.env.VVUGC_DB_PATH!,
      VVUGC_RUNS_DIR: process.env.VVUGC_RUNS_DIR!,
      // Browser tests must remain hermetic even when the developer's root .env
      // points at a real Supabase project.
      DATABASE_URL: "",
      SUPABASE_DATABASE_URL: "",
      // …and a real Stripe account. Clearing these forces POST
      // /accounts/billing/checkout down its deterministic unconfigured path (422
      // with the missing-price error), the same way billing-routes.test.ts does —
      // otherwise a dev with live Stripe keys would redirect the test browser to
      // a real hosted Checkout session instead.
      STRIPE_SECRET_KEY: "",
      STRIPE_PRICE_ID_STARTER: "",
      STRIPE_PRICE_ID_GROWTH: "",
      STRIPE_PRICE_ID_AGENCY: "",
      DASHBOARD_USERNAME,
      DASHBOARD_PASSWORD,
      SOCIAL_TOKEN_ENCRYPTION_KEY: "e2e-social-token-encryption-key-at-least-32-characters"
    },
    reuseExistingServer: false,
    timeout: 15_000
  }
});
