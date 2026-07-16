import type { Platform } from "@vvugc/shared-schema";
import type { PublishAdapter } from "./adapter.js";
import { createTikTokPublishAdapter } from "./tools/tiktok.js";
import { createFacebookPagePublishAdapter } from "./tools/meta.js";
import { createYouTubePublishAdapter } from "./tools/youtube.js";

export type { PublishAdapter, PublishRequest, PublishResult } from "./adapter.js";

/**
 * No mock/--dry-run branch here, unlike every other vendor stage in this pipeline —
 * publishing is deliberately never called automatically by conductor.ts (see
 * docs/architecture.md's human-review-gate note: "No stage posts to any platform").
 * These adapters only exist to be called explicitly, after a human approves an item
 * (see apps/review-dashboard's POST /queue/:id/publish) — there's no run-time code
 * path that could accidentally post something unapproved.
 */
export function getPublishAdapter(platform: Platform): PublishAdapter {
  switch (platform) {
    case "tiktok":
      return createTikTokPublishAdapter();
    case "facebook":
      return createFacebookPagePublishAdapter();
    case "youtube_shorts":
      return createYouTubePublishAdapter();
    case "instagram_reels":
      throw new Error(
        "Instagram Reels publishing is not implemented — its Content Publishing API requires a " +
          "publicly reachable video_url, which this pipeline can't supply (finished videos are local " +
          "files with no public asset host). See packages/mcp-publish/src/tools/meta.ts for the detail."
      );
  }
}
