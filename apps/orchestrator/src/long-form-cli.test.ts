import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LongFormTutorial } from "@vvugc/shared-schema";
import { deriveLongFormCaptionCues, parseLongFormCliOptions, renderLongFormTutorial } from "./long-form-cli.js";

function tutorial(assetPath: string): LongFormTutorial {
  return {
    platform: "youtube_long",
    title: "How these tools can help",
    durationSec: 300,
    aspectRatio: "16:9",
    scenes: [
      {
        narration: "These tools can help you create a repeatable workflow. This is illustrative, not proof of earnings.",
        durationSec: 120,
        assetType: "screen_recording",
        assetPath,
        source: "Creator recording",
        proofStatus: "illustrative"
      },
      {
        narration: "Record verified results only when you have the underlying source evidence available for review.",
        durationSec: 180,
        assetType: "screenshot",
        assetPath,
        source: "Creator evidence archive",
        proofStatus: "required_before_release"
      }
    ]
  };
}

describe("deriveLongFormCaptionCues", () => {
  it("splits narration into at most twelve-word contiguous cards covering every scene exactly", () => {
    const cues = deriveLongFormCaptionCues(tutorial("/placeholder.mp4"));
    expect(cues.every((cue) => cue.text.split(/\s+/).length <= 12)).toBe(true);
    expect(cues[0]?.startSec).toBe(0);
    expect(cues.at(-1)?.endSec).toBe(300);
    for (const [index, cue] of cues.entries()) {
      if (index > 0) expect(cue.startSec).toBe(cues[index - 1]?.endSec);
    }
  });
});

describe("renderLongFormTutorial", () => {
  it("dry-runs safely with missing placeholder assets and leaves voiceover undefined when omitted", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vvugc-long-form-cli-"));
    try {
      const tutorialPath = join(workDir, "tutorial.json");
      writeFileSync(tutorialPath, JSON.stringify(tutorial(join(workDir, "missing-placeholder.mp4"))));
      const result = await renderLongFormTutorial({ tutorialPath, outDir: join(workDir, "out"), dryRun: true });
      expect(result.assembly.platform).toBe("youtube_long");
      expect(result.assembly.durationSec).toBe(300);
      expect(result.voiceoverPath).toBeUndefined();
      expect(result.assembly.voiceoverAdded).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("parseLongFormCliOptions", () => {
  it("maps the required --tutorial option to the renderer tutorialPath", () => {
    const parsed = parseLongFormCliOptions({
      tutorial: "docs/tutorial.json",
      outDir: "out",
      voiceVendor: "grok",
      dryRun: true
    });
    expect(parsed.tutorialPath).toMatch(/docs[\\/]tutorial\.json$/);
    expect(parsed.outDir).toMatch(/out$/);
    expect(isAbsolute(parsed.tutorialPath)).toBe(true);
    expect(parsed.voiceVendor).toBe("grok");
    expect(parsed.dryRun).toBe(true);
  });
});
