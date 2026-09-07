/**
 * feedback-loop.ts — Post-publish performance ingestion
 *
 * After a video is published, this module polls platform APIs at intervals
 * (24h, 48h, 72h, 7d) to capture real performance metrics. These are then
 * fed back into the growth-memory and hook-registry to evolve the pipeline.
 *
 * The feedback loop closes the gap between "we made a video" and "did it work?"
 */
import { z } from "zod";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const PlatformMetricsSnapshotSchema = z.object({
  views: z.number().nonnegative(),
  likes: z.number().nonnegative(),
  comments: z.number().nonnegative(),
  shares: z.number().nonnegative().default(0),
  saves: z.number().nonnegative().default(0),
  watchTimeAvgSec: z.number().nonnegative().optional(),
  completionRate: z.number().min(0).max(1).optional(),
  reachAccounts: z.number().nonnegative().optional(),
});
export type PlatformMetricsSnapshot = z.infer<typeof PlatformMetricsSnapshotSchema>;

export const PerformanceRecordSchema = z.object({
  /** The review-queue item ID */
  itemId: z.string(),
  runId: z.string(),
  platform: z.string(),
  niche: z.string(),
  /** The hook text used */
  hook: z.string(),
  /** Hook pattern category (e.g. "fear", "curiosity", "social_proof", "controversy", "open_loop") */
  hookPattern: z.string().optional(),
  /** Template used (if any) */
  templateId: z.string().optional(),
  /** QA score at creation time */
  qaScore: z.number().min(0).max(100),
  /** Was approved by human reviewer */
  approved: z.boolean(),
  /** Published post ID on platform */
  publishedPostId: z.string().optional(),
  publishedUrl: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  /** Metrics snapshots at different time intervals */
  snapshots: z.array(z.object({
    capturedAt: z.string().datetime(),
    hoursAfterPublish: z.number().nonnegative(),
    metrics: PlatformMetricsSnapshotSchema,
  })).default([]),
  /** Computed virality score (0-100) based on engagement velocity */
  viralityScore: z.number().min(0).max(100).optional(),
  /** Computed engagement rate */
  engagementRate: z.number().min(0).max(1).optional(),
  createdAt: z.string().datetime(),
});
export type PerformanceRecord = z.infer<typeof PerformanceRecordSchema>;

// ─── Virality Score Computation ─────────────────────────────────────────────

export interface ViralityFactors {
  engagementRate: number;     // (likes + comments + shares + saves) / views
  velocityScore: number;      // views per hour in first 24h
  completionRate: number;     // avg % of video watched
  shareRatio: number;         // shares / views
  commentRatio: number;       // comments / views
}

/**
 * Compute a 0-100 virality score from raw metrics.
 * Weighted formula tuned for short-form vertical content:
 * - Engagement velocity (views/hr in first 24h) = 30% weight
 * - Engagement rate (interactions/views) = 25% weight
 * - Share ratio = 20% weight (shares indicate content worth spreading)
 * - Comment ratio = 15% weight (comments = conversation = algorithm boost)
 * - Completion rate = 10% weight (people watched the whole thing)
 */
export function computeViralityScore(factors: ViralityFactors): number {
  // Normalize each factor to 0-1 scale using sigmoid-like curves
  const velocityNorm = sigmoid(factors.velocityScore, 300, 0.008);    // 300 views/hr = ~0.8
  const engagementNorm = sigmoid(factors.engagementRate, 0.05, 60);   // 5% engagement = ~0.7
  const shareNorm = sigmoid(factors.shareRatio, 0.01, 300);           // 1% share rate = ~0.8
  const commentNorm = sigmoid(factors.commentRatio, 0.01, 300);       // 1% comment rate = ~0.8
  const completionNorm = Math.min(factors.completionRate, 1);          // Direct 0-1

  const weighted =
    velocityNorm * 0.30 +
    engagementNorm * 0.25 +
    shareNorm * 0.20 +
    commentNorm * 0.15 +
    completionNorm * 0.10;

  return Math.round(Math.min(100, weighted * 100));
}

/** Smooth sigmoid normalization — value at midpoint ≈ 0.5 */
function sigmoid(value: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

// ─── Metrics Fetching (Platform API Adapters) ───────────────────────────────

export interface PlatformMetricsFetcher {
  platform: string;
  fetchMetrics(postId: string): Promise<PlatformMetricsSnapshot>;
}

/**
 * TikTok metrics fetcher — uses TikTok Content Posting API's video/query endpoint.
 * Requires TIKTOK_ACCESS_TOKEN with video.list scope.
 */
export class TikTokMetricsFetcher implements PlatformMetricsFetcher {
  platform = "tiktok" as const;

  constructor(private accessToken: string) {}

  async fetchMetrics(postId: string): Promise<PlatformMetricsSnapshot> {
    const res = await fetch("https://open.tiktokapis.com/v2/video/query/", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filters: { video_ids: [postId] },
        fields: ["view_count", "like_count", "comment_count", "share_count", "duration"],
      }),
    });
    if (!res.ok) throw new Error(`TikTok metrics fetch failed: ${res.status}`);
    const body = await res.json() as any;
    const video = body.data?.videos?.[0];
    if (!video) throw new Error(`TikTok video ${postId} not found`);
    return {
      views: video.view_count ?? 0,
      likes: video.like_count ?? 0,
      comments: video.comment_count ?? 0,
      shares: video.share_count ?? 0,
      saves: 0, // TikTok doesn't expose saves via API
    };
  }
}

