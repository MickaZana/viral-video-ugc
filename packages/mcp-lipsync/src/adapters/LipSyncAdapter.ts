/**
 * LipSync Adapter Interface
 *
 * Takes a character image + audio file → produces a video of the character
 * speaking with synced mouth movement.
 */

export type LipSyncVendor = "sync_labs" | "heygen" | "mock";

export interface LipSyncInput {
  /** Path to the voiceover audio file (WAV/MP3 from mcp-voiceover). */
  audioPath: string;
  /** URL to the character's primary reference image (from Soul ID). */
  characterImageUrl: string;
  /** Expected duration of the output video in seconds. */
  durationSec: number;
  /** Output directory for the generated video file. */
  outDir: string;
}

export interface LipSyncResult {
  /** Path to the generated talking-head video file. */
  videoPath: string;
  /** Which vendor produced the video. */
  vendor: LipSyncVendor;
  /** Actual duration of the output video. */
  durationSec: number;
}

export interface LipSyncAdapter {
  readonly vendor: LipSyncVendor;
  generate(input: LipSyncInput): Promise<LipSyncResult>;
}
