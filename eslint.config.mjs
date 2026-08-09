import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/runs/**",
      "**/coverage/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Everything in this repo runs under Node (services, CLI, build scripts,
      // Playwright config) except the two apps' plain-<script> client-side JS.
      globals: globals.node
    }
  },
  {
    // apps/*/public/*.js are served as-is to the browser (no bundler) — they run
    // in a DOM, not Node, so `document`/`fetch`/`FormData` are real globals there,
    // not undefined references.
    files: ["**/public/**/*.js"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    rules: {
      // A leftover unused import/variable is a real smell worth catching, but an
      // unused function *parameter* is common and harmless (e.g. Express error
      // middleware's required 4-arg signature, interface implementations) — don't
      // flag those, only bindings that are never referenced at all.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // This codebase deliberately uses `any` at a few real API boundaries (parsing
      // Claude's freeform JSON responses, Express route query params) — banning it
      // outright would force awkward `unknown` casts with no real safety benefit
      // over reviewing those spots by eye. Downgraded to a warning, not silenced.
      "@typescript-eslint/no-explicit-any": "warn"
    }
  },
  // The React control-panel is the only React surface; scope the React Hooks rules
  // to it rather than applying them to every server-side file in the repo. Two
  // effects deliberately suppress exhaustive-deps (useApi.ts and Rewriter.tsx) —
  // the plugin must be loaded for those disable comments to be valid, not errors.
  {
    files: ["apps/control-panel/**/*.{ts,tsx}"],
    ...reactHooks.configs["recommended-latest"]
  }
);
