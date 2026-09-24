import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ holds Playwright specs (test:e2e script) — they use @playwright/test's
    // own test()/expect(), not vitest's, and vitest's default include pattern
    // (**/*.spec.ts) would otherwise pick them up and fail trying to run them.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    // The dashboard tests intentionally configure process.env.VVUGC_DB_PATH and
    // import the shared review-queue store. Parallel files can overwrite that
    // process-global configuration while another server is handling a request,
    // producing false timeout failures and cross-test data leakage.
    fileParallelism: false,
    // The suite creates and closes Express servers and mutates process-wide
    // environment variables. On Windows, Tinypool's default worker-thread
    // shutdown can leave the runner alive after those tests have completed.
    // Use one forked worker so the process boundary is explicit and teardown is
    // deterministic, without excluding or weakening any test files.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});
