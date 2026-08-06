/**
 * ONE-OFF LIVE END-TO-END remix run (spends real money).
 * URL -> real transcript (yt-dlp auto-subs, free) -> LLM script rewrite ->
 * real video generation (higgsfield primary will fail w/o MCP and fall back to
 * Gemini, which is direct-REST + uses the repo-root .env GEMINI_API_KEY) ->
 * ffmpeg assembly -> LLM QA -> review queue (Postgres).
 *
 * Run from repo root or apps/orchestrator:
 *   node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs
 *     apps/orchestrator/remix-live.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import { RunConfigSchema } from "@vvugc/shared-schema";
import { fetchRemixTranscript, parseSourceUrl } from "./src/remix-source.js";
import { runCycle } from "./src/conductor.js";

loadEnv();

const SOURCE_URL =
  process.env.REMIX_SOURCE_URL ??
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // confirmed to have auto-subs
const NICHE = process.env.REMIX_NICHE ?? "personal finance";
const PLATFORMS = ["tiktok"] as const;

function repoRoot(): string {
  let dir = process.cwd();
  while (dir && !existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const next = dir.slice(0, dir.lastIndexOf("\\"));
    if (next === dir) break;
    dir = next;
  }
  return dir;
}

async function main() {
  const parsed = parseSourceUrl(SOURCE_URL);
  if (!parsed) throw new Error(`unsupported source URL: ${SOURCE_URL}`);
  console.log(`SOURCE: ${parsed.platform} video ${parsed.videoId}`);
  console.log(`NICHE : ${NICHE}`);

  console.log("\n[1/2] Fetching real transcript (free)...");
  const { transcript } = await fetchRemixTranscript(
    SOURCE_URL,
    join(repoRoot(), "runs", "remix-source"),
    NICHE
  );
  console.log(`      ${transcript.segments.length} cues, ${transcript.text.length} chars`);
  console.log(`      preview: "${transcript.text.slice(0, 160)}..."`);

  const config = RunConfigSchema.parse({
    runId: `remix-live-${randomUUID().slice(0, 8)}`,
    niche: NICHE,
    platforms: PLATFORMS,
    brandVoice: "confident, clear, slightly playful",
    targetDurationSec: 30,
    videoVendor: "higgsfield", // exercises the real fallback chain -> gemini
    voiceVendor: undefined,
    accountId: "live-remix-smoke",
    orgId: "live-remix-smoke",
    locale: "en",
    sourceUrl: SOURCE_URL,
    sourceTranscript: transcript,
    dryRun: false,
    createdAt: new Date().toISOString()
  });

  console.log("\n[2/2] Running full pipeline (dryRun=false — REAL vendor spend)...\n");
  const result = await runCycle(config, { onProgress: (m) => console.log(`  ${m}`) });

  console.log("\n=== RUN RESULT ===");
  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        reviewItemsCreated: result.reviewItemsCreated,
        candidatesFailed: result.candidatesFailed,
        platformsFailed: result.platformsFailed,
        estimatedCostUsd: result.estimatedCostUsd,
        manifestPath: result.manifestPath,
        costLedgerPath: result.costLedgerPath
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("\nLIVE REMIX FAILED:", err);
  process.exit(1);
});
