import type { VideoGenRequest } from "./adapters/VideoGenAdapter.js";
import type { Dimensions } from "./ken-burns.js";

/** Pixel dimensions per aspect ratio — mirrors packages/mcp-assembly's DIMENSIONS table,
 *  not imported from it since mcp-video-gen doesn't otherwise depend on mcp-assembly. */
export const DIMENSIONS_BY_ASPECT_RATIO: Record<VideoGenRequest["aspectRatio"], Dimensions> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 }
};
