import { describe, it, expect } from "vitest";
import {
  // Feedback loop
  computeViralityScore,
  itemsDueForSnapshot,
  assessPerformance,
  type PerformanceRecord,
  type ViralityFactors,
  // Hook registry
  classifyHook,
  registerHook,
  recordDecision,
  importFromDiscovery,
  getTopHooks,
  suggestCategories,
  type HookRegistry,
  // Growth memory
  createGrowthMemory,
  learnFromJob,
  forecast,
  pruneMemory,
  // Adaptive prompt
  buildAdaptivePrompt,
  getDiversityTargets,
  // Concurrency cap
  Semaphore,
  CostCap,
  CostCapExceededError,
  FlowLimiter,
  executeCapped,
  DEFAULT_CAP_CONFIG,
} from "./index.js";

// ─── Feedback Loop Tests ────────────────────────────────────────────────────

describe("feedback-loop", () => {
  describe("computeViralityScore", () => {
    it("returns 0 for minimal engagement", () => {
      const factors: ViralityFactors = {
        engagementRate: 0,
        velocityScore: 0,
        completionRate: 0,
        shareRatio: 0,
        commentRatio: 0,
      };
      const score = computeViralityScore(factors);
      expect(score).toBeLessThan(10);
    });

    it("returns high score for viral-level engagement", () => {
      const factors: ViralityFactors = {
        engagementRate: 0.15,    // 15% — extremely high
        velocityScore: 2000,     // 2000 views/hr
        completionRate: 0.85,    // 85% watched to end
        shareRatio: 0.05,        // 5% shared
        commentRatio: 0.03,      // 3% commented
      };
      const score = computeViralityScore(factors);
      expect(score).toBeGreaterThan(80);
    });

    it("returns mid score for average engagement", () => {
      const factors: ViralityFactors = {
        engagementRate: 0.04,
        velocityScore: 200,
        completionRate: 0.5,
        shareRatio: 0.005,
        commentRatio: 0.005,
      };
      const score = computeViralityScore(factors);
      expect(score).toBeGreaterThan(20);
      expect(score).toBeLessThan(60);
    });
  });

  describe("itemsDueForSnapshot", () => {
    it("returns items that need their first 24h snapshot", () => {
      const now = new Date("2026-08-21T12:00:00Z");
      const records: PerformanceRecord[] = [{
        itemId: "test1",
        runId: "run1",
        platform: "tiktok",
        niche: "fitness",
        hook: "Stop doing crunches",
        qaScore: 85,
        approved: true,
        publishedAt: "2026-08-20T08:00:00Z", // 28 hours ago
        snapshots: [],
        createdAt: "2026-08-20T06:00:00Z",
      }];
      const due = itemsDueForSnapshot(records, undefined, now);
      expect(due).toHaveLength(1);
      expect(due[0].targetHours).toBe(24);
    });

    it("skips items already captured at target interval", () => {
      const now = new Date("2026-08-21T12:00:00Z");
      const records: PerformanceRecord[] = [{
        itemId: "test1",
        runId: "run1",
        platform: "tiktok",
        niche: "fitness",
        hook: "Stop doing crunches",
        qaScore: 85,
        approved: true,
        publishedAt: "2026-08-20T08:00:00Z",
        snapshots: [{
          capturedAt: "2026-08-21T09:00:00Z",
          hoursAfterPublish: 24,
          metrics: { views: 5000, likes: 400, comments: 50, shares: 20, saves: 30 },
        }],
        createdAt: "2026-08-20T06:00:00Z",
      }];
      const due = itemsDueForSnapshot(records, undefined, now);
      // Should now be waiting for 48h snapshot
      expect(due).toHaveLength(0); // Not 48h yet
    });
  });

  describe("assessPerformance", () => {
    it("computes virality and engagement from snapshots", () => {
      const record: PerformanceRecord = {
        itemId: "test1",
        runId: "run1",
        platform: "tiktok",
        niche: "fitness",
        hook: "Stop doing crunches",
        qaScore: 85,
        approved: true,
        publishedAt: "2026-08-20T08:00:00Z",
        snapshots: [{
          capturedAt: "2026-08-21T08:00:00Z",
          hoursAfterPublish: 24,
          metrics: { views: 50000, likes: 5000, comments: 500, shares: 200, saves: 300 },
        }],
        createdAt: "2026-08-20T06:00:00Z",
      };
      const result = assessPerformance(record);
      expect(result.viralityScore).toBeDefined();
      expect(result.viralityScore!).toBeGreaterThan(50);
      expect(result.engagementRate).toBeGreaterThan(0.1);
    });
  });
});

