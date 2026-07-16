import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const e2eDir = mkdtempSync(join(tmpdir(), "vvugc-marketing-e2e-"));
process.env.VVUGC_RUNS_DIR = join(e2eDir, "runs");

const PORT = 4329;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    command: "node dist/server.js",
    port: PORT,
    env: {
      PORT: String(PORT),
      VVUGC_RUNS_DIR: process.env.VVUGC_RUNS_DIR
    },
    reuseExistingServer: false,
    timeout: 15_000
  }
});
