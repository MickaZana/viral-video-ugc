import { describe, expect, it } from "vitest";
import { parseSourceUrl, candidateFromSource, type SourceUrl } from "./remix-source.js";

describe("parseSourceUrl", () => {
  it("parses standard YouTube watch URLs", () => {
    expect(parseSourceUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      platform: "youtube_shorts",
      videoId: "dQw4w9WgXcQ"
    });
  });

  it("parses YouTube Shorts URLs", () => {
    expect(parseSourceUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toEqual({
      platform: "youtube_shorts",
      videoId: "dQw4w9WgXcQ"
    });
  });

  it("parses YouTube live URLs", () => {
    expect(parseSourceUrl("https://www.youtube.com/live/L2CgXWTV2ls")).toEqual({
      platform: "youtube_shorts",
      videoId: "L2CgXWTV2ls"
    });
  });

  it("parses youtu.be share links", () => {
    expect(parseSourceUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      platform: "youtube_shorts",
      videoId: "dQw4w9WgXcQ"
    });
  });

  it("parses TikTok video URLs", () => {
    expect(parseSourceUrl("https://www.tiktok.com/@user/video/7123456789012345678")).toEqual({
      platform: "tiktok",
      videoId: "7123456789012345678"
    });
  });

  it("parses Instagram Reels URLs", () => {
    expect(parseSourceUrl("https://www.instagram.com/reel/CxAbCdEfGhI/")).toEqual({
      platform: "instagram_reels",
      videoId: "CxAbCdEfGhI"
    });
  });

  it("parses Instagram post URLs", () => {
    expect(parseSourceUrl("https://www.instagram.com/p/CxAbCdEfGhI/")).toEqual({
      platform: "instagram_reels",
      videoId: "CxAbCdEfGhI"
    });
  });

  it("strips www and trailing query strings", () => {
    expect(parseSourceUrl("https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toEqual({
      platform: "youtube_shorts",
      videoId: "dQw4w9WgXcQ"
    });
  });

  it("returns undefined for unsupported hosts and malformed input", () => {
    expect(parseSourceUrl("https://vimeo.com/123456789")).toBeUndefined();
    expect(parseSourceUrl("not a url")).toBeUndefined();
    expect(parseSourceUrl("https://youtube.com/watch?v=notavalidid11")).toBeUndefined();
  });
});

describe("candidateFromSource", () => {
  it("builds a discovery-shaped candidate tagged with the source platform", () => {
    const parsed: SourceUrl = { platform: "youtube_shorts", videoId: "dQw4w9WgXcQ" };
    const cand = candidateFromSource("https://youtu.be/dQw4w9WgXcQ", parsed, "fitness");
    expect(cand.id).toBe("dQw4w9WgXcQ");
    expect(cand.platform).toBe("youtube_shorts");
    expect(cand.niche).toBe("fitness");
    expect(cand.url).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(cand.metrics.views).toBe(0);
  });
});