// ─── Hook Registry Tests ────────────────────────────────────────────────────

describe("hook-registry", () => {
  const baseRegistry = (): HookRegistry => ({
    version: 1,
    entries: [],
    totalHooksProcessed: 0,
    updatedAt: new Date().toISOString(),
  });

  describe("classifyHook", () => {
    it("classifies fear-based hooks", () => {
      const result = classifyHook("Don't make this mistake with your money");
      expect(result.primary).toBe("fear");
    });

    it("classifies curiosity hooks", () => {
      const result = classifyHook("Why nobody talks about this secret method");
      expect(result.primary).toBe("curiosity");
    });

    it("classifies question hooks", () => {
      const result = classifyHook("What would happen if you stopped scrolling?");
      expect(result.primary).toBe("question");
    });

    it("classifies contrarian hooks", () => {
      const result = classifyHook("Stop doing cardio. Here's why it's overrated.");
      expect(result.primary).toBe("contrarian");
    });

    it("classifies transformation hooks", () => {
      const result = classifyHook("I went from broke to $10K/month in 90 days");
      expect(result.primary).toBe("transformation");
    });

    it("returns secondary categories", () => {
      const result = classifyHook("Secret: I went from 0 to viral in one week");
      expect(result.secondary.length).toBeGreaterThan(0);
    });
  });

  describe("registerHook", () => {
    it("only registers hooks scoring 80+", () => {
      let reg = baseRegistry();
      reg = registerHook(reg, { text: "Bad hook", qaScore: 60, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      expect(reg.entries).toHaveLength(0);
      expect(reg.totalHooksProcessed).toBe(1);
    });

    it("registers high-scoring hooks", () => {
      let reg = baseRegistry();
      reg = registerHook(reg, { text: "Stop doing X right now", qaScore: 90, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      expect(reg.entries).toHaveLength(1);
      expect(reg.entries[0].category).toBe("contrarian");
      expect(reg.entries[0].confidenceScore).toBeGreaterThan(0);
    });

    it("deduplicates similar hooks", () => {
      let reg = baseRegistry();
      reg = registerHook(reg, { text: "Stop doing X right now!", qaScore: 90, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      reg = registerHook(reg, { text: "Stop doing X right now", qaScore: 85, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      expect(reg.entries).toHaveLength(1);
      expect(reg.entries[0].timesUsed).toBe(2);
    });
  });

  describe("recordDecision", () => {
    it("boosts confidence on approval", () => {
      let reg = baseRegistry();
      reg = registerHook(reg, { text: "Why nobody talks about this", qaScore: 90, platform: "tiktok", niche: "tech", source: "pipeline_qa" });
      const before = reg.entries[0].confidenceScore;
      reg = recordDecision(reg, "Why nobody talks about this", "approved");
      expect(reg.entries[0].timesApproved).toBe(1);
      expect(reg.entries[0].confidenceScore).toBeGreaterThanOrEqual(before);
    });
  });

  describe("importFromDiscovery", () => {
    it("adds discovery patterns with engagement > 5%", () => {
      let reg = baseRegistry();
      reg = importFromDiscovery(reg, [
        { hookText: "POV: You just discovered this hack", platform: "tiktok", niche: "tech", viewCount: 1000000, engagementRate: 0.12 },
        { hookText: "Meh hook", platform: "tiktok", niche: "tech", viewCount: 100, engagementRate: 0.01 },
      ]);
      expect(reg.entries).toHaveLength(1);
      expect(reg.entries[0].source).toBe("discovery");
    });
  });

  describe("getTopHooks", () => {
    it("returns hooks sorted by confidence", () => {
      let reg = baseRegistry();
      reg = registerHook(reg, { text: "Hook A low", qaScore: 80, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      reg = registerHook(reg, { text: "Hook B high score wins", qaScore: 98, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      const top = getTopHooks(reg, { limit: 2 });
      expect(top).toHaveLength(2);
      expect(top[0].confidenceScore).toBeGreaterThanOrEqual(top[1].confidenceScore);
    });
  });

  describe("suggestCategories", () => {
    it("returns diverse category suggestions", () => {
      const reg = baseRegistry();
      const suggestions = suggestCategories(reg, [], 4);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });
  });
});

// ─── Growth Memory Tests ────────────────────────────────────────────────────

describe("growth-memory", () => {
  describe("createGrowthMemory", () => {
    it("creates a valid empty memory", () => {
      const memory = createGrowthMemory();
      expect(memory.version).toBe(1);
      expect(memory.nicheInsights).toHaveLength(0);
      expect(memory.totalJobsProcessed).toBe(0);
    });
  });

  describe("learnFromJob", () => {
    it("creates niche insights from job results", () => {
      let memory = createGrowthMemory();
      memory = learnFromJob(memory, {
        runId: "run_1",
        niche: "fitness",
        platforms: ["tiktok"],
        items: [
          { hook: "Stop doing crunches", hookCategory: "contrarian", platform: "tiktok", qaScore: 92, approved: true, viralityScore: 75, durationSec: 25, trendingPhrases: ["gym bro"] },
          { hook: "Bad hook here", platform: "tiktok", qaScore: 40, approved: false, viralityScore: 15, durationSec: 20, trendingPhrases: [] },
        ],
      });
      expect(memory.totalJobsProcessed).toBe(1);
      expect(memory.nicheInsights).toHaveLength(1);
      expect(memory.nicheInsights[0].niche).toBe("fitness");
      expect(memory.nicheInsights[0].totalVideosProduced).toBe(2);
      expect(memory.nicheInsights[0].totalApproved).toBe(1);
      expect(memory.nicheInsights[0].winningAngles.length).toBeGreaterThan(0);
      expect(memory.nicheInsights[0].losingAngles.length).toBeGreaterThan(0);
    });

    it("accumulates across multiple jobs", () => {
      let memory = createGrowthMemory();
      memory = learnFromJob(memory, {
        runId: "run_1",
        niche: "fitness",
        platforms: ["tiktok"],
        items: [{ hook: "Hook 1", platform: "tiktok", qaScore: 85, approved: true, durationSec: 25, trendingPhrases: [] }],
      });
      memory = learnFromJob(memory, {
        runId: "run_2",
        niche: "fitness",
        platforms: ["tiktok"],
        items: [{ hook: "Hook 2", platform: "tiktok", qaScore: 90, approved: true, durationSec: 28, trendingPhrases: ["trend1"] }],
      });
      expect(memory.totalJobsProcessed).toBe(2);
      expect(memory.nicheInsights[0].totalVideosProduced).toBe(2);
    });
  });

  describe("forecast", () => {
    it("returns baseline forecast for new niche", () => {
      const memory = createGrowthMemory();
      const result = forecast(memory, { niche: "unknown", platform: "tiktok" });
      expect(result.predictedViralityScore).toBe(50);
      expect(result.insightStrength).toBe(0);
    });

    it("returns data-driven forecast for known niche", () => {
      let memory = createGrowthMemory();
      // Seed with multiple jobs
      for (let i = 0; i < 5; i++) {
        memory = learnFromJob(memory, {
          runId: `run_${i}`,
          niche: "fitness",
          platforms: ["tiktok"],
          items: [
            { hook: "Stop X now", hookCategory: "contrarian", platform: "tiktok", qaScore: 90, approved: true, viralityScore: 80, durationSec: 25, trendingPhrases: ["gym bro"] },
          ],
        });
      }
      const result = forecast(memory, { niche: "fitness", platform: "tiktok" });
      expect(result.dataPointsUsed).toBe(5);
      expect(result.insightStrength).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe("pruneMemory", () => {
    it("removes stale trend signals", () => {
      let memory = createGrowthMemory();
      memory.trendSignals.push({
        signal: "old trend",
        type: "topic",
        platforms: ["tiktok"],
        strength: 20,
        direction: "fading",
        firstSeen: "2025-01-01T00:00:00Z",
        lastSeen: "2025-01-05T00:00:00Z",
      });
      memory.trendSignals.push({
        signal: "current trend",
        type: "topic",
        platforms: ["tiktok"],
        strength: 80,
        direction: "peaking",
        firstSeen: "2026-08-15T00:00:00Z",
        lastSeen: "2026-08-20T00:00:00Z",
      });
      memory = pruneMemory(memory, 90);
      expect(memory.trendSignals).toHaveLength(1);
      expect(memory.trendSignals[0].signal).toBe("current trend");
    });
  });
});

// ─── Adaptive Prompt Tests ──────────────────────────────────────────────────

describe("adaptive-prompt", () => {
  describe("buildAdaptivePrompt", () => {
    it("returns empty injection when no data exists", () => {
      const registry: HookRegistry = { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };
      const memory = createGrowthMemory();
      const result = buildAdaptivePrompt(registry, memory, { niche: "fitness", platform: "tiktok" });
      expect(result.fullInjection).toBe("");
    });

    it("returns rich injection when data exists", () => {
      let registry: HookRegistry = { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };
      registry = registerHook(registry, { text: "Stop doing crunches NOW", qaScore: 95, platform: "tiktok", niche: "fitness", source: "pipeline_qa" });
      let memory = createGrowthMemory();
      memory = learnFromJob(memory, {
        runId: "run1",
        niche: "fitness",
        platforms: ["tiktok"],
        items: [{ hook: "Stop doing crunches NOW", hookCategory: "contrarian", platform: "tiktok", qaScore: 95, approved: true, viralityScore: 80, durationSec: 25, trendingPhrases: [] }],
      });
      const result = buildAdaptivePrompt(registry, memory, { niche: "fitness", platform: "tiktok" });
      expect(result.fullInjection).toContain("ADAPTIVE INTELLIGENCE");
      expect(result.hookExamples).toContain("CONTRARIAN");
    });
  });

  describe("getDiversityTargets", () => {
    it("returns diverse targets up to batch size", () => {
      const registry: HookRegistry = { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };
      const memory = createGrowthMemory();
      const targets = getDiversityTargets(registry, memory, { niche: "fitness", platforms: ["tiktok", "instagram_reels"], batchSize: 8 });
      expect(targets).toHaveLength(8);
      // Verify diversity: not all same category
      const categories = new Set(targets.map((t) => t.hookCategory));
      expect(categories.size).toBeGreaterThan(1);
    });

    it("caps at 8 even if more requested", () => {
      const registry: HookRegistry = { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };
      const memory = createGrowthMemory();
      const targets = getDiversityTargets(registry, memory, { niche: "fitness", platforms: ["tiktok"], batchSize: 20 });
      expect(targets).toHaveLength(8);
    });
  });
});

// ─── Concurrency Cap Tests ──────────────────────────────────────────────────

describe("concurrency-cap", () => {
  describe("Semaphore", () => {
    it("allows up to N concurrent permits", async () => {
      const sem = new Semaphore(2);
      await sem.acquire();
      await sem.acquire();
      expect(sem.available).toBe(0);
      sem.release();
      expect(sem.available).toBe(1);
    });

    it("queues when permits exhausted", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      let resolved = false;
      const promise = sem.acquire().then(() => { resolved = true; });
      expect(resolved).toBe(false);
      sem.release();
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe("CostCap", () => {
    it("throws when cost exceeds limit", () => {
      const cap = new CostCap(10);
      cap.record(5);
      cap.record(4);
      expect(() => cap.record(2)).toThrow(CostCapExceededError);
    });

    it("reports remaining budget", () => {
      const cap = new CostCap(25);
      cap.record(10);
      expect(cap.remaining).toBe(15);
      expect(cap.percentUsed).toBe(40);
    });

    it("fires warning at 80% usage", () => {
      let warned = false;
      const cap = new CostCap(10, () => { warned = true; });
      cap.record(8.5);
      expect(warned).toBe(true);
    });

    it("still counts the triggering amount in totalSpent after throwing", () => {
      // record() does `this.spent += costUsd` BEFORE checking the limit, so the
      // call that pushes spend over the cap is included in totalSpent even
      // though it threw — the cap prevents the caller from doing more paid
      // work, it doesn't undo the cost that was already incurred finding out.
      // ($25 cap, three $10 records — the third throws at $30 spent, not $20.)
      const cap = new CostCap(25);
      cap.record(10);
      cap.record(10);
      expect(() => cap.record(10)).toThrow(CostCapExceededError);
      expect(cap.totalSpent).toBe(30);
    });

    it("doesn't see spend recorded on a different instance for the same org (Phase 7, Gap 2)", () => {
      // CostCap is in-memory and per-process by design. Two workers (or two
      // requests handled by two separate processes) each construct their own
      // CostCap, so a $25 cap is really $25-per-worker, not $25-per-org,
      // whenever more than one worker is handling that org's runs at once.
      const workerACap = new CostCap(25);
      const workerBCap = new CostCap(25);
      workerACap.record(20);
      workerBCap.record(20);
      // Neither individually exceeded $25, so neither threw — but the org
      // actually spent $40 against a $25 intended ceiling. A single shared
      // CostCap would have thrown on the second $20. Fixing this for real
      // needs the same DB-backed reservation that Phase 7's quota-race gap
      // (apps/review-dashboard/src/billing-reservation.test.ts) is blocked on.
      expect(workerACap.totalSpent).toBe(20);
      expect(workerBCap.totalSpent).toBe(20);
      expect(workerACap.totalSpent + workerBCap.totalSpent).toBe(40);
    });
  });

  describe("FlowLimiter", () => {
    it("allows up to maxVideos", () => {
      const limiter = new FlowLimiter(8);
      for (let i = 0; i < 8; i++) {
        expect(limiter.canGenerate(`angle_${i}`)).toBe(true);
        limiter.record(`angle_${i}`);
      }
      expect(limiter.canGenerate("angle_9")).toBe(false);
      expect(limiter.totalVideos).toBe(8);
      expect(limiter.uniqueAngles).toBe(8);
    });

    it("prevents more than 2 of same angle", () => {
      const limiter = new FlowLimiter(8);
      limiter.record("same_angle");
      limiter.record("same_angle");
      expect(limiter.canGenerate("same_angle")).toBe(false);
      expect(limiter.canGenerate("different_angle")).toBe(true);
    });
  });

  describe("executeCapped", () => {
    it("respects maxVideosPerFlow = 8", async () => {
      const items = Array.from({ length: 12 }, (_, i) => ({ id: i }));
      const results = await executeCapped(
        items,
        async (item) => item.id * 2,
        { ...DEFAULT_CAP_CONFIG, maxVideosPerFlow: 8, vendorThrottleMs: 0 }
      );
      const completed = results.filter((r) => r.result !== undefined);
      const skipped = results.filter((r) => r.skipped);
      expect(completed).toHaveLength(8);
      expect(skipped).toHaveLength(4);
    });

    it("stops on CostCapExceededError", async () => {
      let callCount = 0;
      const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
      const results = await executeCapped(
        items,
        async () => {
          callCount++;
          if (callCount >= 3) throw new CostCapExceededError(26, 25);
          return "ok";
        },
        { ...DEFAULT_CAP_CONFIG, maxVideosPerFlow: 8, vendorThrottleMs: 0 }
      );
      const errors = results.filter((r) => r.error);
      const skipped = results.filter((r) => r.skipped);
      expect(errors).toHaveLength(1);
      expect(skipped).toHaveLength(2); // Remaining after cost cap
    });
  });
});
