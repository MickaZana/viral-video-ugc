/**
 * Seed real viral source clips into the system so the yorbi-style onboarding /
 * Creator Spy / Dashboard have genuine data to drive the flow.
 *
 * Uses the existing YouTube Data API discovery adapter (sanctioned API — no ToS
 * scraping) to pull real Shorts for a niche, then writes them into a run
 * manifest under runs/<runId>/ exactly like a discovery-only run would — so
 * /creators, /runs and the Dashboard's TOP SOURCES + WORKFLOW RUNS surface them
 * with no code changes. Discovery-only: reviewItemsCreated stays 0 because no
 * scripts were rewritten (that step needs the funded LLM).
 *
 * Usage:
 *   pnpm --filter @vvugc/orchestrator exec tsx seed-viral.ts [niche] [limit]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@vvugc/shared-config";
import { discoverYouTube } from "@vvugc/mcp-discovery";

async function main() {
  const niche = process.argv[2] ?? "fitness";
  const limit = Math.min(Number(process.argv[3] ?? 10) || 10, 50);
  const { VVUGC_RUNS_DIR } = loadEnv();

  console.log(`Discovering ${limit} viral YouTube Shorts for "${niche}"...`);
  const candidates = await discoverYouTube(niche, limit);

  if (candidates.length === 0) {
    console.error("No candidates found — nothing written.");
    process.exitCode = 1;
    return;
  }

  const runId = randomUUID();
  const runDir = join(VVUGC_RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });

  // Attach a real thumbnail URL to each candidate. It's a non-schema extra key
  // (readers like creators.ts / runs.ts ignore unknown fields), giving the UI a
  // real video preview without touching the shared schema.
  const chosen = candidates.map((c) => ({
    ...c,
    thumbnailUrl: `https://i.ytimg.com/vi/${c.id}/hqdefault.jpg`
  }));

  const manifest = {
    config: {
      runId,
      niche,
      platforms: ["youtube_shorts"] as string[],
      dryRun: false,
      createdAt: new Date().toISOString()
    },
    candidatesFound: chosen.length,
    chosen,
    reviewItemsCreated: 0,
    candidatesFailed: 0,
    platformsFailed: 0
  };

  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${chosen.length} real source clips to runs/${runId}/manifest.json`);
  for (const c of chosen.slice(0, 5)) {
    console.log(`  - ${c.title}  (${(c.metrics.views ?? 0).toLocaleString()} views)  ${c.url}`);
  }
  if (chosen.length > 5) console.log(`  ... and ${chosen.length - 5} more`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
