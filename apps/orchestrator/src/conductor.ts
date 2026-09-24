import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import pino from "pino";
import type { CandidateVideo, RawClip, ReviewItem, RewrittenScript, RunConfig, RunResult } from "@vvugc/shared-schema";
import { RunResultSchema } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { CostLedger, estimateCostUsd, type CostVendor } from "@vvugc/shared-cost";
import { discoverPlatform, mockCandidates } from "@vvugc/mcp-discovery";
import { transcribeCandidate, mockTranscript } from "@vvugc/mcp-transcript";
import { getVideoGenAdapter, type McpToolCaller } from "@vvugc/mcp-video-gen";
import { assembleVideo, ASPECT_RATIO_BY_PLATFORM } from "@vvugc/mcp-assembly";
import { generateVoiceoverTrack, getVoiceoverAdapter } from "@vvugc/mcp-voiceover";
import { insertReviewItem } from "@vvugc/review-queue";
import { scoreOriginality } from "@vvugc/shared-originality";
import { CostCap, CostCapExceededError, FlowLimiter, type ConcurrencyCapConfig, DEFAULT_CAP_CONFIG } from "@vvugc/shared-analytics";
import { registerHook, type HookRegistry, HookRegistrySchema, Semaphore } from "@vvugc/shared-analytics";
import { createGrowthMemory, learnFromJob, type GrowthMemory, GrowthMemorySchema } from "@vvugc/shared-analytics";
import { buildAdaptivePrompt } from "@vvugc/shared-analytics";
import { rewriteScript } from "./agents/script-agent.js";
import { generateCaptions } from "./agents/caption-agent.js";
import { scoreVideo } from "./agents/qa-agent.js";
import { createImprovementProposals, type QaObservation } from "./agents/improvement-proposals.js";
import { candidateFromSource, fetchRemixTranscript, parseSourceUrl } from "./remix-source.js";

const logger = pino({ name: "vvugc-conductor" });

export type VideoVendorId = "higgsfield" | "kling" | "runway" | "pika" | "gemini" | "replicate" | "seedance" | "grok_video" | "wan" | "alibaba";

/** Ordered chain (primary first, then fallbacks), deduplicated. */
export function resolveVideoVendorChain(
  primary: VideoVendorId,
  fallbacks?: VideoVendorId[]
): VideoVendorId[] {
  // If no explicit fallbacks were configured, use a cost/quality-sensible default.
  // Best practice for a fallback orchestrator: prefer vendors whose adapters are
  // direct-REST (low blast radius when one is flaky), and keep the MCP-gated
  // Higgsfield as the user's explicit primary rather than an implicit fallback
  // (it needs a live MCP session that may not exist on a bare run).
  const defaultFallbacks: VideoVendorId[] = ["gemini", "replicate"];
  const chain = [primary, ...(fallbacks?.length ? fallbacks : defaultFallbacks)];
  return [...new Set(chain)];
}

/**
 * Generates a single clip across the primary vendor and its fallback chain.
 * Each vendor attempt is its own call; on failure we move to the next vendor in
 * the chain. Only when every vendor in the chain has failed do we throw — at
 * which point the caller skips that platform (same non-fatal-per-unit approach
 * as every other stage). Returns the produced clip with `vendor` set to the
 * vendor that actually generated it, so cost/QA attribution stays accurate.
 */
export async function generateClipWithFallback(
  chain: VideoVendorId[],
  request: {
    scriptSegmentIndex: number;
    prompt: string;
    durationSec: number;
    aspectRatio: "9:16" | "1:1" | "16:9";
  },
  opts: { outDir: string; dryRun: boolean; callMcpTool?: McpToolCaller },
  onAttempt?: (vendor: VideoVendorId, failed?: string) => void
): Promise<RawClip> {
  const failures: Array<{ vendor: VideoVendorId; error: string }> = [];
  for (const vendor of chain) {
    try {
      onAttempt?.(vendor);
      const adapter = getVideoGenAdapter(vendor, opts);
      const clip = await adapter.generate(request);
      // Adapter already stamps vendor, but pin it defensively so downstream cost
      // accounting uses the vendor that actually ran, not the configured primary.
      return { ...clip, vendor };
    } catch (err) {
      const message = String(err);
      failures.push({ vendor, error: message });
      onAttempt?.(vendor, message);
      logger.warn(
        { vendor, err: message },
        `video vendor failed — trying next fallback in chain (${chain.length - chain.indexOf(vendor) - 1} left)`
      );
    }
  }
  // Aggregate every vendor's failure so ops sees the whole chain's errors at once,
  // not just the last one (the usual complaint when debugging a fully-down stack).
  throw new Error(
    `all ${chain.length} video vendor(s) failed: ` + failures.map((f) => `${f.vendor} (${f.error})`).join("; ")
  );
}

