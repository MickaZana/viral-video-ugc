#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  CaptionCueSchema,
  LongFormTutorialSchema,
  type CaptionCue,
  type LongFormTutorial
} from "@vvugc/shared-schema";
import {
  assembleLongFormTutorial,
  type LongFormAssemblyResult
} from "@vvugc/mcp-assembly";
import {
  generateVoiceoverTrack,
  getVoiceoverAdapter,
  type VoiceoverVendor
} from "@vvugc/mcp-voiceover";

const MAX_WORDS_PER_CARD = 12;
type SelectedVoiceVendor = Exclude<VoiceoverVendor, "mock">;

export interface LongFormRenderOptions {
  tutorialPath: string;
  outDir: string;
  voiceVendor?: SelectedVoiceVendor;
  dryRun?: boolean;
}

export interface LongFormRenderResult {
  tutorial: LongFormTutorial;
  captions: CaptionCue[];
  voiceoverPath?: string;
  assembly: LongFormAssemblyResult;
}

export interface LongFormCliOptions {
  tutorial: string;
  outDir: string;
  voiceVendor?: SelectedVoiceVendor;
  dryRun?: boolean;
}

/** Maps Commander option names onto the renderer's explicit file-path contract. */
export function parseLongFormCliOptions(options: LongFormCliOptions): LongFormRenderOptions {
  // pnpm runs a filtered package script from apps/orchestrator. Resolve relative
  // CLI paths from the workspace root so documented `docs/...` and `.tmp/...`
  // paths mean the same thing when invoked through `pnpm --filter`.
  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const workspacePath = (path: string) => isAbsolute(path) ? path : join(workspaceRoot, path);
  return {
    tutorialPath: workspacePath(options.tutorial),
    outDir: workspacePath(options.outDir),
    voiceVendor: options.voiceVendor,
    dryRun: options.dryRun
  };
}

function splitNarration(narration: string): string[] {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const cards: string[] = [];
  for (let index = 0; index < words.length; index += MAX_WORDS_PER_CARD) {
    cards.push(words.slice(index, index + MAX_WORDS_PER_CARD).join(" "));
  }
  return cards;
}

/**
 * Turns a caller-authored tutorial into subtitle/voice cards without an LLM.
 * Each scene's cards are allocated across that scene only, so every source asset
 * remains on screen while its own narration is spoken.
 */
export function deriveLongFormCaptionCues(tutorial: LongFormTutorial): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let sceneStartSec = 0;

  for (const scene of tutorial.scenes) {
    const cards = splitNarration(scene.narration);
    const sceneEndSec = sceneStartSec + scene.durationSec;
    for (const [index, text] of cards.entries()) {
      const startSec = sceneStartSec + (scene.durationSec * index) / cards.length;
      // Pin every final card to its scene boundary. This prevents accumulated
      // floating-point error from leaving a tail gap before the next scene.
      const endSec = index === cards.length - 1
        ? sceneEndSec
        : sceneStartSec + (scene.durationSec * (index + 1)) / cards.length;
      cues.push(CaptionCueSchema.parse({ startSec, endSec, text }));
    }
    sceneStartSec = sceneEndSec;
  }

  assertContiguousLongFormCaptionCues(cues, tutorial.durationSec);
  return cues;
}

/** Throws unless cues cover the whole tutorial exactly, with neither gaps nor overlaps. */
export function assertContiguousLongFormCaptionCues(cues: CaptionCue[], durationSec: number): void {
  if (cues.length === 0) throw new Error("Long-form tutorial must produce at least one caption cue");
  let expectedStartSec = 0;
  for (const [index, cue] of cues.entries()) {
    if (cue.startSec !== expectedStartSec || cue.endSec <= cue.startSec) {
      throw new Error(`Long-form caption cue ${index} is not contiguous`);
    }
    expectedStartSec = cue.endSec;
  }
  if (expectedStartSec !== durationSec) {
    throw new Error(`Long-form caption cues end at ${expectedStartSec}s, expected ${durationSec}s`);
  }
}

function tutorialVoiceId(tutorial: LongFormTutorial): string {
  const stem = tutorial.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return stem || "long-form-tutorial";
}

/**
 * Local-only renderer. It deliberately has no discovery, generation, publishing,
 * or review-queue imports; the only possible network call is selected live TTS.
 */
export async function renderLongFormTutorial(options: LongFormRenderOptions): Promise<LongFormRenderResult> {
  const tutorial = LongFormTutorialSchema.parse(JSON.parse(readFileSync(options.tutorialPath, "utf8")));
  const captions = deriveLongFormCaptionCues(tutorial);
  let voiceoverPath: string | undefined;

  if (options.voiceVendor) {
    const adapter = getVoiceoverAdapter(options.voiceVendor, { dryRun: options.dryRun ?? false });
    // getVoiceoverAdapter only returns undefined when vendor is omitted; retaining
    // this guard makes the no-narration path explicit and future-proof.
    if (adapter) {
      const track = await generateVoiceoverTrack(
        captions,
        adapter,
        join(options.outDir, "voiceover"),
        tutorialVoiceId(tutorial)
      );
      voiceoverPath = track.filePath;
    }
  }

  const assembly = await assembleLongFormTutorial({
    tutorial,
    outDir: options.outDir,
    captions,
    voiceoverPath,
    dryRun: options.dryRun ?? false
  });
  return { tutorial, captions, voiceoverPath, assembly };
}

function parseVoiceVendor(value: string): SelectedVoiceVendor {
  if (value === "grok" || value === "elevenlabs") return value;
  throw new InvalidArgumentError("--voice-vendor must be grok or elevenlabs");
}

const program = new Command();
program
  .name("vvugc-long-form")
  .description("Render a local, source-attributed 16:9 YouTube tutorial without the Shorts pipeline.")
  .requiredOption("--tutorial <path>", "path to a LongFormTutorial JSON file")
  .requiredOption("--out-dir <path>", "directory for rendered output")
  .option("--voice-vendor <vendor>", "grok | elevenlabs — optional synchronized narration", parseVoiceVendor)
  .option("--dry-run", "validate the tutorial and return mock assembly metadata without ffmpeg", false)
  .action(async (options: LongFormCliOptions) => {
    try {
      const result = await renderLongFormTutorial(parseLongFormCliOptions(options));
      console.log(`Long-form tutorial ready: ${result.assembly.filePath}`);
      console.log(`Captions: ${result.captions.length}; voiceover: ${result.voiceoverPath ?? "none"}`);
    } catch (error) {
      console.error(`Long-form render failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) program.parseAsync(process.argv);
