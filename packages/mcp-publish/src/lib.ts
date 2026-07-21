import type { Platform } from "@vvugc/shared-schema";
import type { PublishAdapter } from "./adapter.js";
import { createTikTokPublishAdapter } from "./tools/tiktok.js";
import { createFacebookPagePublishAdapter, createInstagramReelsPublishAdapter } from "./tools/meta.js";
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
export interface PublishCredentials {
  accessToken?: string;
}

export function getPublishAdapter(platform: Platform, credentials: PublishCredentials = {}): PublishAdapter {
  switch (platform) {
    case "tiktok":
      return createTikTokPublishAdapter();
    case "facebook":
      return createFacebookPagePublishAdapter();
    case "youtube_shorts":
      return createYouTubePublishAdapter({ accessToken: credentials.accessToken });
    case "instagram_reels":
      return createInstagramReelsPublishAdapter();
    default:
      // Exhaustive over Platform today, but an explicit fallthrough (rather than relying on
      // switch-exhaustiveness narrowing alone) keeps this a clear error instead of an
      // implicit-undefined return if a new Platform value is ever added without a case here.
      throw new Error(`No publish adapter for platform: ${platform}`);
  }
}
