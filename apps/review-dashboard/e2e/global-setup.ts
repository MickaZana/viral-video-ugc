import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

function item(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: overrides.id ?? "item",
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
 * Seeds a fixed, known set of review items so the e2e specs can assert on exact
 * counts/labels rather than guessing at whatever mock discovery would produce.
 *
 * The `e2e-reject-target`/`e2e-approve-target` niches are each used by exactly
 * one test (reject and approve, respectively) — dedicated rather than shared,
 * so those mutating tests can assert against a niche-scoped count instead of
 * "the first item in the list", which would silently depend on execution order
 * and on which prior tests in the same run already mutated the shared list.
 */
export default async function globalSetup() {
  await insertReviewItem(item({ id: "fit-tiktok-1", niche: "fitness", platform: "tiktok", status: "pending" }));
  await insertReviewItem(item({ id: "fit-yt-1", niche: "fitness", platform: "youtube_shorts", status: "pending" }));
  await insertReviewItem(
    item({ id: "finance-tiktok-1", niche: "personal finance", platform: "tiktok", status: "pending" })
  );
  await insertReviewItem(item({ id: "fit-tiktok-approved", niche: "fitness", platform: "tiktok", status: "approved" }));
  await insertReviewItem(item({ id: "reject-target", niche: "e2e-reject-target", platform: "tiktok", status: "pending" }));
  await insertReviewItem(item({ id: "approve-target", niche: "e2e-approve-target", platform: "tiktok", status: "pending" }));
  // A known flag (with a curated label) and an unknown one (verifies the de-slugify
  // fallback for whatever slug the live QA agent's freeform Claude output might emit).
  await insertReviewItem(
    item({
      id: "flagged-item",
      niche: "e2e-flags-target",
      platform: "tiktok",
      status: "pending",
      score: 35,
      flags: ["hook_too_long", "some_new_flag_claude_invented"]
    })
  );

  // Run history comes from reading manifest.json files directly off disk (runs.ts),
  // not the review-queue store — write one by hand with a real failure reason so the
  // e2e suite can assert the dashboard actually surfaces it, not just the aggregate count.
  const runsDir = process.env.VVUGC_RUNS_DIR!;
  const failedRunDir = join(runsDir, "e2e-failed-run");
  mkdirSync(failedRunDir, { recursive: true });
  writeFileSync(
    join(failedRunDir, "manifest.json"),
    JSON.stringify({
      config: { niche: "e2e-failure-reasons", platforms: ["tiktok"], createdAt: new Date().toISOString() },
      candidatesFound: 2,
      reviewItemsCreated: 1,
      candidatesFailed: 1,
      platformsFailed: 0,
      failures: [{ candidateId: "e2e-cand-1", reason: "simulated script-agent failure for e2e" }]
    })
  );
}
