import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@vvugc/shared-schema";
import { runCycle } from "./conductor.js";

let testRunsDir: string;
let testDbPath: string;

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    niche: "fitness",
    platforms: ["tiktok"],
    brandVoice: "neutral, energetic, concise",
    targetDurationSec: 25,
    maxCandidates: 2,
    videoVendor: "higgsfield",
    dryRun: true,
    autoPost: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

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
  });

  it("dry-run: produces one review item per candidate x platform, and writes a readable manifest", async () => {
    const config = baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 2 });
    const result = await runCycle(config);

    expect(result.runId).toBe(config.runId);
    expect(result.candidatesFound).toBeGreaterThan(0);
    // reviewItemsCreated = min(candidatesFound, maxCandidates) chosen candidates x platforms
    const chosenCount = Math.min(result.candidatesFound, config.maxCandidates);
    expect(result.reviewItemsCreated).toBe(chosenCount * config.platforms.length);

    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.reviewItemsCreated).toBe(result.reviewItemsCreated);

    expect(existsSync(testDbPath)).toBe(true);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    expect(queue).toHaveLength(result.reviewItemsCreated);
    expect(queue.every((item: { status: string }) => item.status === "pending")).toBe(true);
  });

  it("dry-run: scales linearly with maxCandidates", async () => {
    const result = await runCycle(baseConfig({ maxCandidates: 1 }));
    expect(result.reviewItemsCreated).toBe(1);
  });

  it("live mode, all discovery sources blocked: completes gracefully with zero results instead of crashing", async () => {
    // tiktok/meta discovery throw "not wired up" without API credentials configured —
    // the conductor's per-platform try/catch should absorb that, not propagate it.
    const result = await runCycle(baseConfig({ dryRun: false, platforms: ["tiktok"], maxCandidates: 1 }));
    expect(result.candidatesFound).toBe(0);
    expect(result.reviewItemsCreated).toBe(0);
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
});
