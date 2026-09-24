import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfiguredPostgresProviderJobStore } from "./provider-jobs.js";

const priorNodeEnv = process.env.NODE_ENV;
const priorDatabaseUrl = process.env.DATABASE_URL;
const priorSupabaseDatabaseUrl = process.env.SUPABASE_DATABASE_URL;

afterEach(() => {
  vi.unstubAllEnvs();
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorSupabaseDatabaseUrl === undefined) delete process.env.SUPABASE_DATABASE_URL; else process.env.SUPABASE_DATABASE_URL = priorSupabaseDatabaseUrl;
});

describe("configured provider-job store", () => {
  it("refuses file provider-job persistence in production without DATABASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("SUPABASE_DATABASE_URL", "");
    await expect(getConfiguredPostgresProviderJobStore()).rejects.toThrow(/DATABASE_URL is required/);
  });
});
