import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAtempoChain, concatAudioTrack, conformAudioDuration } from "./audio-sync.js";
import { probeDurationSec } from "./ffprobe.js";
import { writeSilentWav } from "./silent-wav.js";

describe("buildAtempoChain", () => {
  it("returns a single atempo filter within the [0.5, 2.0] native range", () => {
    expect(buildAtempoChain(1.0)).toEqual(["atempo=1.000000"]);
    expect(buildAtempoChain(1.5)).toEqual(["atempo=1.500000"]);
    expect(buildAtempoChain(0.5)).toEqual(["atempo=0.500000"]);
    expect(buildAtempoChain(2.0)).toEqual(["atempo=2.000000"]);
  });

  it("chains multiple atempo=2.0 filters for a ratio above 2.0, so real ffmpeg accepts it", () => {
    const chain = buildAtempoChain(4.0);
    expect(chain).toEqual(["atempo=2.0", "atempo=2.000000"]);
    // sanity: the chain's product must equal the original ratio
    const product = chain.reduce((acc, f) => acc * Number(f.split("=")[1]), 1);
    expect(product).toBeCloseTo(4.0, 3);
  });

  it("chains multiple atempo=0.5 filters for a ratio below 0.5", () => {
    // 0.2 -> /0.5 -> 0.4 (still < 0.5) -> /0.5 -> 0.8 (now in range)
    const chain = buildAtempoChain(0.2);
    expect(chain).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.800000"]);
    const product = chain.reduce((acc, f) => acc * Number(f.split("=")[1]), 1);
    expect(product).toBeCloseTo(0.2, 3);
  });

  it("rejects a non-positive or non-finite ratio", () => {
    expect(() => buildAtempoChain(0)).toThrow(/positive/);
    expect(() => buildAtempoChain(-1)).toThrow(/positive/);
    expect(() => buildAtempoChain(NaN)).toThrow(/positive/);
    expect(() => buildAtempoChain(Infinity)).toThrow(/positive/);
  });
});

describe("conformAudioDuration (real ffmpeg)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-audio-sync-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "pads shorter audio out to exactly the target duration with silence",
    async () => {
      const inputPath = join(testDir, "short.wav");
      writeSilentWav(inputPath, 1.0);

      const outputPath = join(testDir, "padded.wav");
      await conformAudioDuration(inputPath, 3.0, outputPath);

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(3.0, 1);
    },
    30000
  );

  it(
    "speeds up longer audio (atempo) to exactly the target duration",
    async () => {
      const inputPath = join(testDir, "long.wav");
      writeSilentWav(inputPath, 4.0);

      const outputPath = join(testDir, "sped-up.wav");
      await conformAudioDuration(inputPath, 2.0, outputPath);

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(2.0, 1);
    },
    30000
  );

  it(
    "handles an extreme speedup ratio (>2x, needs atempo chaining) and still lands on target",
    async () => {
      const inputPath = join(testDir, "very-long.wav");
      writeSilentWav(inputPath, 10.0);

      const outputPath = join(testDir, "very-sped-up.wav");
      await conformAudioDuration(inputPath, 1.5, outputPath); // ratio ~6.67x

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(1.5, 1);
    },
    30000
  );

  it(
    "leaves already-correct-duration audio effectively unchanged",
    async () => {
      const inputPath = join(testDir, "exact.wav");
      writeSilentWav(inputPath, 2.0);

      const outputPath = join(testDir, "exact-out.wav");
      await conformAudioDuration(inputPath, 2.0, outputPath);

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(2.0, 1);
    },
    30000
  );

  it("rejects a non-positive target duration", async () => {
    const inputPath = join(testDir, "in.wav");
    writeSilentWav(inputPath, 1.0);
    await expect(conformAudioDuration(inputPath, 0, join(testDir, "out.wav"))).rejects.toThrow(/positive/);
  });
});

describe("concatAudioTrack (real ffmpeg)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-audio-concat-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "concatenates clips in order, producing a track whose duration is the sum of the parts",
    async () => {
      const clip1 = join(testDir, "clip1.wav");
      const clip2 = join(testDir, "clip2.wav");
      const clip3 = join(testDir, "clip3.wav");
      writeSilentWav(clip1, 1.0);
      writeSilentWav(clip2, 2.0);
      writeSilentWav(clip3, 1.5);

      const outputPath = join(testDir, "concatenated.wav");
      await concatAudioTrack([clip1, clip2, clip3], outputPath);

      const actual = await probeDurationSec(outputPath);
      expect(actual).toBeCloseTo(4.5, 1);
    },
    30000
  );

  it("rejects an empty clip list", async () => {
    await expect(concatAudioTrack([], join(testDir, "out.wav"))).rejects.toThrow(/at least one clip/);
  });
});

describe("end-to-end: per-cue conform + concat reproduces the total target duration exactly", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-audio-e2e-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "conforming several mismatched-duration raw clips to their own cue windows, then concatenating, lands on the sum of the cue windows — the exact guarantee the whole voiceover system depends on",
    async () => {
      // Simulates 4 caption cues with real (uneven) target windows, and TTS raw output
      // that doesn't naturally match any of them — exactly the real-world case.
      const cueWindows = [1.2, 3.0, 0.8, 2.5];
      const rawDurations = [0.6, 4.0, 1.5, 2.4]; // deliberately mismatched vs cueWindows

      const conformedPaths: string[] = [];
      for (const [i, targetSec] of cueWindows.entries()) {
        const rawPath = join(testDir, `raw-${i}.wav`);
        writeSilentWav(rawPath, rawDurations[i]);
        const conformedPath = join(testDir, `conformed-${i}.wav`);
        await conformAudioDuration(rawPath, targetSec, conformedPath);
        conformedPaths.push(conformedPath);
      }

      const finalPath = join(testDir, "final.wav");
      await concatAudioTrack(conformedPaths, finalPath);

      const expectedTotal = cueWindows.reduce((a, b) => a + b, 0);
      const actualTotal = await probeDurationSec(finalPath);
      expect(actualTotal).toBeCloseTo(expectedTotal, 1);
    },
    30000
  );
});