export interface RunCycleOptions {
  /** Only present when the conductor is itself running inside a Claude Agent SDK
   *  session with an MCP server (e.g. HiggsfieldAi) connected. */
  callMcpTool?: McpToolCaller;
  /** Concurrency and cost cap configuration. Uses sensible defaults if omitted. */
  capConfig?: Partial<ConcurrencyCapConfig>;
  /** Maximum USD cost for this run. Overrides capConfig.maxCostPerRunUsd. */
  maxCostUsd?: number;
  /** Maximum unique video angles per flow. Defaults to 8. */
  maxVideosPerFlow?: number;
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

const VARIANT_ANGLES = [
  "main angle: preserve the strongest proven framing from the viral source",
  "practical takeaway angle: lead with the most useful actionable implication",
  "curiosity angle: foreground a surprising but source-supported detail",
  "skeptical perspective: address a reasonable hesitation using only source-supported facts"
] as const;

/** Bounded worker pool. Results keep input order; one failed item does not cancel peers. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>, sharedSemaphore?: Semaphore): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency limit must be a positive integer");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      if (!sharedSemaphore) { results[index] = await work(items[index]!, index); continue; }
      await sharedSemaphore.acquire();
      try { results[index] = await work(items[index]!, index); }
      finally { sharedSemaphore.release(); }
    }
  });
  await Promise.all(workers);
  return results;
}

export function reserveVideoGenBudget(costCap: CostCap, vendorChain: VideoVendorId[], clipCount: number, dryRun: boolean): number {
  if (dryRun) return 0;
  // Reserve the chain's TRUE summed per-clip estimate — never a per-vendor $1 floor.
  // Real clip rates run $0.10–$0.75, so flooring each vendor at ≥$1 made a 3-vendor
  // chain reserve ≥$3/clip and pushed multi-variant runs over the default $25 cap
  // spuriously. The $1 fallback applies once, to the whole chain, and only when no
  // vendor in it is priced (summed estimate 0) so an unknown-price chain still
  // reserves something. The reservation is reconciled against actual ledger spend
  // after generation (see runCycle's reconcile step).
  const summedEstimate = vendorChain.reduce(
    (sum, vendor) => sum + estimateCostUsd(vendor as CostVendor, "clip", 1),
    0
  );
  const perClipUsd = summedEstimate > 0 ? summedEstimate : 1;
  const reserve = perClipUsd * clipCount;
  costCap.record(reserve);
  return reserve;
}

export function recordCompletedClipUsage(costLedger: CostLedger, clips: RawClip[], dryRun: boolean): void {
  if (dryRun) return;
  for (const vendor of new Set(clips.map((clip) => clip.vendor))) {
    costLedger.record("video_gen", vendor, "clip", clips.filter((clip) => clip.vendor === vendor).length);
  }
}

/** Record one billable provider attempt (including failed calls before fallback). */
export function recordVideoGenAttempt(costLedger: CostLedger, vendor: VideoVendorId, dryRun: boolean, failed?: string): void {
  if (!dryRun && !failed) costLedger.record("video_gen", vendor as CostVendor, "clip", 1);
}

export async function runCycle(config: RunConfig, opts: RunCycleOptions = {}): Promise<RunResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const { VVUGC_RUNS_DIR } = loadEnv();
  const runDir = join(VVUGC_RUNS_DIR, config.runId);
  mkdirSync(runDir, { recursive: true });

  logger.info({ runId: config.runId, niche: config.niche, platforms: config.platforms }, "run started");
  onProgress(`Discovering candidates on ${config.platforms.join(", ")} for niche "${config.niche}"...`);

