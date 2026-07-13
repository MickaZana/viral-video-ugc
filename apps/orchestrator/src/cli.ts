#!/usr/bin/env node
import { Command } from "commander";
import { nanoid } from "nanoid";
import { RunConfigSchema, PlatformSchema, type Platform } from "@vvugc/shared-schema";
import { runCycle } from "./conductor.js";

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
    (val: string) => val.split(",").map((p) => PlatformSchema.parse(p.trim())) as Platform[],
    ["tiktok", "youtube_shorts"] as Platform[]
  )
  .option("--brand-voice <voice>", "brand voice descriptor", "neutral, energetic, concise")
  .option("--duration <seconds>", "target output duration in seconds", (v) => Number(v), 25)
  .option("--max-candidates <n>", "max source videos to process", (v) => Number(v), 5)
  .option("--video-vendor <vendor>", "higgsfield | kling | runway | pika", "higgsfield")
  .option("--dry-run", "run the full pipeline with mocked discovery/transcript/video-gen (no API keys needed)", false)
  .option("--auto-post", "skip human review and post directly (NOT recommended; disabled by default)", false)
  .action(async (options) => {
    const config = RunConfigSchema.parse({
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

program.parseAsync(process.argv);
