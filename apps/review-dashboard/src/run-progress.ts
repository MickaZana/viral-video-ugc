/**
 * Run Progress — Server-Sent Events hub for real-time pipeline progress.
 *
 * Architecture:
 * - In-memory EventEmitter tracks progress per runId
 * - The /accounts/run endpoint (and job worker) calls `emitProgress(runId, event)`
 * - SSE endpoint `/accounts/run-progress/:runId` streams events to the browser
 * - ETA estimation based on historical stage durations
 *
 * Stage sequence (9 stages, matching the roadmap spec):
 *   1. discovery_start / discovery_complete
 *   2. transcript_start / transcript_done
 *   3. script_start / script_rewritten
 *   4. voiceover_start / voiceover_done
 *   5. video_start / video_generating / video_done
 *   6. assembly_start / assembly_done
 *   7. qa_start / qa_done
 *   8. queue_start / queue_done
 *   9. run_complete / run_failed
 */

import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export interface ProgressEvent {
  stage: string;
  status: "start" | "progress" | "done" | "error";
  message: string;
  /** Progress within the current stage (0-100) */
  stageProgress?: number;
  /** Overall pipeline progress (0-100) */
  overallProgress: number;
  /** Elapsed ms since run started */
  elapsedMs: number;
  /** Estimated total time remaining in ms */
  etaMs?: number;
  /** Timestamp */
  timestamp: string;
  /** Extra metadata */
  detail?: Record<string, unknown>;
}

