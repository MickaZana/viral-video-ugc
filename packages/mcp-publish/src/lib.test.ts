import { describe, expect, it } from "vitest";
import { getPublishAdapter } from "./lib.js";

describe("getPublishAdapter", () => {
  it("returns the right adapter for tiktok, facebook, and youtube_shorts", () => {
    expect(getPublishAdapter("tiktok").platform).toBe("tiktok");
    expect(getPublishAdapter("facebook").platform).toBe("facebook");
    expect(getPublishAdapter("youtube_shorts").platform).toBe("youtube_shorts");
  });

  it("throws a clear, specific error for instagram_reels (needs a public asset host this pipeline doesn't have)", () => {
    expect(() => getPublishAdapter("instagram_reels")).toThrow(/publicly reachable video_url/);
  });
});
