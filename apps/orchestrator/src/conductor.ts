import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import pino from "pino";
import type { CandidateVideo, RawClip, ReviewItem, RunConfig, RunResult } from "@vvugc/shared-schema";
import { RunResultSchema } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { CostLedger } from "@vvugc/shared-cost";
import { discoverPlatform, mockCandidates } from "@vvugc/mcp-discovery";
import { transcribeCandidate, mockTranscript } from "@vvugc/mcp-transcript";
import { getVideoGenAdapter, type McpToolCaller } from "@vvugc/mcp-video-gen";
import { assembleVideo, ASPECT_RATIO_BY_PLATFORM } from "@vvugc/mcp-assembly";
import { generateVoiceoverTrack, getVoiceoverAdapter } from "@vvugc/mcp-voiceover";
import { insertReviewItem } from "@vvugc/review-queue";
import { scoreOriginality } from "@vvugc/shared-originality";
import { rewriteScript } from "./agents/script-agent.js";
import { generateCaptions } from "./agents/caption-agent.js";
import { scoreVideo } from "./agents/qa-agent.js";

const logger = pino({ name: "vvugc-conductor" });

export interface RunCycleOptions {
  /** Only present when the conductor is itself running inside a Claude Agent SDK
   *  session with an MCP server (e.g. HiggsfieldAi) connected. */
  callMcpTool?: McpToolCaller;
  /**
   * Fires one human-readable line per meaningful step (discovery, each candidate's
   * progress through the pipeline). Nothing printed to structured `logger` output
   * before this existed — a live run against real vendor APIs could take minutes
   * with zero terminal output in between, indistinguishable from a hung process.
   * Defaults to a no-op so existing callers/tests that don't care about progress
   * output aren't forced to handle it; the CLI is the one real caller that wires
   * this to `console.log`.
   */
  onProgress?: (message: string) => void;
}