/** Canonical 9-stage pipeline. */
export const PIPELINE_STAGES = [
  "discovery",
  "transcript",
  "script",
  "voiceover",
  "video",
  "assembly",
  "qa",
  "queue",
  "complete"
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

/** Historical average durations per stage (ms) for ETA estimation. */
const STAGE_DURATIONS_MS: Record<PipelineStage, number> = {
  discovery: 3000,
  transcript: 2000,
  script: 4000,
  voiceover: 5000,
  video: 15000,
  assembly: 3000,
  qa: 2000,
  queue: 500,
  complete: 0
};

/** Running totals for ETA calculation. */
interface RunState {
  startedAt: number;
  currentStageIndex: number;
  stageStartedAt: number;
  events: ProgressEvent[];
  /** Actual durations per completed stage (used to refine ETA). */
  actualDurations: Map<string, number>;
}

class RunProgressEmitter {
  private emitter = new EventEmitter();
  private runs = new Map<string, RunState>();

  /** Maximum number of concurrent runs tracked in memory. */
  private maxRuns = 100;

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  /** Start tracking a new run. */
  startRun(runId: string): void {
    // Evict oldest if at capacity
    if (this.runs.size >= this.maxRuns) {
      const oldestKey = this.runs.keys().next().value;
      if (oldestKey) this.runs.delete(oldestKey);
    }
    this.runs.set(runId, {
      startedAt: Date.now(),
      currentStageIndex: 0,
      stageStartedAt: Date.now(),
      events: [],
      actualDurations: new Map()
    });
  }

  /** Emit a progress event for a run. */
  emit(runId: string, stage: PipelineStage, status: "start" | "progress" | "done" | "error", message: string, detail?: Record<string, unknown>): void {
    const state = this.runs.get(runId);
    if (!state) return;

    const stageIndex = PIPELINE_STAGES.indexOf(stage);
    const elapsedMs = Date.now() - state.startedAt;

    // Update state when a stage completes
    if (status === "done" && stageIndex >= 0) {
      const stageDuration = Date.now() - state.stageStartedAt;
      state.actualDurations.set(stage, stageDuration);
      state.currentStageIndex = stageIndex + 1;
      state.stageStartedAt = Date.now();
    } else if (status === "start" && stageIndex >= 0) {
      state.currentStageIndex = stageIndex;
      state.stageStartedAt = Date.now();
    }

    // Calculate overall progress
    const totalStages = PIPELINE_STAGES.length - 1; // exclude 'complete'
    const completedStages = Math.min(state.currentStageIndex, totalStages);
    const overallProgress = Math.round((completedStages / totalStages) * 100);

    // ETA: sum remaining stage estimates, using actuals where available
    let etaMs = 0;
    for (let i = state.currentStageIndex; i < totalStages; i++) {
      const s = PIPELINE_STAGES[i];
      etaMs += state.actualDurations.get(s) ?? STAGE_DURATIONS_MS[s];
    }

    const event: ProgressEvent = {
      stage,
      status,
      message,
      overallProgress: stage === "complete" ? 100 : overallProgress,
      elapsedMs,
      etaMs: etaMs > 0 ? etaMs : undefined,
      timestamp: new Date().toISOString(),
      detail
    };

    state.events.push(event);
    this.emitter.emit(`progress:${runId}`, event);

    // Clean up completed runs after 5 minutes
    if (stage === "complete" || status === "error") {
      setTimeout(() => this.runs.delete(runId), 5 * 60 * 1000);
    }
  }

  /** Subscribe to a run's progress events. Returns unsubscribe function. */
  subscribe(runId: string, listener: (event: ProgressEvent) => void): () => void {
    const channel = `progress:${runId}`;
    this.emitter.on(channel, listener);

    // Replay existing events
    const state = this.runs.get(runId);
    if (state) {
      for (const event of state.events) {
        listener(event);
      }
    }

    return () => this.emitter.off(channel, listener);
  }

  /** Get current state of a run. */
  getState(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }
}

// Singleton instance
export const runProgress = new RunProgressEmitter();

/**
 * Parse an orchestrator onProgress message into a structured stage event.
 * The orchestrator emits messages like:
 *   "Discovering candidates on tiktok, youtube_shorts for niche "fitness"..."
 *   "[1/6] Transcribing "Some Title"..."
 *   "[1/6] Rewriting script..."
 *   "[1/6] Generating voiceover (elevenlabs)..."
 *   "[1/6] Generating video (tiktok) — clip 1/3..."
 *   "[1/6] Assembling video (tiktok)..."
 *   "[1/6] Scoring quality (tiktok)..."
 *   "[1/6] ✓ Queued for review (tiktok, score 85/100)"
 */
export function parseProgressMessage(runId: string, message: string): void {
  const msg = message.trim();

  if (msg.startsWith("Discovering")) {
    runProgress.emit(runId, "discovery", "start", msg);
  } else if (msg.startsWith("Found")) {
    runProgress.emit(runId, "discovery", "done", msg);
  } else if (msg.includes("Remixing source video")) {
    runProgress.emit(runId, "transcript", "progress", msg);
  } else if (msg.includes("Transcribing")) {
    runProgress.emit(runId, "transcript", "start", msg);
  } else if (msg.includes("Rewriting script")) {
    // Transcript is done if we're rewriting
    runProgress.emit(runId, "transcript", "done", "Transcript complete");
    runProgress.emit(runId, "script", "start", msg);
  } else if (msg.includes("Generating voiceover")) {
    runProgress.emit(runId, "script", "done", "Script rewritten");
    runProgress.emit(runId, "voiceover", "start", msg);
  } else if (msg.includes("Voiceover failed")) {
    runProgress.emit(runId, "voiceover", "done", msg);
  } else if (msg.includes("Generating video")) {
    runProgress.emit(runId, "voiceover", "done", "Voiceover complete");
    runProgress.emit(runId, "video", "progress", msg);
  } else if (msg.includes("Assembling video")) {
    runProgress.emit(runId, "video", "done", "Video clips generated");
    runProgress.emit(runId, "assembly", "start", msg);
  } else if (msg.includes("Scoring quality")) {
    runProgress.emit(runId, "assembly", "done", "Video assembled");
    runProgress.emit(runId, "qa", "start", msg);
  } else if (msg.includes("✓ Queued for review")) {
    runProgress.emit(runId, "qa", "done", "QA scored");
    runProgress.emit(runId, "queue", "done", msg);
  } else if (msg.includes("✗ Failed")) {
    // Individual candidate failure — not a run failure
    runProgress.emit(runId, "video", "error", msg);
  }
}

/**
 * Create the onProgress callback for a specific run.
 * Plug this into runCycle(config, { onProgress: createProgressCallback(runId) })
 */
export function createProgressCallback(runId: string): (message: string) => void {
  runProgress.startRun(runId);
  return (message: string) => parseProgressMessage(runId, message);
}

/**
 * Complete a run (marks it as done in the progress tracker).
 */
export function completeRun(runId: string, success: boolean, detail?: Record<string, unknown>): void {
  runProgress.emit(
    runId,
    "complete",
    success ? "done" : "error",
    success ? "Pipeline complete" : "Pipeline failed",
    detail
  );
}

/**
 * Express SSE handler for GET /accounts/run-progress/:runId
 */
export function sseProgressHandler(req: Request, res: Response): void {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ runId, stages: PIPELINE_STAGES })}\n\n`);

  // Subscribe to progress events
  const unsubscribe = runProgress.subscribe(runId, (event) => {
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);

    // Close connection when run completes
    if (event.stage === "complete") {
      setTimeout(() => {
        res.write(`event: done\ndata: ${JSON.stringify({ runId })}\n\n`);
        res.end();
      }, 500);
    }
  });

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 15_000);

  // Clean up on client disconnect
  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}
