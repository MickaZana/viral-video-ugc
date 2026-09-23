import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorProfile, ProductProfile, RunConfig } from "@vvugc/shared-schema";
import { mapWithConcurrency, recordCompletedClipUsage, reserveVideoGenBudget, runCycle, type VideoVendorId } from "./conductor.js";
import { Semaphore, CostCap } from "@vvugc/shared-analytics";
import { CostLedger } from "@vvugc/shared-cost";
import { rewriteScript } from "./agents/script-agent.js";
import { generateCaptions } from "./agents/caption-agent.js";
import { scoreVideo } from "./agents/qa-agent.js";
import { generateVoiceoverTrack } from "@vvugc/mcp-voiceover";
import type { VideoGenRequest } from "@vvugc/mcp-video-gen";
import { getUgcTemplate } from "./templates.js";

vi.mock("./agents/script-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./agents/script-agent.js")>("./agents/script-agent.js");
  return { ...actual, rewriteScript: vi.fn(actual.rewriteScript) };
});
vi.mock("./agents/qa-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./agents/qa-agent.js")>("./agents/qa-agent.js");
  return { ...actual, scoreVideo: vi.fn(actual.scoreVideo) };
});
vi.mock("./agents/caption-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./agents/caption-agent.js")>("./agents/caption-agent.js");
  return { ...actual, generateCaptions: vi.fn(actual.generateCaptions) };
});
vi.mock("@vvugc/mcp-voiceover", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/mcp-voiceover")>("@vvugc/mcp-voiceover");
  return { ...actual, generateVoiceoverTrack: vi.fn(actual.generateVoiceoverTrack) };
});
vi.mock("@vvugc/mcp-video-gen", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/mcp-video-gen")>("@vvugc/mcp-video-gen");
  return {
    ...actual,
    // Live-mode runs must never hit a real vendor API from tests; dry-run keeps the
    // package's own mock adapter so existing dry-run behavior is byte-identical.
    getVideoGenAdapter: (
      vendor: Parameters<typeof actual.getVideoGenAdapter>[0],
      opts: Parameters<typeof actual.getVideoGenAdapter>[1]
    ) =>
      opts.dryRun
        ? actual.getVideoGenAdapter(vendor, opts)
        : {
            vendor,
            generate: (request: VideoGenRequest) =>
              Promise.resolve({
                id: `live-mock-${vendor}-${request.scriptSegmentIndex}`,
                scriptSegmentIndex: request.scriptSegmentIndex,
                vendor,
                filePath: `/tmp/live-mock-${vendor}-${request.scriptSegmentIndex}.mp4`,
                durationSec: request.durationSec
              })
          }
  };
});
vi.mock("@vvugc/mcp-assembly", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/mcp-assembly")>("@vvugc/mcp-assembly");
  return {
    ...actual,
    // Never run real ffmpeg from tests: force the package's dry-run assembly even
    // when the conductor is exercising live mode (mock clip files aren't real video).
    assembleVideo: (opts: Parameters<typeof actual.assembleVideo>[0]) =>
      actual.assembleVideo({ ...opts, dryRun: true })
  };
});

