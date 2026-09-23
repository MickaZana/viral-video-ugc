import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";

// Mock the whole pipeline — jobs.ts's own job-tracking behavior is what's under
// test here (background execution, status transitions, disk fallback), not
// runCycle itself (conductor.test.ts already covers that against the real
// pipeline). Controlling runCycle directly lets these tests assert on timing
// (job stays "running" until the promise resolves) without actually discovering,
// transcribing, or generating anything.
const runCycleMock = vi.fn<(config: RunConfig, opts?: unknown) => Promise<RunResult>>();
vi.mock("../conductor.js", () => ({
  runCycle: (config: RunConfig, opts?: unknown) => runCycleMock(config, opts)
}));

// Imported after the mock so jobs.ts picks up the mocked runCycle.
const { startRunJob, getRunJob, listRunJobs } = await import("./jobs.js");

let testRunsDir: string;

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    niche: "fitness",
    platforms: ["youtube_shorts"],
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    targetDurationSec: 25,
    maxCandidates: 5,
    outputVariants: 2,
    videoVendor: "kling",
    lipSyncVendor: "none",
    dryRun: true,
    autoPost: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function baseResult(config: RunConfig, overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: config.runId,
    niche: config.niche,
    candidatesFound: 1,
    reviewItemsCreated: 1,
    manifestPath: join(testRunsDir, config.runId, "manifest.json"),
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

/** Lets a pending job's runCycle promise resolve/reject before we assert on it —
 *  startRunJob fires runCycle in the background and returns immediately, so
 *  tests need one microtask/macrotask tick for the .then()/.catch() to run. */
async function flushJobs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("jobs", () => {
  beforeEach(() => {
    testRunsDir = mkdtempSync(join(tmpdir(), "vvugc-mcp-jobs-test-"));
    process.env.VVUGC_RUNS_DIR = testRunsDir;
    runCycleMock.mockReset();
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testRunsDir)) rmSync(testRunsDir, { recursive: true, force: true });
  });

  it("returns a running job immediately, before runCycle resolves", () => {
    let resolveRunCycle!: (result: RunResult) => void;
    runCycleMock.mockReturnValue(new Promise((resolve) => { resolveRunCycle = resolve; }));

    const config = baseConfig();
    const job = startRunJob(config);

    expect(job.status).toBe("running");
    expect(job.runId).toBe(config.runId);
    expect(job.dryRun).toBe(true);
    // Not left dangling — resolve so the test process can exit cleanly.
    resolveRunCycle(baseResult(config));
  });

  it("transitions to completed and records the result once runCycle resolves", async () => {
    const config = baseConfig();
    const result = baseResult(config);
    runCycleMock.mockResolvedValue(result);

    startRunJob(config);
    await flushJobs();

    const job = getRunJob(config.runId);
    expect(job?.status).toBe("completed");
    expect(job?.result).toEqual(result);
    expect(job?.finishedAt).toBeDefined();
  });

  it("transitions to failed and records the error message when runCycle throws", async () => {
    const config = baseConfig();
    runCycleMock.mockRejectedValue(new Error("all vendors failed"));

    startRunJob(config);
    await flushJobs();

    const job = getRunJob(config.runId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("all vendors failed");
  });

  it("collects onProgress lines onto the job as they're emitted", async () => {
    runCycleMock.mockImplementation(async (config, opts) => {
      const onProgress = (opts as { onProgress?: (msg: string) => void } | undefined)?.onProgress;
      onProgress?.("discovering...");
      onProgress?.("scripting...");
      return baseResult(config);
    });

    const config = baseConfig();
    startRunJob(config);
    await flushJobs();

    const job = getRunJob(config.runId);
    expect(job?.progress).toEqual(["discovering...", "scripting..."]);
  });

  it("injects a connected Higgsfield caller into live background jobs and closes it afterward", async () => {
    const config = baseConfig({ videoVendor: "higgsfield", dryRun: false });
    const callMcpTool = vi.fn(async () => ({}));
    const close = vi.fn(async () => undefined);
    runCycleMock.mockResolvedValue(baseResult(config));

    startRunJob(config, { connectHiggsfield: async () => ({ callMcpTool, close }) });
    await flushJobs();

    expect(runCycleMock).toHaveBeenCalledWith(config, expect.objectContaining({ callMcpTool: expect.any(Function) }));
    expect(getRunJob(config.runId)?.status).toBe("completed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("connects Higgsfield for an explicitly configured live fallback on another primary vendor", async () => {
    const config = baseConfig({ videoVendor: "wan", videoVendorFallbacks: ["replicate", "higgsfield"], dryRun: false });
    const callMcpTool = vi.fn(async () => ({ ok: true }));
    const close = vi.fn(async () => undefined);
    runCycleMock.mockImplementation(async (receivedConfig, opts) => {
      expect(receivedConfig.videoVendor).toBe("wan");
      expect(receivedConfig.videoVendorFallbacks).toEqual(["replicate", "higgsfield"]);
      const caller = (opts as { callMcpTool?: (tool: string, args: Record<string, unknown>) => Promise<unknown> }).callMcpTool;
      expect(caller).toBeDefined();
      await caller!("generate_video", { prompt: "test" });
      return baseResult(receivedConfig);
    });

    startRunJob(config, { connectHiggsfield: async () => ({ callMcpTool, close }) });
    await flushJobs();

    expect(callMcpTool).toHaveBeenCalledWith("generate_video", { prompt: "test" });
    expect(getRunJob(config.runId)?.status).toBe("completed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not fail a live job when Higgsfield MCP is not configured", async () => {
    const config = baseConfig({ videoVendor: "higgsfield", dryRun: false });
    runCycleMock.mockImplementation(async (receivedConfig, opts) => {
      expect((opts as { callMcpTool?: unknown }).callMcpTool).toBeUndefined();
      return baseResult(receivedConfig);
    });

    startRunJob(config, { connectHiggsfield: async () => undefined });
    await flushJobs();

    const job = getRunJob(config.runId);
    expect(job?.status).toBe("completed");
    expect(job?.progress.join(" ")).toContain("credentials are not configured");
  });

  it("returns undefined for a runId nobody has ever seen, in-memory or on disk", () => {
    expect(getRunJob("no-such-run-id")).toBeUndefined();
  });

  it("falls back to the on-disk manifest for a runId this process doesn't remember", () => {
    const runId = "disk-only-run";
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    const diskResult = baseResult(baseConfig({ runId }));
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(diskResult));

    const job = getRunJob(runId);
    expect(job?.status).toBe("completed");
    expect(job?.runId).toBe(runId);
    expect(job?.result).toEqual(diskResult);
  });

  it("lists only jobs this process started, not ones reconstructed from disk", async () => {
    const config = baseConfig();
    runCycleMock.mockResolvedValue(baseResult(config));
    startRunJob(config);
    await flushJobs();

    const runId = "disk-only-run-2";
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(baseResult(baseConfig({ runId }))));

    const jobs = listRunJobs();
    expect(jobs.some((j) => j.runId === config.runId)).toBe(true);
    expect(jobs.some((j) => j.runId === runId)).toBe(false);
  });
});
