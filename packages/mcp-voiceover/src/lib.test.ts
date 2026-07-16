import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptionCue } from "@vvugc/shared-schema";
import { createMockAdapter } from "./adapters/mock.js";
import { generateVoiceoverTrack, getVoiceoverAdapter } from "./lib.js";
import { probeDurationSec } from "./ffprobe.js";

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
});
