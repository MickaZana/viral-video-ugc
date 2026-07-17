import type { Platform } from "@vvugc/shared-schema";

export interface PublishRequest {
  /** Local path to the finished, assembled video file (AssembledVideo.filePath). */
  videoPath: string;
  /** Caption/description text — this pipeline passes the script's hook + hashtags. */
  caption: string;
  hashtags?: string[];
  /**
   * A publicly reachable URL for the same video at videoPath, required only by
   * adapters whose vendor API fetches the video itself rather than accepting
   * uploaded bytes (Instagram Reels). See apps/review-dashboard/src/public-assets.ts.
   */
  publicVideoUrl?: string;
}

export interface PublishResult {
  platform: Platform;
  /** Platform-assigned id for the created post/video. */
  postId: string;
  /** Public URL to the post, when the platform's response includes one. */
  url?: string;
}

export interface PublishAdapter {
  readonly platform: Platform;
  publish(req: PublishRequest): Promise<PublishResult>;
}