let testRunsDir: string;
let testDbPath: string;

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    niche: "fitness",
    platforms: ["tiktok"],
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    targetDurationSec: 25,
    maxCandidates: 2,
    outputVariants: 2,
    videoVendor: "kling",
    dryRun: true,
    autoPost: false,
    lipSyncVendor: "none",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("bounded clip concurrency", () => {
  it("keeps work at or below the configured concurrency and returns results in input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return item * 2;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([0, 2, 4, 6, 8]);
  });

  it("shares one semaphore across simultaneous output batches", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const work = async (item: number) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return item;
    };
    await Promise.all([
      mapWithConcurrency([1, 2, 3], 3, work, semaphore),
      mapWithConcurrency([4, 5, 6], 3, work, semaphore)
    ]);
    expect(peak).toBe(2);
  });

  it("reserves the true summed video estimate before work and records completed clips even if peer clips fail", () => {
    const cap = new CostCap(20);
    const reserve = reserveVideoGenBudget(cap, ["alibaba"], 3, false);
    expect(reserve).toBeCloseTo(0.5 * 3, 6); // real $0.50/clip rate × 3 clips — no $1/clip floor
    expect(cap.totalSpent).toBeCloseTo(1.5, 6);
    const singleVendorReserve = reserveVideoGenBudget(new CostCap(20), ["alibaba"], 1, false);
    expect(reserveVideoGenBudget(new CostCap(20), ["alibaba", "replicate"], 1, false)).toBeGreaterThanOrEqual(singleVendorReserve);
    expect(() => reserveVideoGenBudget(new CostCap(1), ["alibaba"], 3, false)).toThrow(/Cost cap exceeded/);
    const ledger = new CostLedger();
    recordCompletedClipUsage(ledger, [
      { id: "ok", scriptSegmentIndex: 0, vendor: "alibaba", filePath: "ok.mp4", durationSec: 5 }
    ], false);
    expect(ledger.getEvents()).toMatchObject([{ stage: "video_gen", vendor: "alibaba", unit: "clip", quantity: 1 }]);
  });

  it("a 3-vendor chain reserves the true summed estimate × clipCount — not a per-vendor $1 floor", () => {
    const chain: VideoVendorId[] = ["kling", "higgsfield", "runway"]; // $0.35 + $0.40 + $0.50 per clip
    const cap = new CostCap(100);
    const reserve = reserveVideoGenBudget(cap, chain, 4, false);
    expect(reserve).toBeCloseTo((0.35 + 0.4 + 0.5) * 4, 6); // $5.00 for 4 clips
    expect(reserve).toBeLessThan(3 * 4); // the old per-vendor floor reserved ≥$12 for this chain
    expect(cap.totalSpent).toBeCloseTo(reserve, 6);
  });

  it("an unknown-priced chain falls back to a single $1-per-clip floor (total, not per vendor)", () => {
    // gemini is image-priced only — estimateCostUsd(gemini, "clip") is 0, so the
    // chain's summed estimate is 0 and the $1 total floor applies × clipCount.
    const reserve = reserveVideoGenBudget(new CostCap(20), ["gemini"], 3, false);
    expect(reserve).toBeCloseTo(1 * 3, 6);
    // An unpriced member of an otherwise-priced chain adds $0 — no per-vendor floor.
    expect(reserveVideoGenBudget(new CostCap(20), ["gemini", "kling"], 1, false)).toBeCloseTo(0.35, 6);
  });
});

