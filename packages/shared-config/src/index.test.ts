import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, requireEnvVar, validateProductionEnv } from "./index.js";

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
});
