import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/**
 * A general, well-established text-to-video model — overridable per-account via
 * REPLICATE_MODEL since Replicate hosts dozens of interchangeable text-to-video
 * models (luma/ray-3.2, minimax/hailuo-2.3-fast, google/veo-3.1-fast, kwaivgi/kling-v3-video,
 * wan-video/wan-2.5-t2v, and many more — all real, current model slugs confirmed against
 * Replicate's own model collection at the time this was written).
 */
const DEFAULT_MODEL = "minimax/video-01";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: unknown;
}

/**
 * Replicate (https://replicate.com) is a model-hosting platform, not a single
 * vendor — one account/API token gives access to many different text-to-video
 * models through the identical REST contract below. Confirmed directly against
 * Replicate's own current docs (https://replicate.com/docs/reference/http):
 * base URL, `Authorization: Bearer <token>` auth, `POST /predictions` to submit,
 * `GET /predictions/{id}` to poll, and the id/status/output response shape —
 * this part is solid. Submission uses the `POST /models/{owner}/{name}/predictions`
 * shortcut (confirmed with a real curl example in Replicate's own docs) rather
 * than the version-hash-based `POST /predictions` — simpler (no version hash to
 * look up/pin), but documented as being for "official models" specifically; an
 * unqualified community model may need the version-hash form instead, which
 * would surface as a clean 404/error from the submit call below, not silently.
 *
 * What's NOT verified per-model: each model on Replicate declares its own input
 * schema (field names/types), which this adapter can't hardcode for all of them.
 * It sends the fields essentially every text-to-video model accepts by
 * convention (prompt, and best-effort aspect_ratio/duration) rather than a
 * schema confirmed for DEFAULT_MODEL specifically — if a chosen model rejects
 * one of these, Replicate's own 422 validation response names the invalid
 * field, which this adapter surfaces verbatim rather than masking it.
 */
export function createReplicateAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "replicate",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiToken = requireEnvVar("REPLICATE_API_TOKEN");
      const model = loadEnv().REPLICATE_MODEL || DEFAULT_MODEL;
      const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
      // `Prefer: wait` (confirmed in Replicate's own curl example) asks the API to block
      // server-side and return the completed result inline for fast models, up to its own
      // timeout — saves a full poll round-trip when the model finishes quickly.
      const submitHeaders = { ...headers, Prefer: "wait" };

      const input: Record<string, unknown> = {
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        duration: req.durationSec
      };
      if (req.referenceImageUrl) input.image = req.referenceImageUrl;

      const submitRes = await fetchWithRetry(`${REPLICATE_API_BASE}/models/${model}/predictions`, {
        method: "POST",
        headers: submitHeaders,
        body: JSON.stringify({ input })
      });
      if (!submitRes.ok) {
        throw new Error(`Replicate (${model}) prediction submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const submitted = (await submitRes.json()) as ReplicatePrediction;

      // `Prefer: wait` (or a naturally fast model) can mean the submit response is already
      // terminal — check before polling separately, the same shortcut higgsfield.ts uses.
      if (submitted.status === "succeeded") {
        const videoUrl = extractVideoUrl(submitted.output);
        if (videoUrl) return downloadClip(videoUrl, submitted.id, req, outDir);
      }
      if (submitted.status === "failed" || submitted.status === "canceled") {
        throw new Error(`Replicate prediction ${submitted.id} ${submitted.status}: ${JSON.stringify(submitted.error ?? submitted)}`);
      }

      const prediction = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(`${REPLICATE_API_BASE}/predictions/${submitted.id}`, {
          headers,
          timeoutMs: 15_000
        });
        if (!statusRes.ok) {
          throw new Error(`Replicate prediction ${submitted.id} status check failed: ${statusRes.status} ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as ReplicatePrediction;
        if (status.status === "failed" || status.status === "canceled") {
          throw new Error(`Replicate prediction ${submitted.id} ${status.status}: ${JSON.stringify(status.error ?? status)}`);
        }
        return status.status === "succeeded" ? status : undefined;
      });
      if (!prediction) throw new Error(`Replicate prediction ${submitted.id} did not complete in time`);

      const videoUrl = extractVideoUrl(prediction.output);
      if (!videoUrl) {
        throw new Error(`Replicate prediction ${submitted.id} succeeded but no video URL was found in output: ${JSON.stringify(prediction.output)}`);
      }

      return downloadClip(videoUrl, submitted.id, req, outDir);
    }
  };
}

async function downloadClip(videoUrl: string, predictionId: string, req: VideoGenRequest, outDir: string): Promise<RawClip> {
  const filePath = `${outDir}/replicate-${req.scriptSegmentIndex}-${predictionId}.mp4`;
  mkdirSync(dirname(filePath), { recursive: true });
  const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
  writeFileSync(filePath, Buffer.from(bytes));

  return {
    id: predictionId,
    scriptSegmentIndex: req.scriptSegmentIndex,
    vendor: "replicate",
    filePath,
    durationSec: req.durationSec
  };
}

/** Replicate's `output` shape varies by model: a bare URL string, an array of URLs,
 *  or an object with a `video`/`url` field are all real shapes different models use. */
function extractVideoUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    if (typeof record.video === "string") return record.video;
    if (typeof record.url === "string") return record.url;
  }
  return undefined;
}