  const costLedger = new CostLedger();

  // ─── Cost Cap & Flow Limiter ─────────────────────────────────────────────
  const capConfig: ConcurrencyCapConfig = {
    ...DEFAULT_CAP_CONFIG,
    ...opts.capConfig,
    maxCostPerRunUsd: opts.maxCostUsd ?? opts.capConfig?.maxCostPerRunUsd ?? DEFAULT_CAP_CONFIG.maxCostPerRunUsd,
    maxVideosPerFlow: opts.maxVideosPerFlow ?? opts.capConfig?.maxVideosPerFlow ?? 8,
  };
  const costCap = new CostCap(capConfig.maxCostPerRunUsd, (spent, limit) => {
    onProgress(`⚠ Cost warning: $${spent.toFixed(2)} spent of $${limit.toFixed(2)} limit (${Math.round(spent/limit*100)}%)`);
  });
  const flowLimiter = new FlowLimiter(capConfig.maxVideosPerFlow);
  const videoGenSemaphore = new Semaphore(capConfig.maxConcurrentVideoGen);
  let accountedVideoUsd = 0;
  let accountedNonVideoUsd = 0;

  onProgress(`Run caps: max ${capConfig.maxVideosPerFlow} videos, $${capConfig.maxCostPerRunUsd.toFixed(2)} cost limit, ${capConfig.maxConcurrentVideoGen} concurrent video-gen calls`);

  // ─── Load Analytics State ───────────────────────────────────────────────
  const analyticsDir = join(VVUGC_RUNS_DIR, "_analytics");
  mkdirSync(analyticsDir, { recursive: true });
  const hookRegistryPath = join(analyticsDir, "hook-registry.json");
  const growthMemoryPath = join(analyticsDir, "growth-memory.json");

  let hookRegistry: HookRegistry = existsSync(hookRegistryPath)
    ? HookRegistrySchema.parse(JSON.parse(readFileSync(hookRegistryPath, "utf-8")))
    : { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };

  let growthMemory: GrowthMemory = existsSync(growthMemoryPath)
    ? GrowthMemorySchema.parse(JSON.parse(readFileSync(growthMemoryPath, "utf-8")))
    : createGrowthMemory();

  // Build adaptive prompt context from learned intelligence
  const adaptiveContext = buildAdaptivePrompt(hookRegistry, growthMemory, {
    niche: config.niche,
    platform: config.platforms[0],
  });

  // Stage 1: Discovery — per platform, non-fatal on individual platform failure
  // (e.g. TikTok/Meta adapters not yet approved) so partial coverage still runs.
  //
  // Remix-from-URL bypasses discovery entirely: the user handed us one source
  // video to adapt, so the "candidate set" is exactly that one source, and its
  // transcript is either pre-resolved (config.sourceTranscript — captured by the
  // remix endpoint so it can preview before spending on video) or fetched here.
  const allCandidates: CandidateVideo[] = [];
  const sourceTranscript =
    config.sourceTranscript ??
    (config.sourceUrl
      ? (await fetchRemixTranscript(config.sourceUrl, join(runDir, "remix-source"), config.niche))
          .transcript
      : undefined);

  if (sourceTranscript) {
    if (config.sourceUrl) {
      const parsed = parseSourceUrl(config.sourceUrl);
      if (parsed) {
        onProgress(`Remixing source video (${parsed.platform}) — transcript fetched...`);
        allCandidates.push(candidateFromSource(config.sourceUrl, parsed, config.niche));
      }
    } else {
      // No URL provenance (transcript embedded directly) — synthesize a candidate
      // id from the transcript itself so downstream code stays candidate-shaped.
      const parsed = parseSourceUrl(config.sourceTranscript?.text ?? "") ?? { platform: config.platforms[0], videoId: sourceTranscript.videoId };
      allCandidates.push(candidateFromSource(`remix://${sourceTranscript.videoId}`, parsed, config.niche));
    }
  } else {
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
  }

  const chosen = allCandidates
    .sort((a, b) => b.metrics.views - a.metrics.views)
    // One flow yields 2–4 distinct cuts of the best viral source. Exporting those
    // cuts to multiple platforms does not consume additional angle slots.
    .slice(0, 1);

