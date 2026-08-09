import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

function item(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "item",
    runId: "e2e-run",
    niche: "fitness",
    videoPath: "/tmp/e2e.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "Wait, nobody told you this?",
      points: ["First point.", "Second point."],
      cta: "Follow for part 2.",
      durationSec: 25,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 82,
    flags: [],
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Seeds a fixed, known set of review items + one workflow run into the isolated
 * temp store this e2e suite boots the review-dashboard server against, so the
 * control-panel tabs render deterministic, real data rather than whatever mock
 * discovery would otherwise produce.
 */
export default async function globalSetup() {
  const runsDir = process.env.VVUGC_RUNS_DIR!;
  const runDir = join(runsDir, "e2e-run");
  mkdirSync(runDir, { recursive: true });

  // A real, playable video file for the History playback assertion — a 1-second
  // 320x240 black clip (libx264 + yuv420p so every browser can decode it).
  const videoPath = join(runDir, "video.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=320x240:d=1",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-an",
    videoPath
  ], { stdio: "ignore" });

  // One approved remake with a real video path (shows in History → Video Demos),
  // one pending item (drives Dashboard activity + History → Script Demos), and
  // one flagged low-scorer so score bars and flag states are exercised.
  await insertReviewItem(
    item({ id: "e2e-approved-video", status: "approved", videoPath, score: 88, platform: "tiktok" })
  );
  await insertReviewItem(
    item({
      id: "e2e-pending",
      status: "pending",
      videoPath,
      score: 71,
      platform: "youtube_shorts",
      niche: "fitness",
      script: {
        videoId: "v2",
        hook: "This warm-up is killing your gains",
        points: ["Point A.", "Point B."],
        cta: "Follow for the fix.",
        durationSec: 30,
        brandVoice: "energetic",
        locale: "en",
        trendingPhrases: []
      }
    })
  );
  await insertReviewItem(
    item({
      id: "e2e-flagged",
      status: "pending",
      videoPath,
      score: 35,
      niche: "e2e-flags-target",
      flags: ["hook_too_long"]
    })
  );

  // Run history comes from reading manifest.json files directly off disk
  // (runs.ts) — write one so Dashboard's run panel and History → Workflow Demos
  // have something real to render.
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      config: { niche: "fitness", platforms: ["tiktok"], createdAt: new Date().toISOString() },
      candidatesFound: 6,
      reviewItemsCreated: 3,
      candidatesFailed: 0,
      platformsFailed: 0,
      failures: []
    })
  );
}
