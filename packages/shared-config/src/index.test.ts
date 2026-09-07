import { afterEach, describe, expect, it } from "vitest";
import {
  loadEnv,
  requireEnvVar,
  resolveXaiOrGrokKeyFrom,
  validateProductionEnv,
  xaiGrokKeyCandidatesFrom
} from "./index.js";

describe("loadEnv", () => {
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DATABASE_URL;
  });

  it("reflects process.env changes made after the module was first imported", () => {
    delete process.env.YOUTUBE_API_KEY;
    expect(loadEnv().YOUTUBE_API_KEY).toBeUndefined();

    process.env.YOUTUBE_API_KEY = "set-later";
    expect(loadEnv().YOUTUBE_API_KEY).toBe("set-later");

    delete process.env.YOUTUBE_API_KEY;
    expect(loadEnv().YOUTUBE_API_KEY).toBeUndefined();
  });

  it("provides default local scaffold paths", () => {
    const env = loadEnv();
    expect(env.VVUGC_DB_PATH).toContain("review-queue.json");
    expect(env.VVUGC_RUNS_DIR).toContain("runs");
  });

  it("uses SUPABASE_DATABASE_URL as the provider-specific database alias", () => {
    delete process.env.DATABASE_URL;
    process.env.SUPABASE_DATABASE_URL = "postgresql://supabase.example/database";

    expect(loadEnv().DATABASE_URL).toBe("postgresql://supabase.example/database");
  });

  it("prefers the standard DATABASE_URL when both names are set", () => {
    process.env.DATABASE_URL = "postgresql://standard.example/database";
    process.env.SUPABASE_DATABASE_URL = "postgresql://supabase.example/database";

    expect(loadEnv().DATABASE_URL).toBe("postgresql://standard.example/database");
  });
});

describe("validateProductionEnv", () => {
  it("rejects incomplete production configuration", () => {
    expect(() => validateProductionEnv(loadEnv())).toThrow(/Missing:/);
  });

  it("accepts a complete secure production configuration", () => {
    expect(() =>
      validateProductionEnv({
        ...loadEnv(),
        DATABASE_URL: "postgres://example",
        DASHBOARD_USERNAME: "operator",
        DASHBOARD_PASSWORD: "a-secure-password-longer-than-16",
        ASSET_SIGNING_SECRET: "asset-secret",
        SOCIAL_TOKEN_ENCRYPTION_KEY: "social-encryption-key-at-least-32-characters",
        MFA_ENCRYPTION_KEY: "mfa-encryption-key-at-least-32-characters",
        OAUTH_STATE_SECRET: "oauth-state-secret-at-least-32-characters",
        PUBLIC_BASE_URL: "https://app.example.com"
      })
    ).not.toThrow();
  });
});

describe("requireEnvVar", () => {
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
  });

  it("throws a descriptive error when the var is unset", () => {
    delete process.env.YOUTUBE_API_KEY;
    expect(() => requireEnvVar("YOUTUBE_API_KEY")).toThrow(/YOUTUBE_API_KEY/);
  });

  it("returns the value when set", () => {
    process.env.YOUTUBE_API_KEY = "abc";
    expect(requireEnvVar("YOUTUBE_API_KEY")).toBe("abc");
  });

  // requireEnvVar("XAI_API_KEY"|"GROK_API_KEY") only exercises the ambient-env
  // half of resolveXaiOrGrokKeyFrom in this process (dotenvFileValues is always
  // {} under Vitest — see index.ts) — real per-name and cross-alias resolution
  // still exercises requireEnvVar's actual wiring, so both matter.
  afterEach(() => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  it("resolves GROK_API_KEY when only that name is set (ambient env)", () => {
    process.env.GROK_API_KEY = "grok-value";
    expect(requireEnvVar("XAI_API_KEY")).toBe("grok-value");
    expect(requireEnvVar("GROK_API_KEY")).toBe("grok-value");
  });

  it("resolves XAI_API_KEY when only that name is set (ambient env)", () => {
    process.env.XAI_API_KEY = "xai-value";
    expect(requireEnvVar("GROK_API_KEY")).toBe("xai-value");
  });

  it("throws when neither XAI_API_KEY nor GROK_API_KEY is set", () => {
    expect(() => requireEnvVar("XAI_API_KEY")).toThrow(/XAI_API_KEY/);
  });
});

describe("resolveXaiOrGrokKeyFrom — .env vs ambient-shell shadowing guard", () => {
  it("prefers a .env-declared GROK_API_KEY over a same-named ambient XAI_API_KEY (the shadowing bug this guards against)", () => {
    // Reproduces the real incident: a stale personal XAI_API_KEY left set in the
    // OS/shell (unfunded team) must never outrank this project's own working
    // GROK_API_KEY from .env, even though they're aliases of the same credential.
    const dotenvValues = { GROK_API_KEY: "dotenv-grok-key" };
    const ambientEnv = { XAI_API_KEY: "stale-ambient-xai-key" };
    expect(resolveXaiOrGrokKeyFrom("XAI_API_KEY", dotenvValues, ambientEnv)).toBe("dotenv-grok-key");
    expect(resolveXaiOrGrokKeyFrom("GROK_API_KEY", dotenvValues, ambientEnv)).toBe("dotenv-grok-key");
  });

  it("prefers .env's own-name value over .env's alias value", () => {
    const dotenvValues = { XAI_API_KEY: "dotenv-xai", GROK_API_KEY: "dotenv-grok" };
    expect(resolveXaiOrGrokKeyFrom("XAI_API_KEY", dotenvValues, {})).toBe("dotenv-xai");
    expect(resolveXaiOrGrokKeyFrom("GROK_API_KEY", dotenvValues, {})).toBe("dotenv-grok");
  });

  it("falls back to the ambient shell only when .env declares neither name", () => {
    expect(resolveXaiOrGrokKeyFrom("XAI_API_KEY", {}, { GROK_API_KEY: "ambient-grok" })).toBe("ambient-grok");
  });

  it("returns undefined when no source has either name", () => {
    expect(resolveXaiOrGrokKeyFrom("XAI_API_KEY", {}, {})).toBeUndefined();
  });
});

describe("xaiGrokKeyCandidatesFrom — 403-retry candidate ordering", () => {
  it("orders .env values before ambient-shell values, de-duplicated", () => {
    const dotenvValues = { GROK_API_KEY: "dotenv-grok" };
    const ambientEnv = { XAI_API_KEY: "ambient-xai", GROK_API_KEY: "dotenv-grok" };
    expect(xaiGrokKeyCandidatesFrom(dotenvValues, ambientEnv)).toEqual(["dotenv-grok", "ambient-xai"]);
  });

  it("returns every distinct value so a caller can retry a 403 against the next one", () => {
    const candidates = xaiGrokKeyCandidatesFrom(
      { GROK_API_KEY: "funded-dotenv-key" },
      { XAI_API_KEY: "unfunded-ambient-key" }
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe("funded-dotenv-key");
  });

  it("returns an empty array when nothing is configured anywhere", () => {
    expect(xaiGrokKeyCandidatesFrom({}, {})).toEqual([]);
  });
});