  logger.info({ candidatesFound: allCandidates.length, chosen: chosen.length }, "discovery complete");
  onProgress(`Found ${allCandidates.length} candidate(s), processing top ${chosen.length}...`);

  let reviewItemsCreated = 0;
  let candidatesFailed = 0;
  let platformsFailed = 0;
  let runCostCapHit = false;
  // Until now, the *reason* a candidate/platform failed only ever reached structured
  // pino logs and the CLI's onProgress console lines — never persisted anywhere the
  // dashboard (a non-engineer's only view into a run) could read it back. Collected
  // here and written into manifest.json below so `/runs` can expose it.
  const failures: { candidateId: string; platform?: string; reason: string }[] = [];
  // Advisory observations for this run only; never fed back into prompts or system state.
  const qaObservations: QaObservation[] = [];

  // Stage 2-5: Transcript -> Script rewrite -> Video gen/assembly -> QA, for the
  // selected viral source. Its 2–4 outputs are varied angles, not extra sources.
  // Each candidate (and, within it, each platform) is wrapped independently — a bad
  // transcript, a vendor timeout, or a single video-gen failure should skip just that
  // candidate/platform, not abort the entire weekly run and lose every other item
  // that already succeeded. Same non-fatal-per-unit approach as discovery above.
  for (const [index, candidate] of chosen.entries()) {
    const tag = `[${index + 1}/${chosen.length}]`;
    try {
      onProgress(`${tag} Transcribing "${candidate.title ?? candidate.id}"...`);
      const transcript = sourceTranscript ??
        (config.dryRun
          ? mockTranscript(candidate)
          : await transcribeCandidate(candidate, join(runDir, "audio")));

      const scriptResults = await mapWithConcurrency(
        Array.from({ length: config.outputVariants }, (_, variantIndex) => variantIndex),
        capConfig.maxConcurrentLlm,
        async (variantIndex) => {
          try {
            const variantAngle = VARIANT_ANGLES[variantIndex];
            onProgress(`${tag} Rewriting script variant ${variantIndex + 1}/${config.outputVariants}...`);
            const rewritten = await rewriteScript(transcript, {
              niche: config.niche,
              brandVoice: config.brandVoice,
              brandKit: config.brandKit,
              durationSec: config.targetDurationSec,
              platforms: config.platforms,
              locale: config.locale,
              dryRun: config.dryRun,
              discoveryBrief: config.discoveryBrief,
              angle: variantAngle,
              productProfile: config.productProfile,
              creatorProfile: config.creatorProfile,
              template: config.template,
              adaptivePromptInjection: adaptiveContext.fullInjection || undefined,
              costLedger
            });
            return { variantIndex, script: { ...rewritten, videoId: `${candidate.id}-variant-${variantIndex + 1}` } };
          } catch (error) {
            // Per-item isolation with the same semantics as the clip path below: one
            // variant's rewrite failure must not reject the shared mapWithConcurrency
            // promise (which would discard sibling variants' already-successful work
            // and leave peer workers unhandled). Failures are reported, not swallowed.
            return { variantIndex, error: String(error) };
          }
        }
      );
      const scripts: { variantIndex: number; script: RewrittenScript }[] = scriptResults.filter(
        (result): result is { variantIndex: number; script: RewrittenScript } => !("error" in result)
      );
      const scriptErrors = scriptResults.filter(
        (result): result is { variantIndex: number; error: string } => "error" in result
      );
      if (!scripts.length) {
        // Every variant failed — candidate-level failure, reported by the outer catch
        // exactly as before (candidatesFailed++, one aggregated failure entry).
        throw new Error(
          `script rewrite failure(s): ${scriptErrors.map((e) => `${e.variantIndex + 1}: ${e.error}`).join("; ")}`
        );
      }
      for (const scriptError of scriptErrors) {
        // Partial success: keep the sibling variants' already-successful work and
        // report the failed one through the same channels the clip/platform failure
        // paths use (structured log + onProgress line + manifest `failures`).
        const reason = `variant ${scriptError.variantIndex + 1} script rewrite failed: ${scriptError.error}`;
        logger.warn(
          { candidateId: candidate.id, variantIndex: scriptError.variantIndex, err: scriptError.error },
          "script rewrite failed for variant — continuing with successful sibling variants"
        );
        onProgress(`${tag} ✗ ${reason} — continuing with ${scripts.length} successful variant(s)`);
        failures.push({ candidateId: candidate.id, reason });
      }

      for (const { variantIndex, script } of scripts) {
        const hookAngle = `${candidate.id}::${variantIndex + 1}::${script.hook.toLowerCase().slice(0, 80)}`;
        // Flow limits apply to distinct source angles, once per variant, not once
        // per platform export of that same angle.
        if (!flowLimiter.canGenerate(hookAngle)) {
          onProgress(`${tag} ⊘ Skipping variant ${variantIndex + 1}: flow angle limit reached (${flowLimiter.totalVideos}/${capConfig.maxVideosPerFlow})`);
          continue;
        }
        flowLimiter.record(hookAngle); // reserve angle slot before any provider work
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

      // Caption timing/text is generated independently for each variant, then shared across
      // its target platforms.
      const captions = await generateCaptions(script, { dryRun: config.dryRun, costLedger, template: config.template });

      // Voiceover is opt-in and, when enabled, generated once per variant — its captions
      // are shared across that variant's target platforms. Each
      // cue's audio is synthesized and time-conformed to that exact cue's window (see
      // mcp-voiceover's generateVoiceoverTrack) — that per-cue conforming is what guarantees
      // the narration can never drift out of sync with the burned-in captions.
      let voiceoverPath: string | undefined;
      const voiceoverAdapter = getVoiceoverAdapter(config.voiceVendor, { dryRun: config.dryRun });
      if (voiceoverAdapter) {
        try {
          onProgress(`${tag} Generating voiceover (${voiceoverAdapter.vendor})...`);
          const track = await generateVoiceoverTrack(captions, voiceoverAdapter, join(runDir, "voiceover"), `${candidate.id}-variant-${variantIndex + 1}`);
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
          // ─── Cost Cap Check ─────────────────────────────────────────────────
          const nonVideoUsd = costLedger.getEvents().filter((event) => event.stage !== "video_gen").reduce((sum, event) => sum + event.estimatedCostUsd, 0);
          if (nonVideoUsd > accountedNonVideoUsd) {
            costCap.record(nonVideoUsd - accountedNonVideoUsd);
            accountedNonVideoUsd = nonVideoUsd;
          }

          const segments = [script.hook, ...script.points, script.cta];
          const safeCandidateId = candidate.id.replace(/[^a-z0-9_-]/gi, "_");
          const clipsDir = join(runDir, "clips", safeCandidateId, `variant-${variantIndex + 1}`, platform);
          const clips: RawClip[] = [];
          // Resolve the vendor chain once per candidate (primary + fallbacks) and
          // reuse it for every clip — a given candidate keeps a consistent vendor
          // unless that vendor fails, in which case the next clip retries the chain.
          const vendorChain = resolveVideoVendorChain(
            config.videoVendor,
            config.videoVendorFallbacks as VideoVendorId[] | undefined
          );
          // Fallbacks can charge for failed attempts too. Reserve the summed per-clip
          // estimate of every provider in the chain (a single $1/clip total floor only
          // when the whole chain is unpriced) before generation — then reconcile it
          // against actual ledger spend in the finally below, on both the success and
          // failure paths, so unused reservation never leaks into the run cap and any
          // real overage is still billed.
          const videoReserve = reserveVideoGenBudget(costCap, vendorChain, segments.length, config.dryRun);
          try {
            const clipResults = await mapWithConcurrency(segments, capConfig.maxConcurrentVideoGen, async (segment, i) => {
              onProgress(`${tag} Generating video variant ${variantIndex + 1} (${platform}) — clip ${i + 1}/${segments.length}...`);
              try {
                const attempts: VideoVendorId[] = [];
                const clip = await generateClipWithFallback(
                  vendorChain,
                  {
                    scriptSegmentIndex: i,
                    prompt: (() => {
                      let promptText = segment;
                      if (config.template) {
                        promptText += `\nShot Intention: Show visual representation of "${config.template.scriptStructure[i]}" beat.`;
                        promptText += `\nVisual Direction: ${config.template.visualDirection}`;
                        promptText += `\nCamera Direction: ${config.template.cameraDirection}`;
                        promptText += `\nProduct Placement: ${config.template.productPlacementDirection}`;
                        if (config.creatorProfile) promptText += `\nCreator Behavior: ${config.template.creatorDirection}`;
                      }
                      return promptText;
                    })(),
                    durationSec: Math.round(script.durationSec / segments.length),
                    aspectRatio: ASPECT_RATIO_BY_PLATFORM[platform]
                  },
                  { outDir: clipsDir, dryRun: config.dryRun, callMcpTool: opts.callMcpTool },
                  (vendor, failed) => {
                    if (!attempts.includes(vendor)) attempts.push(vendor);
                    recordVideoGenAttempt(costLedger, vendor, config.dryRun, failed);
                    onProgress(failed
                      ? `${tag}   variant ${variantIndex + 1} clip ${i + 1}: ${vendor} failed, trying fallback (${failed})`
                      : `${tag}   variant ${variantIndex + 1} clip ${i + 1}: using ${vendor}`);
                  }
                );
                return { clip, attempts } as const;
              } catch (error) {
                return { error: String(error), index: i } as const;
              }
            }, videoGenSemaphore);
            // Charge every completed clip immediately, even if a peer clip failed.
            const completedClips = clipResults.map((result) => result.clip).filter((clip): clip is RawClip => clip !== undefined);
            clips.push(...completedClips);
            const clipErrors = clipResults.filter((result): result is { error: string; index: number } => "error" in result);
            if (clipErrors.length) throw new Error(`variant ${variantIndex + 1} clip failure(s): ${clipErrors.map((e) => `${e.index + 1}: ${e.error}`).join("; ")}`);
          } finally {
            // Reconcile this iteration's reservation against actual ledger video spend
            // (recorded per vendor attempt above, so failed billable fallbacks are
            // represented too — successful clips aren't charged a second time): refund
            // the unused portion of the reservation (CostCap.refund clamps at ≥0), or
            // bill the overage when actual exceeded it — the case the old
            // `actualVideoUsd > reservedVideoUsd` branch was dead-by-construction for.
            const actualVideoUsd = costLedger.getEvents().filter((event) => event.stage === "video_gen").reduce((sum, event) => sum + event.estimatedCostUsd, 0);
            const deltaActualVsReserved = actualVideoUsd - accountedVideoUsd - videoReserve;
            if (deltaActualVsReserved > 0) costCap.record(deltaActualVsReserved);
            else if (deltaActualVsReserved < 0) costCap.refund(-deltaActualVsReserved);
            accountedVideoUsd = actualVideoUsd;
          }
          onProgress(`${tag} Assembling video (${platform})...`);
          const platformScript = { ...script, videoId: `${script.videoId}-${platform}` };
          const assembled = await assembleVideo({
            clips,
            script: platformScript,
            captions,
            platform,
            outDir: join(runDir, "assembled"),
            dryRun: config.dryRun,
            voiceoverPath
          });

          onProgress(`${tag} Scoring quality (${platform})...`);
          const qa = await scoreVideo(assembled, script, {
            dryRun: config.dryRun,
            costLedger,
            productProfile: config.productProfile,
            creatorProfile: config.creatorProfile,
            template: config.template
          });
          qaObservations.push({ candidateId: candidate.id, platform, score: qa.score, flags: qa.flags });
          onProgress(`${tag} ✓ Queued for review (${platform}, score ${qa.score}/100)`);

          const reviewItem: ReviewItem = {
            id: nanoid(),
            runId: config.runId,
            orgId: config.orgId ?? config.accountId,
            clientId: config.clientId,
            productProfileId: config.productProfileId ?? config.productProfile?.id,
            // The stored template object is the resolved source of truth. If a
            // caller supplied a stale/mismatched templateId, never persist it
            // beside a different template payload.
            templateId: config.template?.id ?? config.templateId,
            template: config.template,
            niche: config.niche,
            videoPath: assembled.filePath,
            platform,
            script,
            score: qa.score,
            structuralScore: qa.structuralScore,
            flags: [...qa.flags, ...originality.flags],
            originalityScore: originality.originalityScore,
            clips,
            captions,
            voiceoverPath,
            sourceTranscriptText: transcript.text,
            status: "pending",
            dryRun: config.dryRun,
            createdAt: new Date().toISOString()
          };
          await insertReviewItem(reviewItem);
          reviewItemsCreated++;

          // ─── Analytics: Record to flow limiter and hook registry ──────────
          // Register hook in the self-expanding registry (only 80+ QA hooks persist)
          hookRegistry = registerHook(hookRegistry, {
            text: script.hook,
            qaScore: qa.score,
            platform,
            niche: config.niche,
            source: "pipeline_qa",
          });
          // Sync cost cap with actual ledger spend

        } catch (err) {
          if (err instanceof CostCapExceededError) {
            onProgress(`${tag} ✖ COST CAP HIT: ${err.message} — stopping all remaining video generation`);
            logger.warn({ spent: err.spent, limit: err.limit }, "cost cap exceeded — halting run");
            failures.push({ candidateId: candidate.id, platform, reason: err.message });
            // Break out of both loops
            candidatesFailed = chosen.length; // Signal early stop
            runCostCapHit = true;
            break;
          }
          platformsFailed++;
          logger.warn(
            { candidateId: candidate.id, platform, err: String(err) },
            "video gen/assembly/QA failed for platform — skipping, other platforms for this candidate continue"
          );
          onProgress(`${tag} ✗ Failed (${platform}): ${String(err)}`);
          failures.push({ candidateId: candidate.id, platform, reason: String(err) });
        }
      }
      if (runCostCapHit) break;
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

  // Improvement proposals are fixed, bounded, run-local QA summaries. They are
  // advisory only and require explicit human approval; this write cannot mutate
  // prompts, code, settings, credentials, tools, schedules, deployments, or runs.
  const improvementProposals = createImprovementProposals(qaObservations);
  const improvementProposalsPath = join(runDir, "improvement-proposals.json");
  writeFileSync(improvementProposalsPath, JSON.stringify(improvementProposals, null, 2));
  onProgress(improvementProposals.proposals.length
    ? `Improvement proposals ready for human review: ${improvementProposals.proposals.length}`
    : "Improvement proposals: none (no recognized QA issues in this run)");

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
        failures,
        improvementProposalsPath,
        improvementProposals
      },
      null,
      2
    )
  );

