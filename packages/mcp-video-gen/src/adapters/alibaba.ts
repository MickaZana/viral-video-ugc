import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const DEFAULT_MODEL = "wan3.0-video";
// Single source of truth for the submit path — also used to derive the
// origin/base the task-poll URL is built from, so the two can't drift apart
// (the strip-regex previously re-typed this literal inline).
const VIDEO_SYNTHESIS_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const DEFAULT_ENDPOINT = `https://dashscope-intl.aliyuncs.com${VIDEO_SYNTHESIS_PATH}`;
const TASKS_PATH = "/api/v1/tasks/";

interface AlibabaTaskResponse {
  output?: { task_id?: string; task_status?: string; video_url?: string; code?: string; message?: string };
  task_id?: string;
  task_status?: string;
  video_url?: string;
  code?: string;
  message?: string;
}

/** Hosted Alibaba Model Studio adapter for Wan 2.7/3.0 and HappyHorse 1.1. */
export function createAlibabaAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "alibaba",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const env = loadEnv();
      const apiKey = env.DASHSCOPE_API_KEY || env["WAN3.0_API_KEY"];
      if (!apiKey) throw new Error('Missing required env var "DASHSCOPE_API_KEY" (or alias "WAN3.0_API_KEY")');
      const endpoint = (env.ALIBABA_VIDEO_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
      const configuredModel = env.ALIBABA_VIDEO_MODEL || DEFAULT_MODEL;
      const prompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;
      const imageUrl = req.startingFrame?.imageUrl ?? req.startingFrame?.imageDataUri ??
        req.identityRef?.primaryImageUrl ?? req.referenceImageUrl ?? req.referenceImageDataUri;
      let model = configuredModel;
      if (imageUrl && /^wan2\.7-t2v(?:-|$)/.test(model)) model = model.replace("wan2.7-t2v", "wan2.7-i2v");
      if (imageUrl && /^happyhorse-1\.1-t2v(?:-|$)/.test(model)) model = model.replace("happyhorse-1.1-t2v", "happyhorse-1.1-i2v");
      const input: Record<string, unknown> = { prompt };
      if (imageUrl) input.media = [{ type: "first_frame", url: imageUrl }];
      const body: Record<string, unknown> = { model, input };
      const isHappyHorse = model.startsWith("happyhorse");
      const isWan27 = model.startsWith("wan2.7-");
      const outputDuration = isHappyHorse
        ? Math.max(3, Math.min(15, Math.round(req.durationSec)))
        : Math.max(2, Math.min(isWan27 ? 15 : 30, Math.round(req.durationSec)));
      body.parameters = {
        ...(!imageUrl || !isHappyHorse ? { ratio: req.aspectRatio } : {}),
        duration: outputDuration,
        ...(!isHappyHorse ? { prompt_extend: true } : {})
      };

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      };
      const submit = await fetchWithRetry(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      if (!submit.ok) throw new Error(`Alibaba Model Studio submit failed: ${submit.status} ${await submit.text()}`);
      const submitted = await submit.json() as AlibabaTaskResponse;
      const taskId = submitted.output?.task_id ?? submitted.task_id;
      if (!taskId) throw new Error(`Alibaba Model Studio response did not include output.task_id: ${JSON.stringify(submitted)}`);
      const pollIntervalMs = positiveInteger(env.ALIBABA_VIDEO_POLL_INTERVAL_MS, 15_000);
      const maxWaitMs = positiveInteger(env.ALIBABA_VIDEO_MAX_WAIT_MS, 900_000);

      const result = await pollWithBackoff(async () => {
        const response = await fetchWithRetry(taskPollUrl(endpoint, taskId), {
          headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 15_000
        });
        if (!response.ok) throw new Error(`Alibaba task ${taskId} poll failed: ${response.status} ${await response.text()}`);
        const payload = await response.json() as AlibabaTaskResponse;
        const output = payload.output ?? payload;
        const status = output.task_status?.toUpperCase();
        if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
          throw new Error(`Alibaba task ${taskId} ${status}: ${output.code ?? ""} ${output.message ?? ""}`.trim());
        }
        if (status === "SUCCEEDED") {
          if (!output.video_url) throw new Error(`Alibaba task ${taskId} succeeded but returned no output.video_url`);
          return { videoUrl: output.video_url };
        }
        return undefined;
      }, {
        maxAttempts: Math.max(1, Math.floor(maxWaitMs / pollIntervalMs)),
        initialDelayMs: pollIntervalMs,
        maxDelayMs: pollIntervalMs,
        // maxAttempts alone doesn't bound wall-clock time: each attempt also
        // spends up to the 15s poll timeout (×3 transport retries) in flight.
        // deadlineMs makes the "did not complete within X ms" error below true.
        deadlineMs: maxWaitMs
      });
      if (!result) throw new Error(`Alibaba task ${taskId} did not complete within ${maxWaitMs} ms`);

      const video = await fetchWithRetry(result.videoUrl, { timeoutMs: 120_000 });
      if (!video.ok) throw new Error(`Alibaba task ${taskId} video download failed: ${video.status} ${await video.text()}`);
      const bytes = Buffer.from(await video.arrayBuffer());
      if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
        throw new Error(`Alibaba task ${taskId} returned a response that is not a valid MP4 file`);
      }
      const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = `${outDir}/alibaba-${req.scriptSegmentIndex}-${safeTaskId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
      return { id: taskId, scriptSegmentIndex: req.scriptSegmentIndex, vendor: "alibaba", filePath, durationSec: outputDuration };
    }
  };
}

/** Task-poll URL = endpoint minus the video-synthesis submit path + /api/v1/tasks/{id}. */
function taskPollUrl(endpoint: string, taskId: string): string {
  const base = endpoint.endsWith(VIDEO_SYNTHESIS_PATH)
    ? endpoint.slice(0, -VIDEO_SYNTHESIS_PATH.length)
    : endpoint;
  return `${base}${TASKS_PATH}${encodeURIComponent(taskId)}`;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}