/**
 * Meta (Instagram Reels / Facebook) metrics fetcher.
 * Requires META_PAGE_ACCESS_TOKEN with pages_read_engagement.
 */
export class MetaMetricsFetcher implements PlatformMetricsFetcher {
  platform = "instagram_reels" as const;

  constructor(private accessToken: string, private igBusinessAccountId?: string) {}

  async fetchMetrics(postId: string): Promise<PlatformMetricsSnapshot> {
    // Instagram media insights endpoint
    const fields = "impressions,reach,likes,comments,shares,saved,video_views";
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${postId}/insights?metric=${fields}&access_token=${this.accessToken}`
    );
    if (!res.ok) {
      // Fallback to basic media fields
      const basicRes = await fetch(
        `https://graph.facebook.com/v20.0/${postId}?fields=like_count,comments_count&access_token=${this.accessToken}`
      );
      if (!basicRes.ok) throw new Error(`Meta metrics fetch failed: ${res.status}`);
      const basic = await basicRes.json() as any;
      return {
        views: 0,
        likes: basic.like_count ?? 0,
        comments: basic.comments_count ?? 0,
        shares: 0,
        saves: 0,
      };
    }
    const body = await res.json() as any;
    const metrics = body.data?.reduce((acc: any, m: any) => {
      acc[m.name] = m.values?.[0]?.value ?? 0;
      return acc;
    }, {}) ?? {};
    return {
      views: metrics.video_views ?? metrics.impressions ?? 0,
      likes: metrics.likes ?? 0,
      comments: metrics.comments ?? 0,
      shares: metrics.shares ?? 0,
      saves: metrics.saved ?? 0,
      reachAccounts: metrics.reach ?? 0,
    };
  }
}

/**
 * YouTube Shorts metrics fetcher.
 * Requires YOUTUBE_ACCESS_TOKEN with youtube.readonly scope.
 */
export class YouTubeMetricsFetcher implements PlatformMetricsFetcher {
  platform = "youtube_shorts" as const;

  constructor(private accessToken: string) {}

  async fetchMetrics(postId: string): Promise<PlatformMetricsSnapshot> {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${postId}`,
      { headers: { "Authorization": `Bearer ${this.accessToken}` } }
    );
    if (!res.ok) throw new Error(`YouTube metrics fetch failed: ${res.status}`);
    const body = await res.json() as any;
    const stats = body.items?.[0]?.statistics;
    if (!stats) throw new Error(`YouTube video ${postId} not found`);
    return {
      views: parseInt(stats.viewCount ?? "0"),
      likes: parseInt(stats.likeCount ?? "0"),
      comments: parseInt(stats.commentCount ?? "0"),
      shares: 0, // YouTube doesn't expose shares
      saves: 0,
    };
  }
}

// ─── Feedback Collection Orchestrator ───────────────────────────────────────

export interface FeedbackCollectorConfig {
  /** Time intervals (hours after publish) to capture snapshots */
  snapshotIntervals: number[];
  /** Minimum virality score to consider a video "winning" */
  winningThreshold: number;
  /** Maximum age (days) to keep collecting feedback for */
  maxCollectionDays: number;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackCollectorConfig = {
  snapshotIntervals: [24, 48, 72, 168], // 1d, 2d, 3d, 7d
  winningThreshold: 70,
  maxCollectionDays: 14,
};

/**
 * Determines which published items need a new metric snapshot based on their
 * publish time and existing snapshots. Call this on a cron (e.g. every 6h) to
 * identify items due for a check-in.
 */
export function itemsDueForSnapshot(
  records: PerformanceRecord[],
  config: FeedbackCollectorConfig = DEFAULT_FEEDBACK_CONFIG,
  now: Date = new Date()
): Array<{ record: PerformanceRecord; targetHours: number }> {
  const due: Array<{ record: PerformanceRecord; targetHours: number }> = [];

  for (const record of records) {
    if (!record.publishedAt) continue;

    const publishDate = new Date(record.publishedAt);
    const hoursSincePublish = (now.getTime() - publishDate.getTime()) / (1000 * 60 * 60);

    // Skip if beyond max collection window
    if (hoursSincePublish > config.maxCollectionDays * 24) continue;

    const capturedHours = new Set(record.snapshots.map((s) => s.hoursAfterPublish));

    for (const targetHours of config.snapshotIntervals) {
      // Only collect if we've passed the target time and haven't captured it yet
      if (hoursSincePublish >= targetHours && !capturedHours.has(targetHours)) {
        due.push({ record, targetHours });
        break; // Only one snapshot per check cycle
      }
    }
  }

  return due;
}

/**
 * After collecting metrics, compute the final performance indicators.
 * This is called after the 72h or 7d snapshot to produce the final assessment.
 */
export function assessPerformance(record: PerformanceRecord): PerformanceRecord {
  if (record.snapshots.length === 0) return record;

  // Use the latest snapshot for assessment
  const latest = record.snapshots[record.snapshots.length - 1];
  const m = latest.metrics;
  const views = m.views || 1; // Prevent division by zero

  const hoursElapsed = latest.hoursAfterPublish || 24;
  const factors: ViralityFactors = {
    engagementRate: (m.likes + m.comments + m.shares + m.saves) / views,
    velocityScore: views / hoursElapsed,
    completionRate: m.completionRate ?? 0.5,
    shareRatio: m.shares / views,
    commentRatio: m.comments / views,
  };

  const viralityScore = computeViralityScore(factors);
  const engagementRate = factors.engagementRate;

  return { ...record, viralityScore, engagementRate };
}
