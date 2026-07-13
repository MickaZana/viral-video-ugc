import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import pino from "pino";
import type { CandidateVideo, RawClip, ReviewItem, RunConfig, RunResult } from "@vvugc/shared-schema";
import { RunResultSchema } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { discoverPlatform, mockCandidates } from "@vvugc/mcp-discovery";
import { transcribeCandidate, mockTranscript } from "@vvugc/mcp-transcript";
import { getVideoGenAdapter, type McpToolCaller } from "@vvugc/mcp-video-gen";
import { assembleVideo, ASPECT_RATIO_BY_PLATFORM } from "@vvugc/mcp-assembly";
import { insertReviewItem } from "@vvugc/review-queue";
import { rewriteScript } from "./agents/script-agent.js";
import { generateCaptions } from "./agents/caption-agent.js";
import { scoreVideo } from "./agents/qa-agent.js";

const logger = pino({ name: "vvugc-conductor" });

export interface RunCycleOptions {
  /** Only present when the conductor is itself running inside a Claude Agent SDK
   *  session with an MCP server (e.g. HiggsfieldAi) connected. */
  callMcpTool?: McpToolCaller;
}

export async function runCycle(config: RunConfig, opts: RunCycleOptions = {}): Promise<RunResult> {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const runDir = join(VVUGC_RUNS_DIR, config.runId);
  mkdirSync(runDir, { recursive: true });

  logger.info({ runId: config.runId, niche: config.niche, platforms: config.platforms }, "run started");

  // Stage 1: Discovery — per platform, non-fatal on individual platform failure
  // (e.g. TikTok/Meta adapters not yet approved) so partial coverage still runs.
  const allCandidates: CandidateVideo[] = [];
  for (const platform of config.platforms) {
    try {
      const found = config.dryRun
        ? mockCandidates(platform, config.niche, config.maxCandidates)
        : await discoverPlatform(platform, config.niche, config.maxCandidates);
      allCandidates.push(...found);
    } catch (err) {
      logger.warn({ platform, err: String(err) }, "discovery skipped for platform");
    }
  }

  const chosen = allCandidates
    .sort((a, b) => b.metrics.views - a.metrics.views)
    .slice(0, config.maxCandidates);

  logger.info({ candidatesFound: allCandidates.length, chosen: chosen.length }, "discovery complete");

  let reviewItemsCreated = 0;

  // Stage 2-5: Transcript -> Script rewrite -> Video gen/assembly -> QA, per candidate x platform
  for (const candidate of chosen) {
    const transcript = config.dryRun ? mockTranscript(candidate) : await transcribeCandidate(candidate);

    const script = await rewriteScript(transcript, {
      niche: config.niche,
      brandVoice: config.brandVoice,
      durationSec: config.targetDurationSec,
      platforms: config.platforms,
      dryRun: config.dryRun
    });

    // Caption timing/text is Claude's call, not a naive even-split — same script duration
    // applies across every target platform, so this runs once per candidate, not per platform.
    const captions = await generateCaptions(script, { dryRun: config.dryRun });

    for (const platform of config.platforms) {
      const segments = [script.hook, ...script.points, script.cta];
      const clipsDir = join(runDir, "clips");
      const clips: RawClip[] = [];

      for (let i = 0; i < segments.length; i++) {
        const adapter = getVideoGenAdapter(config.videoVendor, {
          outDir: clipsDir,
          dryRun: config.dryRun,
          callMcpTool: opts.callMcpTool
        });
        const clip = await adapter.generate({
          scriptSegmentIndex: i,
          prompt: segments[i],
          durationSec: Math.round(script.durationSec / segments.length),
          aspectRatio: ASPECT_RATIO_BY_PLATFORM[platform]
        });
        clips.push(clip);
      }

      const assembled = await assembleVideo({
        clips,
        script,
        captions,
        platform,
        outDir: join(runDir, "assembled"),
        dryRun: config.dryRun
      });

      const qa = await scoreVideo(assembled, script, { dryRun: config.dryRun });

      const reviewItem: ReviewItem = {
        id: nanoid(),
        runId: config.runId,
        niche: config.niche,
        videoPath: assembled.filePath,
        platform,
        script,
        score: qa.score,
        flags: qa.flags,
        status: "pending",
        createdAt: new Date().toISOString()
      };
      insertReviewItem(reviewItem);
      reviewItemsCreated++;
    }
  }

  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ config, candidatesFound: allCandidates.length, chosen, reviewItemsCreated }, null, 2)
  );

  const result = RunResultSchema.parse({
    runId: config.runId,
    niche: config.niche,
    candidatesFound: allCandidates.length,
    reviewItemsCreated,
    manifestPath,
    completedAt: new Date().toISOString()
  });

  logger.info(result, "run complete");
  return result;
}
