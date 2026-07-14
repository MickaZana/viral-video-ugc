import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, requireEnvVar } from "./index.js";

describe("loadEnv", () => {
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
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
