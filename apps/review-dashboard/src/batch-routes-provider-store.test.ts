import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeBatchProviderJobStore } from "./batch-routes.js";

const previousNodeEnv = process.env.NODE_ENV;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSupabaseUrl = process.env.SUPABASE_DATABASE_URL;

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_DATABASE_URL; else process.env.SUPABASE_DATABASE_URL = previousSupabaseUrl;
});

describe("batch provider-job handoff", () => {
  it("cannot initialize an in-memory batch handoff in production without DATABASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("SUPABASE_DATABASE_URL", "");
    await expect(initializeBatchProviderJobStore()).rejects.toThrow(/DATABASE_URL is required/);
  });
});
