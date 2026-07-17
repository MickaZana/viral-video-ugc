#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { RunConfigSchema, PlatformSchema, type Platform, type RunConfig, type RunResult } from "@vvugc/shared-schema";
import { runCycle } from "./conductor.js";

interface RunOptions {
  niche: string;
  platforms: Platform[];
  brandVoice: string;
  locale: string;
  duration: number;
  maxCandidates: number;
  videoVendor: string;
  voiceVendor?: string;
  dryRun: boolean;
  autoPost: boolean;
}

/**
 * A run that completes without throwing but produces zero review items is a silent
 * failure — every candidate hit discovery/QA/vendor trouble, nothing reached the
 * queue, yet the process would otherwise exit 0. `--fail-on-zero-results` (used by
 * `.github/workflows/weekly-run.yml`'s scheduled runs) turns that into a real exit
 * code so GitHub's built-in "notify on scheduled workflow failure" actually fires —
 * no new alerting infra needed, just making an already-existing silent case loud.
 * Exported/pure so this policy is unit-testable without spinning up a real run.
 */
export function determineExitCode(result: RunResult, failOnZeroResults: boolean): number {
  if (failOnZeroResults && result.reviewItemsCreated === 0) return 1;
  return 0;
}

/** Extracted from the commander action handler so option-parsing logic is unit-testable
 *  without invoking commander (which calls process.exit on a bad/missing argument). */
export function parseRunOptions(options: RunOptions): RunConfig {
  return RunConfigSchema.parse({
    runId: nanoid(),
    niche: options.niche,
    platforms: options.platforms,
    brandVoice: options.brandVoice,
    locale: options.locale,
    targetDurationSec: options.duration,
    maxCandidates: options.maxCandidates,
    videoVendor: options.videoVendor,
    voiceVendor: options.voiceVendor,
    dryRun: options.dryRun,
    autoPost: options.autoPost,
    createdAt: new Date().toISOString()
  });
}

const program = new Command();

program
  .name("vvugc")
  .description("Discover, repurpose, and generate short-form video from viral content, end to end.");

program
  .command("run")
  .description('Run one full pipeline cycle for a niche, e.g. "run viral pipeline for niche=fitness"')
  .requiredOption("--niche <niche>", "target content niche, e.g. fitness")
  .option(
    "--platforms <platforms>",
    "comma-separated target platforms (tiktok/instagram_reels/facebook require approved API " +
      "access not yet configured — see README's Platform support section; --dry-run works for all of them)",
    (val: string) =>
      val.split(",").map((p) => {
        const parsed = PlatformSchema.safeParse(p.trim());
        if (!parsed.success) {
          throw new InvalidArgumentError(
            `"${p.trim()}" is not a valid platform. Choose from: ${PlatformSchema.options.join(", ")}.`
          );
        }
        return parsed.data;
      }) as Platform[],
    // youtube_shorts only — the sole platform with live discovery wired up today (see
    // packages/mcp-discovery/src/tools/{tiktok,meta}.ts). Defaulting to a platform that
    // can't produce results in live mode would silently waste a run.
    ["youtube_shorts"] as Platform[]
  )
  .option("--brand-voice <voice>", "brand voice descriptor", "neutral, energetic, concise")
  .option("--locale <locale>", "BCP-47-ish language tag for the rewritten script, e.g. en, es, pt-BR", "en")
  .option("--duration <seconds>", "target output duration in seconds", (v) => Number(v), 25)
  .option("--max-candidates <n>", "max source videos to process", (v) => Number(v), 5)
  .option(
    "--video-vendor <vendor>",
    "higgsfield | kling | runway | pika | gemini — gemini generates a still image per script " +
      "segment (Gemini API) and Ken-Burns-pans it into a clip, instead of calling a video vendor",
    "higgsfield"
  )
  .option(
    "--voice-vendor <vendor>",
    "elevenlabs | grok — adds narrated voiceover perfectly synced to the burned-in captions " +
      "(each caption cue's audio is synthesized separately and time-conformed to that exact " +
      "cue's window, so narration and captions can never drift). Omit to keep the current " +
      "silent/vendor-native-audio behavior — this is fully opt-in.",
    undefined
  )
  .option("--dry-run", "run the full pipeline with mocked discovery/transcript/video-gen (no API keys needed)", false)
  .option("--auto-post", "skip human review and post directly (NOT recommended; disabled by default)", false)
  .option(
    "--fail-on-zero-results",
    "exit non-zero if the run completes but produces zero review items (a silent-failure case " +
      "otherwise indistinguishable from a normal empty run) — intended for scheduled/CI runs so " +
      "the platform's own failure notification catches it, not for interactive local use",
    false
  )
  .action(async (options) => {
    let config: RunConfig;
    try {
      config = parseRunOptions(options);
    } catch (err) {
      if (err instanceof ZodError) {
        console.error("error: invalid options —");
        for (const issue of err.issues) {
          console.error(`  ${issue.path.join(".") || "(value)"}: ${issue.message}`);
        }
      } else {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }

    if (config.autoPost) {
      console.warn(
        "WARNING: --auto-post bypasses human review. This scaffold does not implement platform " +
          "publishing APIs yet — review items will still be written to the queue instead."
      );
    }

    const unsupportedLivePlatforms = config.platforms.filter((p) => p !== "youtube_shorts");
    if (!config.dryRun && unsupportedLivePlatforms.length > 0) {
      console.warn(
        `WARNING: ${unsupportedLivePlatforms.join(", ")} discovery requires approved API access ` +
          "this scaffold doesn't have configured (TikTok Research API / Meta Graph API — see README's " +
          "Platform support section). These platforms will produce zero candidates this run; only " +
          "youtube_shorts is live. Use --dry-run to exercise the full pipeline for all platforms with mock data."
      );
    }

    // Progress lines, not a silent wait — a live run hits several vendor APIs and
    // can take minutes; with nothing printed in between, a terminal looks hung.
    let result: RunResult;
    try {
      result = await runCycle(config, { onProgress: (message) => console.log(message) });
    } catch (err) {
      console.error(`\nRun failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `\n${result.reviewItemsCreated} item(s) awaiting human review. Run "pnpm --filter @vvugc/review-dashboard start" and open the dashboard to approve/reject.`
    );
    if ((result.candidatesFailed ?? 0) > 0 || (result.platformsFailed ?? 0) > 0) {
      console.log(
        `(${result.candidatesFailed ?? 0} candidate(s), ${result.platformsFailed ?? 0} platform(s) failed this run — see above for why.)`
      );
    }
    if (result.estimatedCostUsd !== undefined) {
      console.log(`Estimated vendor spend this run: $${result.estimatedCostUsd.toFixed(4)} (see ${result.costLedgerPath})`);
    }
    console.log(`Full run details (JSON): ${result.manifestPath}`);

    const exitCode = determineExitCode(result, options.failOnZeroResults);
    if (exitCode !== 0) {
      console.error(`\nRun produced zero review items — failing (--fail-on-zero-results was set).`);
      process.exitCode = exitCode;
    }
  });

// Only auto-run when this file is executed directly (`tsx src/cli.ts` / the built bin) —
// importing it (e.g. from a test, to reach `parseRunOptions`) must not trigger real argv
// parsing, which commander would otherwise do at module load and can call process.exit() on.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  program.parseAsync(process.argv);
}
