import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptionCue } from "@vvugc/shared-schema";
import { createMockAdapter } from "./adapters/mock.js";
import type { VoiceoverAdapter } from "./adapters/VoiceoverAdapter.js";
import { generateVoiceoverTrack, getVoiceoverAdapter } from "./lib.js";
import { probeDurationSec } from "./ffprobe.js";

/** Same silence→tone→silence WAV technique as vad.test.ts — a real TTS vendor
 *  commonly returns audio with exactly this shape (a short pause before/after
 *  the actual words), which is what the VAD trim in generateVoiceoverTrack
 *  exists to remove before conforming. */
function writeToneWav(outPath: string, leadingSilenceSec: number, toneSec: number, trailingSilenceSec: number, sampleRate = 44100): void {
  const blockAlign = 2;
  const leadingSamples = Math.round(leadingSilenceSec * sampleRate);
  const toneSamples = Math.round(toneSec * sampleRate);
  const trailingSamples = Math.round(trailingSilenceSec * sampleRate);
  const dataSize = (leadingSamples + toneSamples + trailingSamples) * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44 + leadingSamples * blockAlign;
  for (let i = 0; i < toneSamples; i++) {
    buffer.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), offset);
    offset += blockAlign;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
}

/** A TTS stand-in that returns real audio with silence padding around a tone —
 *  exercises the VAD trim path in generateVoiceoverTrack, unlike the mock
 *  adapter (adapters/mock.ts), which returns pure silence with nothing to trim. */
function createPaddedToneAdapter(): VoiceoverAdapter {
  return {
    vendor: "mock",
    async synthesize(_text: string, outPath: string) {
      writeToneWav(outPath, 0.4, 1.0, 0.4);
      return { filePath: outPath, durationSec: await probeDurationSec(outPath) };
    }
  };
}

describe("getVoiceoverAdapter", () => {
  it("returns undefined when no vendor is selected — voiceover stays opt-in, not silently on", () => {
    expect(getVoiceoverAdapter(undefined, { dryRun: false })).toBeUndefined();
    expect(getVoiceoverAdapter(undefined, { dryRun: true })).toBeUndefined();
  });

  it("returns the mock adapter for any vendor when dryRun is true, without requiring credentials", () => {
    delete process.env.ELEVENLABS_API_KEY;
    const adapter = getVoiceoverAdapter("elevenlabs", { dryRun: true });
    expect(adapter?.vendor).toBe("mock");
  });

  it("returns the real elevenlabs adapter when vendor='elevenlabs' and not dry-run", () => {
    const adapter = getVoiceoverAdapter("elevenlabs", { dryRun: false });
    expect(adapter?.vendor).toBe("elevenlabs");
  });

  it("returns the real grok adapter when vendor='grok' and not dry-run", () => {
    const adapter = getVoiceoverAdapter("grok", { dryRun: false });
    expect(adapter?.vendor).toBe("grok");
  });
});

describe("generateVoiceoverTrack", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-voiceover-track-test-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  const cues: CaptionCue[] = [
    { text: "Wait, nobody told you this?", startSec: 0, endSec: 2.5 },
    { text: "Here's the first thing that changes everything.", startSec: 2.5, endSec: 8 },
    { text: "And here's why that actually matters.", startSec: 8, endSec: 12.5 },
    { text: "Follow for part 2.", startSec: 12.5, endSec: 14 }
  ];

  it(
    "produces a track whose total duration matches the cues' full time span exactly — the sync guarantee end to end",
    async () => {
      const adapter = createMockAdapter();
      const track = await generateVoiceoverTrack(cues, adapter, testDir, "test-video");

      expect(existsSync(track.filePath)).toBe(true);
      const expectedTotal = cues[cues.length - 1].endSec - cues[0].startSec;
      expect(track.durationSec).toBeCloseTo(expectedTotal, 1);

      // probeDurationSec on the returned path must agree with what was returned —
      // no silent mismatch between what generateVoiceoverTrack reports and reality.
      const reprobed = await probeDurationSec(track.filePath);
      expect(reprobed).toBeCloseTo(track.durationSec, 2);
    },
    30000
  );

  it("rejects an empty cue list", async () => {
    const adapter = createMockAdapter();
    await expect(generateVoiceoverTrack([], adapter, testDir, "test-video")).rejects.toThrow(/at least one caption cue/);
  });

  it("rejects a cue with non-positive duration (startSec >= endSec) with a clear error identifying which cue", async () => {
    const badCues: CaptionCue[] = [{ text: "broken cue", startSec: 5, endSec: 5 }];
    const adapter = createMockAdapter();
    await expect(generateVoiceoverTrack(badCues, adapter, testDir, "test-video")).rejects.toThrow(/cue 0/);
  });

  it(
    "works correctly for a single-cue script (the minimum real case)",
    async () => {
      const singleCue: CaptionCue[] = [{ text: "Just one line.", startSec: 0, endSec: 3 }];
      const adapter = createMockAdapter();
      const track = await generateVoiceoverTrack(singleCue, adapter, testDir, "single");
      expect(track.durationSec).toBeCloseTo(3, 1);
    },
    30000
  );

  it(
    "VAD-trims a raw clip's silence padding before conforming, and still lands on the exact cue window",
    async () => {
      const singleCue: CaptionCue[] = [{ text: "Real TTS audio with padding.", startSec: 0, endSec: 3 }];
      const adapter = createPaddedToneAdapter();
      const track = await generateVoiceoverTrack(singleCue, adapter, testDir, "padded");

      // The trim path only runs (and writes this intermediate file) when
      // detectSpeechBounds found real silence to remove — proves the VAD step
      // actually fired for this adapter's output, not just that it exists in code.
      expect(existsSync(join(testDir, "padded-cue-0-trimmed.mp3"))).toBe(true);
      // The sync guarantee still holds post-trim: final output matches the cue window.
      expect(track.durationSec).toBeCloseTo(3, 1);
    },
    30000
  );
});
