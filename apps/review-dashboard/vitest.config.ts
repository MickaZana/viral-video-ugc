import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ holds Playwright specs (test:e2e script) — they use @playwright/test's
    // own test()/expect(), not vitest's, and vitest's default include pattern
    // (**/*.spec.ts) would otherwise pick them up and fail trying to run them.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"]
  }
});