  // ─── Persist cost ledger (always, even if analytics fails) ─────────────
  const costLedgerPath = join(runDir, "cost-ledger.json");
  try {
    writeFileSync(costLedgerPath, JSON.stringify(costLedger.toJSON(), null, 2));
  } catch (err) {
    logger.error({ err: String(err), costLedgerPath }, "CRITICAL: failed to persist cost ledger");
  }

  // ─── Analytics: Learn from this job and persist state ──────────────────────
  // The growth memory learns from every single job — even rejected items teach us
  // Build items array from the review items we created (tracked by what we processed)
  const jobItems: Parameters<typeof learnFromJob>[1]["items"] = [];
  // We don't have a local list of created items, but we can reconstruct from the run
  // The learning happens with what we know from the pipeline execution
  // For now, signal what we produced — the full feedback loop ingests post-publish data later
  if (reviewItemsCreated > 0) {
    growthMemory = learnFromJob(growthMemory, {
      runId: config.runId,
      niche: config.niche,
      platforms: config.platforms,
      items: jobItems, // Will be populated by the feedback collector post-run
    });
  }

  // Persist analytics state
  try {
    writeFileSync(hookRegistryPath, JSON.stringify(hookRegistry, null, 2));
    writeFileSync(growthMemoryPath, JSON.stringify(growthMemory, null, 2));
    onProgress(`Analytics saved: ${hookRegistry.entries.length} hooks tracked, ${growthMemory.totalJobsProcessed} jobs learned`);
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to persist analytics state (non-fatal)");
  }

  const result = RunResultSchema.parse({
    runId: config.runId,
    accountId: config.accountId,
    orgId: config.orgId ?? config.accountId,
    clientId: config.clientId,
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
