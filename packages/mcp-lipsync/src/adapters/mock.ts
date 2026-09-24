/**
 * Mock LipSync Adapter — Dry-Run
 *
 * Produces a placeholder video file (empty MP4 header) for testing
 * without calling any real lipsync API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LipSyncAdapter, LipSyncInput, LipSyncResult } from "./LipSyncAdapter.js";

export function createMockLipSyncAdapter(): LipSyncAdapter {
  return {
    vendor: "mock",
    async generate(input: LipSyncInput): Promise<LipSyncResult> {
      mkdirSync(input.outDir, { recursive: true });
      const filename = `lipsync-mock-${randomUUID().slice(0, 8)}.mp4`;
      const videoPath = join(input.outDir, filename);

      // Write a minimal placeholder (not a valid MP4, but enough for downstream
      // stages to see a file exists — same pattern as mcp-video-gen's mock adapter).
      const placeholder = Buffer.from(
        "MOCK_LIPSYNC_VIDEO_PLACEHOLDER_" + JSON.stringify({
          characterImageUrl: input.characterImageUrl,
          audioPath: input.audioPath,
          durationSec: input.durationSec,
        })
      );
      writeFileSync(videoPath, placeholder);

      return {
        videoPath,
        vendor: "mock",
        durationSec: input.durationSec,
      };
    },
  };
}
