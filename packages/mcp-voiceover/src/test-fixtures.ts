import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSilentWav } from "./silent-wav.js";

/** Generates a real, ffprobe-parseable silent WAV file for tests that need
 *  actual audio bytes (not hand-crafted guesses at a container format) — e.g.
 *  mocking a TTS vendor's binary response, or exercising audio-sync.ts's real
 *  ffmpeg calls. See silent-wav.ts for why this is plain WAV bytes, not ffmpeg's
 *  own lavfi silence generator. */
export function makeSilentAudioFixture(dir: string, durationSec: number, filename = "silent.wav"): Buffer {
  const fixturePath = join(dir, filename);
  writeSilentWav(fixturePath, durationSec);
  return readFileSync(fixturePath);
}
