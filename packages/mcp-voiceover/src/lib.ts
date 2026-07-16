import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CaptionCue } from "@vvugc/shared-schema";
import { createElevenLabsAdapter } from "./adapters/elevenlabs.js";
import { createGrokAdapter } from "./adapters/grok.js";
import { createMockAdapter } from "./adapters/mock.js";
import type { VoiceoverAdapter, VoiceoverVendor } from "./adapters/VoiceoverAdapter.js";
import { concatAudioTrack, conformAudioDuration } from "./audio-sync.js";
import { probeDurationSec } from "./ffprobe.js";

export type { VoiceoverAdapter, VoiceoverVendor } from "./adapters/VoiceoverAdapter.js";
export { buildAtempoChain, concatAudioTrack, conformAudioDuration } from "./audio-sync.js";
export { probeDurationSec } from "./ffprobe.js";

/**
 * Voiceover is opt-in — `vendor` undefined means "no narration wired up",
 * matching every other stage's --dry-run/unconfigured convention in this repo.
 * Returns undefined in that case rather than throwing, so callers can just
 * check truthiness instead of wrapping every call in a conditional.
 */
export function getVoiceoverAdapter(
  vendor: Exclude<VoiceoverVendor, "mock"> | undefined,
  opts: { dryRun: boolean }
): VoiceoverAdapter | undefined {
  if (!vendor) return undefined;
  if (opts.dryRun) return createMockAdapter();

  switch (vendor) {
    case "elevenlabs":
      return createElevenLabsAdapter();
    case "grok":
      return createGrokAdapter();
  }
}

export interface VoiceoverTrack {
  filePath: string;
  durationSec: number;
}

/**
 * The core "perfect sync" guarantee: synthesizes each caption cue's text
 * separately, force-conforms each one to exactly that cue's [startSec, endSec)
 * window (audio-sync.ts), then concatenates them in order. Because the burned-in
 * captions (mcp-assembly) and this narration both derive from the exact same
 * cue array with the exact same timing, the two can never drift apart — there's
 * no separate "hope the pacing matches" step, the timing is enforced per-cue.
 *
 * Runs once per candidate (not per platform) — captions/script are shared
 * across every target platform for a candidate, so the resulting track is too;
 * see conductor.ts.
 */
export async function generateVoiceoverTrack(
  cues: CaptionCue[],
  adapter: VoiceoverAdapter,
  outDir: string,
  videoId: string
): Promise<VoiceoverTrack> {
  if (cues.length === 0) {
    throw new Error("generateVoiceoverTrack requires at least one caption cue");
  }
  mkdirSync(outDir, { recursive: true });

  const conformedPaths: string[] = [];
  for (const [i, cue] of cues.entries()) {
    const targetDurationSec = cue.endSec - cue.startSec;
    if (targetDurationSec <= 0) {
      throw new Error(
        `generateVoiceoverTrack: caption cue ${i} ("${cue.text}") has a non-positive duration ` +
          `(${targetDurationSec}s, startSec=${cue.startSec}, endSec=${cue.endSec}) — cannot synthesize voiceover for it`
      );
    }

    const rawPath = join(outDir, `${videoId}-cue-${i}-raw.mp3`);
    const { filePath: rawFilePath } = await adapter.synthesize(cue.text, rawPath);

    const conformedPath = join(outDir, `${videoId}-cue-${i}-conformed.mp3`);
    await conformAudioDuration(rawFilePath, targetDurationSec, conformedPath);
    conformedPaths.push(conformedPath);
  }

  const finalPath = join(outDir, `${videoId}-voiceover.mp3`);
  await concatAudioTrack(conformedPaths, finalPath);
  const durationSec = await probeDurationSec(finalPath);

  return { filePath: finalPath, durationSec };
}
