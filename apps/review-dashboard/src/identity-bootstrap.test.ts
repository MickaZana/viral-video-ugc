import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeIdentity } from "./accounts.js";

const previousNodeEnv = process.env.NODE_ENV;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSupabaseUrl = process.env.SUPABASE_DATABASE_URL;

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_DATABASE_URL; else process.env.SUPABASE_DATABASE_URL = previousSupabaseUrl;
  vi.unstubAllEnvs();
});

describe("identity bootstrap", () => {
  it("fails closed rather than selecting filesystem identity in production without DATABASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("SUPABASE_DATABASE_URL", "postgres://provider-specific-fallback-must-not-be-used");
    await expect(initializeIdentity({ VVUGC_RUNS_DIR: "unused" } as ReturnType<typeof import("@vvugc/shared-config").loadEnv>)).rejects.toThrow(/DATABASE_URL is required/);
  });
});
