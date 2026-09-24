#!/usr/bin/env tsx
/**
 * collect-feedback.ts — Scheduled feedback collector
 *
 * Run this on a cron (e.g. every 6 hours) to:
 * 1. Find published items that need performance snapshots
 * 2. Fetch metrics from TikTok/Meta/YouTube APIs
 * 3. Assess virality scores
 * 4. Update the growth memory and hook registry with real performance data
 *
 * Usage:
 *   pnpm tsx scripts/collect-feedback.ts
 *   # or via cron:
 *   Run every six hours: cd /path/to/vvugc && pnpm tsx scripts/collect-feedback.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import { listReviewItems } from "@vvugc/review-queue";
import {
  itemsDueForSnapshot,
  assessPerformance,
  TikTokMetricsFetcher,
  MetaMetricsFetcher,
  YouTubeMetricsFetcher,
  recordPerformance as recordHookPerformance,
  recordDecision,
  learnFromJob,
  HookRegistrySchema,
  GrowthMemorySchema,
  createGrowthMemory,
  type PerformanceRecord,
  type HookRegistry,
  type GrowthMemory,
  type PlatformMetricsFetcher,
} from "@vvugc/shared-analytics";

const { VVUGC_RUNS_DIR } = loadEnv();
const analyticsDir = join(VVUGC_RUNS_DIR, "_analytics");
mkdirSync(analyticsDir, { recursive: true });

const hookRegistryPath = join(analyticsDir, "hook-registry.json");
const growthMemoryPath = join(analyticsDir, "growth-memory.json");
const performanceDbPath = join(analyticsDir, "performance-records.json");

// ─── Load State ─────────────────────────────────────────────────────────────

let hookRegistry: HookRegistry = existsSync(hookRegistryPath)
  ? HookRegistrySchema.parse(JSON.parse(readFileSync(hookRegistryPath, "utf-8")))
  : { version: 1, entries: [], totalHooksProcessed: 0, updatedAt: new Date().toISOString() };

let growthMemory: GrowthMemory = existsSync(growthMemoryPath)
  ? GrowthMemorySchema.parse(JSON.parse(readFileSync(growthMemoryPath, "utf-8")))
  : createGrowthMemory();

const performanceRecords: PerformanceRecord[] = existsSync(performanceDbPath)
  ? JSON.parse(readFileSync(performanceDbPath, "utf-8"))
  : [];

// ─── Initialize Fetchers ────────────────────────────────────────────────────

const fetchers: Map<string, PlatformMetricsFetcher> = new Map();

if (process.env.TIKTOK_ACCESS_TOKEN) {
  fetchers.set("tiktok", new TikTokMetricsFetcher(process.env.TIKTOK_ACCESS_TOKEN));
}
if (process.env.META_PAGE_ACCESS_TOKEN) {
  fetchers.set("instagram_reels", new MetaMetricsFetcher(process.env.META_PAGE_ACCESS_TOKEN));
  fetchers.set("facebook", new MetaMetricsFetcher(process.env.META_PAGE_ACCESS_TOKEN));
}
if (process.env.YOUTUBE_ACCESS_TOKEN) {
  fetchers.set("youtube_shorts", new YouTubeMetricsFetcher(process.env.YOUTUBE_ACCESS_TOKEN));
}

// ─── Sync Approved/Rejected Items into Performance DB ───────────────────────

async function syncReviewItems(): Promise<void> {
  const items = await listReviewItems();
  const published = items.filter((i) => i.publishedPostId && i.publishedAt);
  const existingIds = new Set(performanceRecords.map((r) => r.itemId));

  let newRecords = 0;
  for (const item of published) {
    if (existingIds.has(item.id)) continue;

    performanceRecords.push({
      itemId: item.id,
      runId: item.runId,
      platform: item.platform,
      niche: item.niche,
      hook: item.script.hook,
      qaScore: item.score,
      approved: item.status === "approved",
      publishedPostId: item.publishedPostId,
      publishedUrl: item.publishedUrl,
      publishedAt: item.publishedAt,
      snapshots: [],
      createdAt: new Date().toISOString(),
    });
    newRecords++;
  }

  // Also record approve/reject decisions for hooks (even unpublished)
  for (const item of items) {
    if (item.status === "approved" || item.status === "rejected") {
      hookRegistry = recordDecision(hookRegistry, item.script.hook, item.status);
    }
  }

  if (newRecords > 0) {
    console.log(`Synced ${newRecords} new published items into performance tracking`);
  }
}

// ─── Collect Metrics ────────────────────────────────────────────────────────

async function collectMetrics(): Promise<void> {
  const due = itemsDueForSnapshot(performanceRecords);
  if (due.length === 0) {
    console.log("No items due for metric collection");
    return;
  }

  console.log(`${due.length} item(s) due for metric snapshots`);
  let collected = 0;
  let failed = 0;

  for (const { record, targetHours } of due) {
    const fetcher = fetchers.get(record.platform);
    if (!fetcher || !record.publishedPostId) {
      continue;
    }

    try {
      const metrics = await fetcher.fetchMetrics(record.publishedPostId);
      record.snapshots.push({
        capturedAt: new Date().toISOString(),
        hoursAfterPublish: targetHours,
        metrics,
      });

      // Assess performance with the new snapshot
      const assessed = assessPerformance(record);
      Object.assign(record, assessed);

      // Feed virality score back to hook registry
      if (assessed.viralityScore !== undefined) {
        hookRegistry = recordHookPerformance(hookRegistry, record.hook, assessed.viralityScore);
      }

      collected++;
      console.log(
        `  ✓ ${record.platform} item ${record.itemId.slice(0, 8)}: ` +
        `${metrics.views} views, ${metrics.likes} likes at ${targetHours}h — ` +
        `virality: ${assessed.viralityScore ?? "n/a"}/100`
      );
    } catch (err) {
      failed++;
      console.error(`  ✗ Failed to fetch metrics for ${record.itemId.slice(0, 8)}: ${String(err)}`);
    }
  }

  console.log(`Collected: ${collected}, Failed: ${failed}`);
}

// ─── Update Growth Memory ───────────────────────────────────────────────────

function updateGrowthMemory(): void {
  // Group performance records by run for learning
  const byRun: Map<string, PerformanceRecord[]> = new Map();
  for (const record of performanceRecords) {
    if (!byRun.has(record.runId)) byRun.set(record.runId, []);
    byRun.get(record.runId)!.push(record);
  }

  // Learn from records that have at least 24h of data
  for (const [runId, records] of byRun) {
    const matureRecords = records.filter(
      (r) => r.snapshots.length > 0 && r.viralityScore !== undefined
    );
    if (matureRecords.length === 0) continue;

    const niches = [...new Set(matureRecords.map((r) => r.niche))];
    const platforms = [...new Set(matureRecords.map((r) => r.platform))];

    growthMemory = learnFromJob(growthMemory, {
      runId,
      niche: niches[0] ?? "unknown",
      platforms,
      items: matureRecords.map((r) => ({
        hook: r.hook,
        hookCategory: r.hookPattern as any,
        platform: r.platform,
        qaScore: r.qaScore,
        approved: r.approved,
        viralityScore: r.viralityScore,
        durationSec: 25, // Default — would need to join with review item
        trendingPhrases: [],
      })),
    });
  }
}

// ─── Persist State ──────────────────────────────────────────────────────────

function saveState(): void {
  writeFileSync(hookRegistryPath, JSON.stringify(hookRegistry, null, 2));
  writeFileSync(growthMemoryPath, JSON.stringify(growthMemory, null, 2));
  writeFileSync(performanceDbPath, JSON.stringify(performanceRecords, null, 2));
  console.log("\nState persisted:");
  console.log(`  Hook Registry: ${hookRegistry.entries.length} entries`);
  console.log(`  Growth Memory: ${growthMemory.totalJobsProcessed} jobs, ${growthMemory.nicheInsights.length} niche insights`);
  console.log(`  Performance DB: ${performanceRecords.length} records`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ VVUGC Feedback Collector ═══");
  console.log(`Available fetchers: ${[...fetchers.keys()].join(", ") || "none (set API tokens to enable)"}`);
  console.log();

  await syncReviewItems();
  await collectMetrics();
  updateGrowthMemory();
  saveState();

  console.log("\n═══ Done ═══");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
