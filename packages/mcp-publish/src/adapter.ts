import type { Platform } from "@vvugc/shared-schema";

export interface PublishRequest {
  /** Local path to the finished, assembled video file (AssembledVideo.filePath). */
  videoPath: string;
  /** Caption/description text — this pipeline passes the script's hook + hashtags. */
  caption: string;
  hashtags?: string[];
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
