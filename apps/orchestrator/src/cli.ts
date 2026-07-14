#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { RunConfigSchema, PlatformSchema, type Platform, type RunConfig } from "@vvugc/shared-schema";
import { runCycle } from "./conductor.js";

interface RunOptions {
  niche: string;
  platforms: Platform[];
  brandVoice: string;
  duration: number;
  maxCandidates: number;
  videoVendor: string;
  dryRun: boolean;
  autoPost: boolean;
}

/** Extracted from the commander action handler so option-parsing logic is unit-testable
 *  without invoking commander (which calls process.exit on a bad/missing argument). */
export function parseRunOptions(options: RunOptions): RunConfig {
  return RunConfigSchema.parse({
    runId: nanoid(),
    niche: options.niche,
    platforms: options.platforms,
    brandVoice: options.brandVoice,
    targetDurationSec: options.duration,
    maxCandidates: options.maxCandidates,
    videoVendor: options.videoVendor,
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
    "comma-separated target platforms",
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
    ["tiktok", "youtube_shorts"] as Platform[]
  )
  .option("--brand-voice <voice>", "brand voice descriptor", "neutral, energetic, concise")
  .option("--duration <seconds>", "target output duration in seconds", (v) => Number(v), 25)
  .option("--max-candidates <n>", "max source videos to process", (v) => Number(v), 5)
  .option("--video-vendor <vendor>", "higgsfield | kling | runway | pika", "higgsfield")
  .option("--dry-run", "run the full pipeline with mocked discovery/transcript/video-gen (no API keys needed)", false)
  .option("--auto-post", "skip human review and post directly (NOT recommended; disabled by default)", false)
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

    const result = await runCycle(config);
    console.log(JSON.stringify(result, null, 2));
    console.log(
      `\n${result.reviewItemsCreated} item(s) awaiting human review. Run "pnpm --filter @vvugc/review-dashboard start" and open the dashboard to approve/reject.`
    );
  });

// Only auto-run when this file is executed directly (`tsx src/cli.ts` / the built bin) —
// importing it (e.g. from a test, to reach `parseRunOptions`) must not trigger real argv
// parsing, which commander would otherwise do at module load and can call process.exit() on.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  program.parseAsync(process.argv);
}
