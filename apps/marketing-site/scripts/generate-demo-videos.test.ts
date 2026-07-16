import { describe, expect, it } from "vitest";
import { buildCaptionCues } from "./generate-demo-videos.js";

describe("buildCaptionCues", () => {
  it("covers the full duration exactly, contiguously, with no gaps or overlaps", () => {
    const cues = buildCaptionCues(["short", "a much longer line of text here", "cta"], 20);
    expect(cues[0].startSec).toBe(0);
    expect(cues[cues.length - 1].endSec).toBe(20);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startSec).toBe(cues[i - 1].endSec);
    }
  });

  it("weights longer lines with more time than shorter ones", () => {
    const cues = buildCaptionCues(["hi", "this is a much longer line of narration text"], 20);
    const [short, long] = cues;
    expect(long.endSec - long.startSec).toBeGreaterThan(short.endSec - short.startSec);
  });

  it("clamps every segment to at least the minimum, even with many lines", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
    const cues = buildCaptionCues(lines, 20);
    for (const cue of cues) {
      expect(cue.endSec - cue.startSec).toBeGreaterThan(0);
    }
    expect(cues[cues.length - 1].endSec).toBe(20);
  });

  it("preserves line text and order", () => {
    const lines = ["hook line", "point one", "point two", "cta line"];
    const cues = buildCaptionCues(lines, 20);
    expect(cues.map((c) => c.text)).toEqual(lines);
  });
});
