import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeDurationSec } from "./ffprobe.js";
import { writeSilentWav } from "./silent-wav.js";
import { detectSpeechBounds, trimAudio } from "./vad.js";

/**
 * Writes silence → a real audible 440Hz tone → silence, as one WAV file — the
 * same direct-byte-writing technique as silent-wav.ts (see its comment for why
 * fluent-ffmpeg's lavfi generator can't be used here), extended to produce an
 * actual signal `silencedetect` can distinguish from silence, without needing
 * real speech audio or a TTS call in tests.
 */
function writeToneWav(outPath: string, leadingSilenceSec: number, toneSec: number, trailingSilenceSec: number, sampleRate = 44100): void {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const leadingSamples = Math.round(leadingSilenceSec * sampleRate);
  const toneSamples = Math.round(toneSec * sampleRate);
  const trailingSamples = Math.round(trailingSilenceSec * sampleRate);
  const totalSamples = leadingSamples + toneSamples + trailingSamples;
  const dataSize = totalSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize); // zero-filled — that's the silence regions
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  const freq = 440;
  const amplitude = 16000;
  let offset = 44 + leadingSamples * blockAlign;
  for (let i = 0; i < toneSamples; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buffer.writeInt16LE(sample, offset);
    offset += blockAlign;
  }
  // trailing silence region is left as the zero-fill from Buffer.alloc

  writeFileSync(outPath, buffer);
}

describe("detectSpeechBounds (real ffmpeg)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-vad-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "finds the tone's real start/end, trimming leading and trailing silence",
    async () => {
      const inputPath = join(testDir, "tone.wav");
      writeToneWav(inputPath, 1.0, 2.0, 1.0);

      const bounds = await detectSpeechBounds(inputPath);
      expect(bounds).not.toBeNull();
      expect(bounds!.startSec).toBeGreaterThan(0.5);
      expect(bounds!.startSec).toBeLessThan(1.3);
      expect(bounds!.endSec).toBeGreaterThan(2.7);
      expect(bounds!.endSec).toBeLessThan(3.3);
    },
    30000
  );

  it(
    "returns null (nothing to trim) for a clip with no leading/trailing silence",
    async () => {
      const inputPath = join(testDir, "tone-only.wav");
      writeToneWav(inputPath, 0, 2.0, 0);

      const bounds = await detectSpeechBounds(inputPath);
      expect(bounds).toBeNull();
    },
    30000
  );

  it(
    "returns null for an entirely silent clip — nothing worth trimming to",
    async () => {
      const inputPath = join(testDir, "silent.wav");
      writeSilentWav(inputPath, 2.0);

      const bounds = await detectSpeechBounds(inputPath);
      expect(bounds).toBeNull();
    },
    30000
  );

  it(
    "fails open (returns null) for a nonexistent file rather than throwing",
    async () => {
      const bounds = await detectSpeechBounds(join(testDir, "does-not-exist.wav"));
      expect(bounds).toBeNull();
    },
    30000
  );
});

describe("trimAudio (real ffmpeg)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-vad-trim-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "trims to exactly the requested span",
    async () => {
      const inputPath = join(testDir, "tone.wav");
      writeToneWav(inputPath, 1.0, 2.0, 1.0);

      const outputPath = join(testDir, "trimmed.wav");
      await trimAudio(inputPath, 1.0, 3.0, outputPath);

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(2.0, 1);
    },
    30000
  );

  it("rejects endSec <= startSec", async () => {
    const inputPath = join(testDir, "tone.wav");
    writeToneWav(inputPath, 0, 1.0, 0);
    await expect(trimAudio(inputPath, 1.0, 1.0, join(testDir, "out.wav"))).rejects.toThrow(/endSec/);
  });
});
