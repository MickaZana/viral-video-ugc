/**
 * Static synthetic demo data for public /preview/* endpoints.
 *
 * These routes are unauthenticated (marketing site consumes them).
 * They must NEVER return real customer data. All values here are
 * clearly fictional and exist only to populate the marketing demo.
 */

export const DEMO_PREVIEW_STATS = {
  pending: 4,
  approved: 18,
  rejected: 2,
  estimatedCostUsd: 12.40
};

export const DEMO_PREVIEW_CREATORS = {
  creators: [
    { sourceId: "demo-1", label: "Fitness Motivation Daily", platform: "tiktok", niche: "fitness", views: 2_400_000, likes: 185_000, velocityScore: 92, runs: ["demo-run-1"] },
    { sourceId: "demo-2", label: "Clean Eating Tips", platform: "instagram_reels", niche: "nutrition", views: 1_800_000, likes: 142_000, velocityScore: 87, runs: ["demo-run-1"] },
    { sourceId: "demo-3", label: "Home Workout Queen", platform: "youtube_shorts", niche: "fitness", views: 3_100_000, likes: 220_000, velocityScore: 95, runs: ["demo-run-2"] },
    { sourceId: "demo-4", label: "Mindful Morning Routine", platform: "tiktok", niche: "wellness", views: 980_000, likes: 76_000, velocityScore: 78, runs: ["demo-run-2"] },
    { sourceId: "demo-5", label: "Budget Meal Prep", platform: "tiktok", niche: "nutrition", views: 1_500_000, likes: 112_000, velocityScore: 84, runs: ["demo-run-3"] },
    { sourceId: "demo-6", label: "5AM Club Vlog", platform: "youtube_shorts", niche: "productivity", views: 2_200_000, likes: 165_000, velocityScore: 89, runs: ["demo-run-3"] },
    { sourceId: "demo-7", label: "Skincare Science", platform: "instagram_reels", niche: "beauty", views: 4_500_000, likes: 340_000, velocityScore: 97, runs: ["demo-run-4"] },
    { sourceId: "demo-8", label: "Real Estate Hacks", platform: "tiktok", niche: "real_estate", views: 1_200_000, likes: 89_000, velocityScore: 81, runs: ["demo-run-4"] }
  ]
};

export const DEMO_PREVIEW_RUNS = [
  { runId: "demo-run-4", niche: "beauty", platforms: ["instagram_reels", "tiktok"], candidatesFound: 8, reviewItemsCreated: 6, createdAt: "2026-08-20T09:15:00Z", estimatedCostUsd: 3.20 },
  { runId: "demo-run-3", niche: "nutrition", platforms: ["tiktok", "youtube_shorts"], candidatesFound: 12, reviewItemsCreated: 8, createdAt: "2026-08-19T14:30:00Z", estimatedCostUsd: 4.10 },
  { runId: "demo-run-2", niche: "fitness", platforms: ["tiktok", "instagram_reels", "youtube_shorts"], candidatesFound: 15, reviewItemsCreated: 10, createdAt: "2026-08-18T11:00:00Z", estimatedCostUsd: 3.80 },
  { runId: "demo-run-1", niche: "fitness", platforms: ["tiktok", "instagram_reels"], candidatesFound: 10, reviewItemsCreated: 7, createdAt: "2026-08-17T08:45:00Z", estimatedCostUsd: 2.90 }
];

export const DEMO_PREVIEW_QUEUE = [
  { id: "demo-item-1", niche: "fitness", platform: "tiktok", score: 92, status: "approved", createdAt: "2026-08-20T10:00:00Z", script: { hook: "Stop doing crunches if you want visible abs — here's what actually works" } },
  { id: "demo-item-2", niche: "nutrition", platform: "instagram_reels", score: 87, status: "pending", createdAt: "2026-08-20T09:30:00Z", script: { hook: "I meal-prepped for $2.30 per meal — here's the exact breakdown" } },
  { id: "demo-item-3", niche: "beauty", platform: "tiktok", score: 95, status: "approved", createdAt: "2026-08-19T16:00:00Z", script: { hook: "Your dermatologist won't tell you this about retinol timing" } },
  { id: "demo-item-4", niche: "real_estate", platform: "youtube_shorts", score: 78, status: "pending", createdAt: "2026-08-19T14:00:00Z", script: { hook: "3 signs a listing is about to drop in price — most agents miss #2" } },
  { id: "demo-item-5", niche: "fitness", platform: "tiktok", score: 88, status: "approved", createdAt: "2026-08-18T12:00:00Z", script: { hook: "This 4-minute finisher burns more than 30 minutes of cardio" } },
  { id: "demo-item-6", niche: "wellness", platform: "instagram_reels", score: 72, status: "rejected", createdAt: "2026-08-18T10:00:00Z", script: { hook: "Morning cold plunge: the science vs. the hype" } }
];
