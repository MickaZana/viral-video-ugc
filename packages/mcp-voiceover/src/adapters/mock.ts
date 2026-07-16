import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { probeDurationSec } from "../ffprobe.js";
import { writeSilentWav } from "../silent-wav.js";
import type { VoiceoverAdapter } from "./VoiceoverAdapter.js";

/**
 * Generates real (silent) audio of a plausible length for --dry-run — a plain
 * placeholder text file wouldn't have a real duration ffprobe could read, and
 * audio-sync.ts needs a real duration to conform against, the same way the rest
 * of the --dry-run path still exercises real ffmpeg where it matters (see
 * mcp-assembly's dry-run branch, which skips ffmpeg entirely instead — this
 * adapter deliberately doesn't skip it, so the voiceover pipeline's timing logic
 * gets exercised even without real vendor credentials).
 *
 * Duration is estimated from word count at a natural speaking pace (~150
 * words/minute) so it's in the right ballpark, not a fixed arbitrary length.
 */
export function createMockAdapter(): VoiceoverAdapter {
  return {
    vendor: "mock",
    async synthesize(text: string, outPath: string): Promise<{ filePath: string; durationSec: number }> {
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      const estimatedDurationSec = Math.max(0.5, (wordCount / 150) * 60);

      mkdirSync(dirname(outPath), { recursive: true });
      writeSilentWav(outPath, estimatedDurationSec);
      const durationSec = await probeDurationSec(outPath);
      return { filePath: outPath, durationSec };
    }
  };
}