export async function runCycle(config: RunConfig, opts: RunCycleOptions = {}): Promise<RunResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const { VVUGC_RUNS_DIR } = loadEnv();
  const runDir = join(VVUGC_RUNS_DIR, config.runId);
  mkdirSync(runDir, { recursive: true });

  logger.info({ runId: config.runId, niche: config.niche, platforms: config.platforms }, "run started");
  onProgress(`Discovering candidates on ${config.platforms.join(", ")} for niche "${config.niche}"...`);

  const costLedger = new CostLedger();

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
      onProgress(`  ${platform}: discovery failed, skipping this platform (${String(err)})`);
    }
  }

  const chosen = allCandidates
    .sort((a, b) => b.metrics.views - a.metrics.views)
    .slice(0, config.maxCandidates);

  logger.info({ candidatesFound: allCandidates.length, chosen: chosen.length }, "discovery complete");
  onProgress(`Found ${allCandidates.length} candidate(s), processing top ${chosen.length}...`);

  let reviewItemsCreated = 0;
  let candidatesFailed = 0;
  let platformsFailed = 0;
  // Until now, the *reason* a candidate/platform failed only ever reached structured
  // pino logs and the CLI's onProgress console lines — never persisted anywhere the
  // dashboard (a non-engineer's only view into a run) could read it back. Collected
  // here and written into manifest.json below so `/runs` can expose it.
  const failures: { candidateId: string; platform?: string; reason: string }[] = [];

  // Stage 2-5: Transcript -> Script rewrite -> Video gen/assembly -> QA, per candidate x platform.
  // Each candidate (and, within it, each platform) is wrapped independently — a bad
  // transcript, a vendor timeout, or a single video-gen failure should skip just that
  // candidate/platform, not abort the entire weekly run and lose every other item
  // that already succeeded. Same non-fatal-per-unit approach as discovery above.
  for (const [index, candidate] of chosen.entries()) {
    const tag = `[${index + 1}/${chosen.length}]`;
    try {
      onProgress(`${tag} Transcribing "${candidate.title ?? candidate.id}"...`);
      const transcript = config.dryRun
        ? mockTranscript(candidate)
        : await transcribeCandidate(candidate, join(runDir, "audio"));

      onProgress(`${tag} Rewriting script...`);
      const script = await rewriteScript(transcript, {
        niche: config.niche,
        brandVoice: config.brandVoice,
        durationSec: config.targetDurationSec,
        platforms: config.platforms,
        dryRun: config.dryRun,
        costLedger
      });

      // Purely algorithmic (no LLM call, no cost) — runs once per candidate, comparing the
      // rewritten script against its own source transcript. Separate from qa-agent's Claude-
      // scored virality judgment: this is the "trend-informed but original" compliance check
      // (see @vvugc/shared-originality), not a quality call.
      const scriptText = [script.hook, ...script.points, script.cta].join(" ");
      const originality = scoreOriginality(transcript.text, scriptText);
      if (originality.flags.includes("requires_originality_review")) {
        onProgress(
          `${tag} ⚠ Originality score ${originality.originalityScore}/100 — flagged for reviewer attention`
        );
      }

      // Caption timing/text is Claude's call, not a naive even-split — same script duration
      // applies across every target platform, so this runs once per candidate, not per platform.
      const captions = await generateCaptions(script, { dryRun: config.dryRun, costLedger });

      // Voiceover is opt-in (config.voiceVendor unset = current silent/vendor-native-audio
      // behavior, unchanged) and, when enabled, generated once per candidate — same captions
      // are shared across every target platform, so the narration synced to them is too. Each
      // cue's audio is synthesized and time-conformed to that exact cue's window (see
      // mcp-voiceover's generateVoiceoverTrack) — that per-cue conforming is what guarantees
      // the narration can never drift out of sync with the burned-in captions.
      let voiceoverPath: string | undefined;
      const voiceoverAdapter = getVoiceoverAdapter(config.voiceVendor, { dryRun: config.dryRun });
      if (voiceoverAdapter) {
        try {
          onProgress(`${tag} Generating voiceover (${voiceoverAdapter.vendor})...`);
          const track = await generateVoiceoverTrack(captions, voiceoverAdapter, join(runDir, "voiceover"), candidate.id);
          voiceoverPath = track.filePath;
          if (!config.dryRun) {
            const totalChars = captions.reduce((sum, c) => sum + c.text.length, 0);
            costLedger.record("voiceover", config.voiceVendor!, "character", totalChars);
          }
        } catch (err) {
          // Narration failing shouldn't sink an otherwise-good candidate — fall back to the
          // pre-voiceover behavior (silent/vendor-native audio) for this candidate only,
          // the same non-fatal-per-unit approach as everything else in this loop.
          logger.warn(
            { candidateId: candidate.id, err: String(err) },
            "voiceover generation failed — continuing without narration for this candidate"
          );
          onProgress(`${tag} ⚠ Voiceover failed, continuing without narration: ${String(err)}`);
        }
      }

      for (const platform of config.platforms) {
        try {
          const segments = [script.hook, ...script.points, script.cta];
          const clipsDir = join(runDir, "clips");
          const clips: RawClip[] = [];

          for (let i = 0; i < segments.length; i++) {
            // Each clip is its own vendor API call and can take real wall-clock time
            // (video generation, not a cheap text call) — a line per clip, not just
            // once per platform, so a multi-point script's progress stays visible
            // instead of going quiet again for however long clip 2 of 5 takes.
            onProgress(`${tag} Generating video (${platform}) — clip ${i + 1}/${segments.length}...`);
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
          if (!config.dryRun) costLedger.record("video_gen", config.videoVendor, "clip", segments.length);

          onProgress(`${tag} Assembling video (${platform})...`);
          const assembled = await assembleVideo({
            clips,
            script,
            captions,
            platform,
            outDir: join(runDir, "assembled"),
            dryRun: config.dryRun,
            voiceoverPath
          });

          onProgress(`${tag} Scoring quality (${platform})...`);
          const qa = await scoreVideo(assembled, script, { dryRun: config.dryRun, costLedger });
          onProgress(`${tag} ✓ Queued for review (${platform}, score ${qa.score}/100)`);

          const reviewItem: ReviewItem = {
            id: nanoid(),
            runId: config.runId,
            niche: config.niche,
            videoPath: assembled.filePath,
            platform,
            script,
            score: qa.score,
            flags: [...qa.flags, ...originality.flags],
            originalityScore: originality.originalityScore,
            clips,
            captions,
            voiceoverPath,
            sourceTranscriptText: transcript.text,
            status: "pending",
            createdAt: new Date().toISOString()
          };
          await insertReviewItem(reviewItem);
          reviewItemsCreated++;
        } catch (err) {
          platformsFailed++;
          logger.warn(
            { candidateId: candidate.id, platform, err: String(err) },
            "video gen/assembly/QA failed for platform — skipping, other platforms for this candidate continue"
          );
          onProgress(`${tag} ✗ Failed (${platform}): ${String(err)}`);
          failures.push({ candidateId: candidate.id, platform, reason: String(err) });
        }
      }
    } catch (err) {
      candidatesFailed++;
      logger.warn(
        { candidateId: candidate.id, err: String(err) },
        "transcript/script rewrite failed for candidate — skipping, other candidates continue"
      );
      onProgress(`${tag} ✗ Failed: ${String(err)}`);
      failures.push({ candidateId: candidate.id, reason: String(err) });
    }
  }

  const manifestPath = join(runDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        config,
        candidatesFound: allCandidates.length,
        chosen,
        reviewItemsCreated,
        candidatesFailed,
        platformsFailed,
        failures
      },
      null,
      2
    )
  );

  const costLedgerPath = join(runDir, "cost-ledger.json");
  writeFileSync(costLedgerPath, JSON.stringify(costLedger.toJSON(), null, 2));

  const result = RunResultSchema.parse({
    runId: config.runId,
    accountId: config.accountId,
    niche: config.niche,
    candidatesFound: allCandidates.length,
    reviewItemsCreated,
    manifestPath,
    completedAt: new Date().toISOString(),
    costLedgerPath,
    estimatedCostUsd: costLedger.totalUsd(),
    candidatesFailed,
    platformsFailed
  });

  logger.info(result, "run complete");
  return result;
}
