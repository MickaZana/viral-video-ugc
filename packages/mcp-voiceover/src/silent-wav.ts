import { writeFileSync } from "node:fs";

/**
 * Writes a valid, minimal silent WAV file — used instead of ffmpeg's `lavfi`
 * anullsrc input device (the "generate silence" approach used elsewhere), because
 * fluent-ffmpeg 2.1.3 can't parse ffmpeg 8.x's `-formats` output for lavfi (it
 * gained an extra device-capability flag column fluent-ffmpeg's regex predates —
 * confirmed via `ffmpeg -formats | grep lavfi` showing " D d lavfi" instead of the
 * two-character "DE " flags fluent-ffmpeg expects), so it reports the format
 * "not available" even when the real ffmpeg binary handles it fine. Writing the
 * WAV bytes directly sidesteps that entirely — no ffmpeg dependency for this at
 * all, and the standard PCM WAV format ffmpeg/ffprobe read without any special
 * demuxer capability checks.
 */
export function writeSilentWav(outPath: string, durationSec: number, sampleRate = 44100): void {
  if (durationSec <= 0) throw new Error(`writeSilentWav: durationSec must be positive, got ${durationSec}`);

  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const numSamples = Math.round(durationSec * sampleRate);
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize); // zero-filled by default — that's the silence

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: 1 = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  writeFileSync(outPath, buffer);
}