describe("runCycle", () => {
  beforeEach(() => {
    testRunsDir = mkdtempSync(join(tmpdir(), "vvugc-conductor-test-"));
    testDbPath = join(testRunsDir, "review-queue.json");
    process.env.VVUGC_RUNS_DIR = testRunsDir;
    process.env.VVUGC_DB_PATH = testDbPath;
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.VVUGC_DB_PATH;
    if (existsSync(testRunsDir)) rmSync(testRunsDir, { recursive: true, force: true });
    vi.mocked(rewriteScript).mockRestore();
    vi.mocked(generateCaptions).mockRestore();
    vi.mocked(scoreVideo).mockRestore();
    vi.mocked(generateVoiceoverTrack).mockRestore();
  });

  it("dry-run: produces one review item per candidate x platform, and writes a readable manifest", async () => {
    const config = baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 2 });
    const result = await runCycle(config);

    expect(result.runId).toBe(config.runId);
    expect(result.candidatesFound).toBeGreaterThan(0);
    // A flow selects one anchor source and makes the requested distinct angle cuts.
    expect(result.reviewItemsCreated).toBe(config.platforms.length * config.outputVariants);

    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.reviewItemsCreated).toBe(result.reviewItemsCreated);
    expect(manifest.improvementProposalsPath).toBe(join(testRunsDir, config.runId, "improvement-proposals.json"));
    const improvementProposals = JSON.parse(readFileSync(manifest.improvementProposalsPath, "utf-8"));
    expect(improvementProposals).toMatchObject({ advisoryOnly: true, requiresHumanApproval: true });
    expect(["none", "proposals"]).toContain(improvementProposals.status);
    expect(improvementProposals.proposals.length).toBeLessThanOrEqual(3);

    expect(existsSync(testDbPath)).toBe(true);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    expect(queue).toHaveLength(result.reviewItemsCreated);
    expect(new Set(queue.map((item: { videoPath: string }) => item.videoPath)).size).toBe(queue.length);
    expect(queue.every((item: { status: string }) => item.status === "pending")).toBe(true);
    // Every review item carries an algorithmic originality score (@vvugc/shared-originality),
    // computed once per candidate and attached to every one of that candidate's platform items.
    expect(queue.every((item: { originalityScore?: number }) => typeof item.originalityScore === "number")).toBe(
      true
    );
  });

  it("produces 2–4 source variants across every platform while the flow cap counts angles, not platform exports", async () => {
    for (const outputVariants of [2, 3, 4]) {
      const config = baseConfig({
        platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1, outputVariants
      });
      const result = await runCycle(config, { maxVideosPerFlow: 8 });
      expect(result.reviewItemsCreated).toBe(outputVariants * config.platforms.length);
      const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
      expect(new Set(queue.map((item: { script: { videoId: string } }) => item.script.videoId)).size).toBe(outputVariants);
    }
    const capped = await runCycle(baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1, outputVariants: 4 }), { maxVideosPerFlow: 3 });
    expect(capped.reviewItemsCreated).toBe(6); // three distinct angles, exported on two platforms
  });

  it("a flow generates only the configured number of angles from its top viral source", async () => {
    const result = await runCycle(baseConfig({ maxCandidates: 5, outputVariants: 3 }));
    expect(result.candidatesFound).toBeGreaterThan(1);
    expect(result.reviewItemsCreated).toBe(3);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    expect(new Set(queue.map((item: { sourceTranscriptText: string }) => item.sourceTranscriptText)).size).toBe(1);
    expect(new Set(queue.map((item: { script: { hook: string } }) => item.script.hook)).size).toBe(3);
  });

  it("remix-from-URL: an embedded sourceTranscript skips discovery and adapts exactly that one source across every platform", async () => {
    // Even in dry-run, a supplied source transcript is used verbatim (not mockTranscript),
    // because the whole point is to remix the user's pasted video — not a placeholder.
    const config = baseConfig({
      platforms: ["tiktok", "youtube_shorts"],
      maxCandidates: 1,
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      sourceTranscript: {
        videoId: "dQw4w9WgXcQ",
        source: "platform_captions",
        text: "Wait for this. The old way of onboarding is broken. You spend weeks on setup.",
        segments: [
          { startSec: 0, endSec: 2, text: "Wait for this." },
          { startSec: 2, endSec: 8, text: "The old way of onboarding is broken." },
          { startSec: 8, endSec: 15, text: "You spend weeks on setup." }
        ]
      }
    });
    const result = await runCycle(config);

    // One source video, remixed once, queued once per target platform.
    expect(result.candidatesFound).toBe(1);
    expect(result.reviewItemsCreated).toBe(config.platforms.length * config.outputVariants);

    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    // The source transcript text flows through to the review item, proving the remix
    // started from the user's pasted video rather than auto-discovered candidates.
    expect(queue.every((item: { sourceTranscriptText: string }) => item.sourceTranscriptText === config.sourceTranscript!.text)).toBe(true);
  });

  it("live mode, all discovery sources blocked: completes gracefully with zero results instead of crashing", async () => {
    // tiktok/meta discovery throw "not wired up" without API credentials configured —
    // the conductor's per-platform try/catch should absorb that, not propagate it.
    const result = await runCycle(baseConfig({ dryRun: false, platforms: ["tiktok"], maxCandidates: 1 }));
    expect(result.candidatesFound).toBe(0);
    expect(result.reviewItemsCreated).toBe(0);
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("a candidate whose script rewrite throws is skipped, not fatal to the run — other candidates still produce items", async () => {
    vi.mocked(rewriteScript).mockRejectedValue(new Error("simulated script-agent failure"));
    const config = baseConfig({ maxCandidates: 2 });
    const result = await runCycle(config);

    expect(result.candidatesFailed).toBe(1);
    expect(result.platformsFailed ?? 0).toBe(0);
    expect(result.reviewItemsCreated).toBe(0);
    // The run still completes and writes a manifest — it does not throw/crash.
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("a platform whose QA scoring throws is skipped, not fatal to the run — other platforms for the same candidate still succeed", async () => {
    vi.mocked(scoreVideo).mockImplementation(async (...args) => {
      const [assembled] = args;
      if (assembled.platform === "tiktok") throw new Error("simulated qa-agent failure");
      const actual = await vi.importActual<typeof import("./agents/qa-agent.js")>("./agents/qa-agent.js");
      return actual.scoreVideo(...args);
    });
    const config = baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1 });
    const result = await runCycle(config);

    expect(result.candidatesFailed ?? 0).toBe(0);
    expect(result.platformsFailed).toBe(config.outputVariants); // one failed platform per variant
    expect(result.reviewItemsCreated).toBe(config.outputVariants); // youtube_shorts still went through for each variant
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("dry-run: every review item carries the niche and a script with a non-empty hook", async () => {
    const config = baseConfig({ niche: "personal finance", maxCandidates: 1 });
    await runCycle(config);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    for (const item of queue) {
      expect(item.niche).toBe("personal finance");
      expect(item.script.hook.length).toBeGreaterThan(0);
    }
  });

  it("dry-run: threads resolved product, creator, and template context through every agent and retains template QA metadata", async () => {
    const now = new Date().toISOString();
    const product: ProductProfile = {
      id: "product-template-1", orgId: "org-template-1", clientId: "client-template-1", name: "Recovery Balm",
      description: "A cooling post-workout balm.", shortDescription: "Cooling recovery balm.", productCategory: "fitness",
      targetCustomer: "active adults", customerPain: "sore muscles", primaryBenefits: ["cooling comfort"], features: ["roll-on applicator"],
      claims: ["cooling comfort"], forbiddenClaims: ["cures pain"], differentiators: ["mess-free roll-on"], callToAction: "See the recovery routine.",
      productImages: [], extractedImageUrls: [], extractionStatus: "manual", createdAt: now, updatedAt: now
    };
    const creator: CreatorProfile = {
      id: "creator-template-1", orgId: "org-template-1", clientId: "client-template-1", displayName: "Maya",
      description: "Fitness creator", referenceImages: [], avatarMode: "reference_images", compatibleVendors: [], speechStyle: "friendly and direct",
      tone: "encouraging", wardrobe: "athleisure", visualStyle: "handheld gym diary", language: "en", prohibitedDepictions: [], faceEmbeddingStatus: "none", lipSyncVendor: "none",
      consentConfirmed: true, active: true, createdAt: now, updatedAt: now
    };
    const template = getUgcTemplate("testimonial")!;
    const config = baseConfig({
      maxCandidates: 1,
      orgId: product.orgId,
      clientId: product.clientId,
      productProfileId: product.id,
      productProfile: product,
      creatorProfileId: creator.id,
      creatorProfile: creator,
      // Deliberately stale: the conductor must retain the ID of the resolved
      // template object, never persist contradictory template metadata.
      templateId: "unboxing",
      template
    });

    const result = await runCycle(config);

    expect(result.reviewItemsCreated).toBe(2);
    expect(rewriteScript).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ productProfile: product, creatorProfile: creator, template }));
    expect(generateCaptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ template }));
    expect(scoreVideo).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ productProfile: product, creatorProfile: creator, template }));

    const [item] = JSON.parse(readFileSync(testDbPath, "utf-8"));
    expect(item).toMatchObject({ productProfileId: product.id, templateId: template.id, template });
    expect(item.structuralScore).toEqual(expect.any(Number));
  });

  it("writes a cost ledger alongside the manifest, with zero cost in dry-run (no vendor calls made)", async () => {
    const result = await runCycle(baseConfig({ maxCandidates: 1 }));
    expect(result.costLedgerPath).toBeDefined();
    expect(existsSync(result.costLedgerPath!)).toBe(true);
    const ledger = JSON.parse(readFileSync(result.costLedgerPath!, "utf-8"));
    expect(ledger.totalUsd).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  describe("Alibaba vendor end-to-end (dry-run)", () => {
    it("runs the mock pipeline and attributes clips to Alibaba", async () => {
      const result = await runCycle(baseConfig({ videoVendor: "alibaba", maxCandidates: 1 }));
      expect(result.reviewItemsCreated).toBeGreaterThanOrEqual(1);
      const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
      expect(queue.flatMap((item: { clips?: { vendor: string }[] }) => item.clips ?? []).every((clip: { vendor: string }) => clip.vendor === "alibaba")).toBe(true);
    });
  });

  describe("onProgress", () => {
    it("emits a human-readable line for discovery, each candidate stage, and each queued item — never silent between start and finish", async () => {
      const messages: string[] = [];
      const config = baseConfig({ platforms: ["tiktok"], maxCandidates: 1 });
      await runCycle(config, { onProgress: (m) => messages.push(m) });

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toContain("Discovering candidates");
      expect(messages.some((m) => m.startsWith("Found "))).toBe(true);
      expect(messages.some((m) => m.includes("[1/1] Transcribing"))).toBe(true);
      expect(messages.some((m) => m.includes("[1/1] Rewriting script"))).toBe(true);
      expect(messages.some((m) => m.includes("✓ Queued for review"))).toBe(true);
    });

    it("emits one progress line per clip (not just once per platform) — the mock script has multiple segments, so this catches the multi-clip 'looks hung' gap", async () => {
      const messages: string[] = [];
      const config = baseConfig({ platforms: ["tiktok"], maxCandidates: 1 });
      const result = await runCycle(config, { onProgress: (m) => messages.push(m) });
      expect(result.reviewItemsCreated).toBe(2); // one item for each default angle

      const clipLines = messages.filter((m) => /clip \d+\/\d+/.test(m));
      // mock script = hook + 2 points + cta = 4 segments/clips (see script-agent.ts's mockRewrittenScript)
      expect(clipLines).toHaveLength(8); // two variants x four clips, generated in bounded parallel batches
      expect(clipLines.some((m) => m.includes("variant 1"))).toBe(true);
      expect(clipLines.some((m) => m.includes("variant 2"))).toBe(true);
      expect(messages.filter((m) => m.includes("Assembling video (tiktok)")).length).toBe(2);
      expect(messages.filter((m) => m.includes("Scoring quality (tiktok)")).length).toBe(2);
    });

    it("emits a failure line (not silence) when a candidate's script rewrite throws", async () => {
      vi.mocked(rewriteScript).mockRejectedValue(new Error("simulated script-agent failure"));
      const messages: string[] = [];
      await runCycle(baseConfig({ maxCandidates: 1 }), { onProgress: (m) => messages.push(m) });

      expect(messages.some((m) => m.includes("✗ Failed"))).toBe(true);
    });

    it("defaults to a silent no-op when onProgress isn't provided — existing callers are unaffected", async () => {
      await expect(runCycle(baseConfig({ maxCandidates: 1 }))).resolves.toBeDefined();
    });
  });

  it("live mode at the DEFAULT $25 cap × 2 platforms × 2 variants: no premature CostCapExceededError — reservations reconcile against actual spend", async () => {
    // Pre-fix, reserveVideoGenBudget floored EVERY vendor in the chain at ≥$1/clip,
    // so the default [kling, gemini, replicate] chain reserved ≥$3/clip × 4 clips =
    // ≥$12 per platform iteration with no refund path (CostCap had no release), and
    // the 3rd of 4 iterations breached the $25 cap — a spurious halt well under the
    // real spend (~$5.60 of actual kling clips for the whole run).
    vi.mocked(rewriteScript).mockImplementation(async (_transcript, opts) => ({
      videoId: "placeholder", // conductor stamps the real per-variant videoId
      hook: "[mock] Wait, nobody told you this about fitness?",
      points: [
        "[mock] the first point that changes everything.",
        "[mock] and here's why that actually matters."
      ],
      cta: "[mock] Follow for part 2.",
      durationSec: opts.durationSec,
      brandVoice: opts.brandVoice,
      locale: opts.locale ?? "en",
      trendingPhrases: ["no cap", "wait for it"]
    }));
    vi.mocked(generateCaptions).mockResolvedValue([
      { startSec: 0, endSec: 6.25, text: "[mock] hook" },
      { startSec: 6.25, endSec: 12.5, text: "[mock] point 1" },
      { startSec: 12.5, endSec: 18.75, text: "[mock] point 2" },
      { startSec: 18.75, endSec: 25, text: "[mock] cta" }
    ]);
    vi.mocked(scoreVideo).mockResolvedValue({ score: 85, flags: [] });

    const messages: string[] = [];
    const config = baseConfig({
      dryRun: false, // live mode: reservations, vendor attempts, and reconcile are real
      platforms: ["tiktok", "youtube_shorts"],
      maxCandidates: 1,
      outputVariants: 2,
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ", // provenance only — transcript below pre-resolves it
      sourceTranscript: {
        videoId: "dQw4w9WgXcQ",
        source: "platform_captions",
        text: "Wait for this. The old way of onboarding is broken. You spend weeks on setup.",
        segments: [
          { startSec: 0, endSec: 2, text: "Wait for this." },
          { startSec: 2, endSec: 8, text: "The old way of onboarding is broken." },
          { startSec: 8, endSec: 15, text: "You spend weeks on setup." }
        ]
      }
      // capConfig omitted entirely → DEFAULT maxCostPerRunUsd ($25)
    });
    const result = await runCycle(config, { onProgress: (m) => messages.push(m) });

    expect(result.reviewItemsCreated).toBe(config.platforms.length * config.outputVariants);
    expect(result.candidatesFailed ?? 0).toBe(0);
    expect(result.platformsFailed ?? 0).toBe(0);
    expect(messages.some((m) => m.includes("COST CAP HIT"))).toBe(false);
    // Live mode really recorded billable clip usage (not silently $0 as in dry-run),
    // and it still fits the default cap once reservations are reconciled to actuals.
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.estimatedCostUsd!).toBeLessThanOrEqual(25);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.failures ?? []).toEqual([]);
  });

  it("one variant's script rewrite failure skips only that variant — the sibling variant's work still reaches review, with the failure reported (not swallowed)", async () => {
    vi.mocked(rewriteScript).mockImplementation(async (_transcript, opts) => {
      if (opts.angle?.startsWith("main angle")) throw new Error("simulated variant-1 rewrite failure");
      return {
        videoId: "placeholder",
        hook: "[mock] Wait, nobody told you this about fitness?",
        points: ["[mock] first point.", "[mock] second point."],
        cta: "[mock] Follow for part 2.",
        durationSec: opts.durationSec,
        brandVoice: opts.brandVoice,
        locale: opts.locale ?? "en",
        trendingPhrases: ["no cap", "wait for it"]
      };
    });
    const messages: string[] = [];
    const config = baseConfig({ platforms: ["tiktok"], maxCandidates: 1, outputVariants: 2 });
    const result = await runCycle(config, { onProgress: (m) => messages.push(m) });

    // Sibling variant's already-successful work is kept, not discarded.
    expect(result.reviewItemsCreated).toBe(1);
    expect(result.candidatesFailed ?? 0).toBe(0);
    expect(result.platformsFailed ?? 0).toBe(0);
    // Failure is reported through the same channels the clip/platform paths use.
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.failures).toHaveLength(1);
    expect(manifest.failures[0]).toMatchObject({
      reason: expect.stringContaining("variant 1 script rewrite failed")
    });
    expect(manifest.failures[0].reason).toContain("simulated variant-1 rewrite failure");
    expect(messages.some((m) => m.includes("✗") && m.includes("variant 1"))).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  describe("voiceover (opt-in, additive)", () => {
    it("never attempts voiceover generation when voiceVendor is unset — current behavior is fully unchanged", async () => {
      const result = await runCycle(baseConfig({ voiceVendor: undefined, maxCandidates: 1 }));
      expect(generateVoiceoverTrack).not.toHaveBeenCalled();
      expect(result.reviewItemsCreated).toBeGreaterThan(0);
    });

    it(
      "dry-run with voiceVendor set: generates a voiceover track once per candidate (not per platform) using the mock adapter, no credentials needed",
      async () => {
        const config = baseConfig({ voiceVendor: "elevenlabs", platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1 });
        const result = await runCycle(config);

        // one candidate, two platforms — voiceover must be generated once, then reused,
        // not once per platform (captions/script are already shared the same way).
        expect(generateVoiceoverTrack).toHaveBeenCalledTimes(2); // separate narration for each script variant
        expect(result.reviewItemsCreated).toBe(4); // two variants across both platforms
      },
      // Real ffprobe/ffmpeg subprocesses per cue, even in dry-run — deliberate (see
      // mock.ts), so this is genuinely slower than the default 5s test timeout.
      30000
    );

    it(
      "generates voiceover per distinct angle, reusing each across platforms",
      async () => {
        const config = baseConfig({ voiceVendor: "grok", platforms: ["tiktok", "youtube_shorts"], maxCandidates: 2 });
        await runCycle(config);
        expect(generateVoiceoverTrack).toHaveBeenCalledTimes(config.outputVariants);
      },
      30000
    );

    it("a voiceover generation failure does not fail the candidate — falls back to no narration for it, same reviewItemsCreated as without voiceover at all", async () => {
      vi.mocked(generateVoiceoverTrack).mockRejectedValue(new Error("simulated TTS vendor failure"));
      const config = baseConfig({ voiceVendor: "elevenlabs", maxCandidates: 1 });

      const result = await runCycle(config);

      expect(result.reviewItemsCreated).toBeGreaterThan(0);
      expect(result.candidatesFailed ?? 0).toBe(0);
    });

    it("a voiceover failure is reported via onProgress, not silently swallowed", async () => {
      vi.mocked(generateVoiceoverTrack).mockRejectedValue(new Error("simulated TTS vendor failure"));
      const messages: string[] = [];
      await runCycle(baseConfig({ voiceVendor: "elevenlabs", maxCandidates: 1 }), { onProgress: (m) => messages.push(m) });

      expect(messages.some((m) => m.includes("Voiceover failed"))).toBe(true);
    });
  });
});
