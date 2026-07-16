import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One seeded temp store for the whole e2e run — set here (not per-test) so both
// globalSetup (which seeds it) and the webServer child process (which serves it)
// agree on the same path. File-based, so seeding order relative to server startup
// doesn't matter: the server reads the file fresh on every request, never caches
// it at boot.
const e2eDir = mkdtempSync(join(tmpdir(), "vvugc-dashboard-e2e-"));
process.env.VVUGC_DB_PATH = join(e2eDir, "queue.json");
process.env.VVUGC_RUNS_DIR = join(e2eDir, "runs");

const PORT = 4319;
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
      VVUGC_DB_PATH: process.env.VVUGC_DB_PATH,
      VVUGC_RUNS_DIR: process.env.VVUGC_RUNS_DIR,
      DASHBOARD_USERNAME,
      DASHBOARD_PASSWORD
    },
    reuseExistingServer: false,
    timeout: 15_000
  }
});
