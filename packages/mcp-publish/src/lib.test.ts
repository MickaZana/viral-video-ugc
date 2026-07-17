import { describe, expect, it } from "vitest";
import { getPublishAdapter } from "./lib.js";

describe("getPublishAdapter", () => {
  it("returns the right adapter for tiktok, facebook, youtube_shorts, and instagram_reels", () => {
    expect(getPublishAdapter("tiktok").platform).toBe("tiktok");
    expect(getPublishAdapter("facebook").platform).toBe("facebook");
    expect(getPublishAdapter("youtube_shorts").platform).toBe("youtube_shorts");
    expect(getPublishAdapter("instagram_reels").platform).toBe("instagram_reels");
  });
});
