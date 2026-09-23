import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { runCycle } from "../conductor.js";
import { connectHiggsfieldMcp, type ConnectedHiggsfieldMcp } from "./higgsfield-client.js";

/**
 * Transport-agnostic run-job tracking, shared by every way this pipeline gets
 * exposed to an outside caller (today: the local stdio MCP server in
 * ../mcp-server.ts; later: a hosted/multi-user HTTP server) — none of this file
 * imports the MCP SDK or knows about tools/transports. `runCycle` itself is
 * already synchronous-looking but can run for many minutes against real vendor
 * APIs, so an MCP tool call cannot simply `await` it directly (a client would
 * time out long before video-gen finishes). `startRunJob` instead fires it in
 * the background and returns a runId immediately; callers poll `getRunJob`.
 *
 * In-memory only: a job disappears if this process restarts. That's fine for a
 * single local stdio server (the MCP host owns its lifetime), and it isn't the
 * only record of a run — `runCycle` itself already writes `runs/<runId>/manifest.json`
 * and `cost-ledger.json` to disk (see conductor.ts), so `getRunJob` falls back to
 * reading those off disk for a runId this process doesn't remember. A future
 * hosted/multi-user server would swap this Map for a real per-user job store
 * without touching `runCycle` or the on-disk manifest shape at all.
 */

export type RunJobStatus = "running" | "completed" | "failed";

export interface RunJob {
  runId: string;
  status: RunJobStatus;
  niche: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Most recent onProgress lines, ring-buffered so a very long run can't leak memory. */
  progress: string[];
  result?: RunResult;
  error?: string;
}

const MAX_PROGRESS_LINES = 500;

const jobs = new Map<string, RunJob>();

/** Starts `runCycle` in the background and returns immediately with a running job. */
export function startRunJob(
  config: RunConfig,
  dependencies: { connectHiggsfield?: () => Promise<ConnectedHiggsfieldMcp | undefined> } = {}
): RunJob {
  const job: RunJob = {
    runId: config.runId,
    status: "running",
    niche: config.niche,
    dryRun: config.dryRun,
    startedAt: new Date().toISOString(),
    progress: []
  };
  jobs.set(config.runId, job);

  const onProgress = (message: string) => {
    job.progress.push(message);
    if (job.progress.length > MAX_PROGRESS_LINES) job.progress.shift();
  };

  void (async () => {
    let higgsfield: ConnectedHiggsfieldMcp | undefined;
    try {
      const higgsfieldRequested = config.videoVendor === "higgsfield" || config.videoVendorFallbacks?.includes("higgsfield");
      if (!config.dryRun && higgsfieldRequested) {
        try {
          higgsfield = await (dependencies.connectHiggsfield ?? connectHiggsfieldMcp)();
          if (!higgsfield) onProgress("Higgsfield MCP credentials are not configured; using the configured fallback chain.");
        } catch (error) {
          onProgress(`Higgsfield MCP is unavailable; using the configured fallback chain (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
      const result = await runCycle(config, { onProgress, callMcpTool: higgsfield?.callMcpTool });
      job.status = "completed";
      job.result = result;
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
    } finally {
      await higgsfield?.close().catch(() => undefined);
    }
  })();

  return job;
}

/**
 * Looks up a job this process started. Falls back to the on-disk manifest for a
 * runId not in memory (process restart, or a run kicked off by a different
 * invocation of the CLI) — reconstructed as a synthetic "completed" job so
 * get_run_result works either way. Returns undefined only when neither the
 * in-memory map nor `runs/<runId>/manifest.json` has anything for this id.
 */
export function getRunJob(runId: string): RunJob | undefined {
  const inMemory = jobs.get(runId);
  if (inMemory) return inMemory;

  const { VVUGC_RUNS_DIR } = loadEnv();
  const manifestPath = join(VVUGC_RUNS_DIR, runId, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;

  try {
    const result = JSON.parse(readFileSync(manifestPath, "utf8")) as RunResult;
    return {
      runId,
      status: "completed",
      niche: result.niche ?? "(unknown — read from disk manifest)",
      // RunResult's manifest doesn't record dryRun — only this process's own
      // in-memory jobs (started via startRunJob) know that; a disk-reconstructed
      // job is always reported as a live run, which is the safer assumption.
      dryRun: false,
      startedAt: result.completedAt ?? new Date(0).toISOString(),
      finishedAt: result.completedAt,
      progress: [],
      result
    };
  } catch (err) {
    // Manifest exists but isn't valid JSON (partially written?) — treat as not found
    // rather than throwing; the caller's "no such run" handling covers this cleanly.
    void err;
    return undefined;
  }
}

/** Every job this process knows about in-memory (does not scan disk). */
export function listRunJobs(): RunJob[] {
  return [...jobs.values()];
}
