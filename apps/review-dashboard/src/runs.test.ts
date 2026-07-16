import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns } from "./runs.js";

let testDir: string;

function writeRun(runId: string, manifest: object, costLedger?: object) {
  const dir = join(testDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  if (costLedger) writeFileSync(join(dir, "cost-ledger.json"), JSON.stringify(costLedger));
}

describe("listRuns", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-runs-test-"));
    process.env.VVUGC_RUNS_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns an empty list when the runs dir doesn't exist yet", () => {
    rmSync(testDir, { recursive: true, force: true });
    expect(listRuns()).toEqual([]);
  });

  it("reads manifest + cost-ledger for each run directory", () => {
    writeRun(
      "run-1",
      { config: { niche: "fitness", platforms: ["tiktok"], createdAt: "2026-01-01T00:00:00.000Z" }, candidatesFound: 3, reviewItemsCreated: 3 },
      { totalUsd: 1.25 }
    );
    const runs = listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "run-1",
      niche: "fitness",
      platforms: ["tiktok"],
      candidatesFound: 3,
      reviewItemsCreated: 3,
      estimatedCostUsd: 1.25
    });
  });

  it("surfaces candidatesFailed/platformsFailed from the manifest when present", () => {
    writeRun("run-1", {
      config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" },
      candidatesFound: 5,
      reviewItemsCreated: 3,
      candidatesFailed: 1,
      platformsFailed: 1
    });
    expect(listRuns()[0]).toMatchObject({ candidatesFailed: 1, platformsFailed: 1 });
  });

  it("surfaces the failures array (candidateId/platform/reason) from the manifest when present", () => {
    writeRun("run-1", {
      config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" },
      candidatesFound: 2,
      reviewItemsCreated: 0,
      candidatesFailed: 1,
      platformsFailed: 1,
      failures: [
        { candidateId: "cand-a", reason: "simulated script-agent failure" },
        { candidateId: "cand-b", platform: "tiktok", reason: "simulated qa-agent failure" }
      ]
    });
    expect(listRuns()[0].failures).toEqual([
      { candidateId: "cand-a", reason: "simulated script-agent failure" },
      { candidateId: "cand-b", platform: "tiktok", reason: "simulated qa-agent failure" }
    ]);
  });

  it("leaves failures undefined for manifests written before that field existed (older runs)", () => {
    writeRun("run-1", {
      config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" },
      candidatesFound: 1,
      reviewItemsCreated: 0,
      candidatesFailed: 1
    });
    expect(listRuns()[0].failures).toBeUndefined();
  });

  it("leaves candidatesFailed/platformsFailed undefined for manifests written before that field existed", () => {
    writeRun("run-1", { config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" }, candidatesFound: 1, reviewItemsCreated: 1 });
    const run = listRuns()[0];
    expect(run.candidatesFailed).toBeUndefined();
    expect(run.platformsFailed).toBeUndefined();
  });

  it("tolerates a missing cost-ledger.json (dry-run or a pre-cost-tracking run)", () => {
    writeRun("run-1", { config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" }, candidatesFound: 1, reviewItemsCreated: 1 });
    expect(listRuns()[0].estimatedCostUsd).toBeUndefined();
  });

  it("skips directories with no manifest.json", () => {
    mkdirSync(join(testDir, "not-a-run"), { recursive: true });
    writeRun("run-1", { config: { niche: "fitness", createdAt: "2026-01-01T00:00:00.000Z" } });
    expect(listRuns()).toHaveLength(1);
  });

  it("sorts newest-first by createdAt", () => {
    writeRun("old", { config: { niche: "a", createdAt: "2026-01-01T00:00:00.000Z" } });
    writeRun("new", { config: { niche: "b", createdAt: "2026-01-02T00:00:00.000Z" } });
    expect(listRuns().map((r) => r.runId)).toEqual(["new", "old"]);
  });
});
