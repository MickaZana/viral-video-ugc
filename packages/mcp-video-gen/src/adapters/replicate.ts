import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
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

/**
 * Provider-aware polling budget for Replicate.
 *
 * pollWithBackoff's library defaults (20 attempts, ~3.9 min total wall-clock)
 * were sized for fast queue APIs. A previous live audit found the default model
 * `minimax/video-01` routinely takes ~4–5 min end-to-end, so the default budget
 * expired *before* the job finished and surfaced as a spurious
 * `Replicate prediction … failed: ""` / silent `undefined`.
 *
 * These opts give Replicate room: a 3s→20s backoff (gentler on the API than the
 * 2s→15s default once a video job is clearly going to take minutes) over up to
 * 80 attempts, bounded by an 8-minute wall-clock deadline. 8 min clears
 * `minimax/video-01`'s ~5 min with comfortable margin for a slow queue start,
 * while still being short enough that a genuinely stuck job is abandoned (and
 * cancelled) in minutes rather than hanging a pipeline run. `maxAttempts: 80` is
 * just a backstop — at the 20s cap the deadline is always the binding limit
 * (~27 polls to reach 8 min); it exists so a misconfigured huge deadline can't
 * spin unboundedly.
 *
 * The deadline is overridable via the optional `REPLICATE_POLL_DEADLINE_MS` env
 * var (read directly here rather than via shared-config — a single Replicate-
 * only knob isn't worth a schema change + the shared-config/orchestrator
 * rebuilds that entails). Non-numeric/unset falls back to the 8-min default;
 * a set value is clamped to [60s, 30min] so neither a fat-fingered `500` nor a
 * `99999999` can defeat the "bounded" guarantee.
 */
const DEFAULT_REPLICATE_POLL_DEADLINE_MS = 8 * 60_000;
const MIN_REPLICATE_POLL_DEADLINE_MS = 60_000;
const MAX_REPLICATE_POLL_DEADLINE_MS = 30 * 60_000;

function resolveReplicatePollDeadlineMs(): number {
  const raw = process.env.REPLICATE_POLL_DEADLINE_MS;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_REPLICATE_POLL_DEADLINE_MS;
  return Math.min(Math.max(parsed, MIN_REPLICATE_POLL_DEADLINE_MS), MAX_REPLICATE_POLL_DEADLINE_MS);
}

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

      // Cinema Controls: enrich prompt with visual direction
      const enrichedPrompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;
      const input: Record<string, unknown> = {
        prompt: enrichedPrompt,
        aspect_ratio: req.aspectRatio,
        duration: req.durationSec
      };
      // Image-to-video: startingFrame > identityRef > generic referenceImageUrl
      // — see VideoGenAdapter.ts's startingFrame doc for the precedence rationale.
      if (req.startingFrame?.imageUrl) input.image = req.startingFrame.imageUrl;
      else if (req.startingFrame?.imageDataUri) input.image = req.startingFrame.imageDataUri;
      else if (req.identityRef?.primaryImageUrl) input.image = req.identityRef.primaryImageUrl;
      else if (req.referenceImageUrl) input.image = req.referenceImageUrl;
      else if (req.referenceImageDataUri) input.image = req.referenceImageDataUri;

      // No `Prefer: wait` here — live-tested against a real account and found it
      // holds the connection open server-side until the video finishes, which for
      // a video model routinely exceeds fetchWithRetry's own 30s timeout (3
      // attempts, ~90s, all wasted on a request that would eventually 200 if given
      // long enough). Plain async submit-then-poll below is both simpler and
      // actually correct for a job this long-running — same pattern every other
      // adapter in this codebase already uses.
      const submitRes = await fetchWithRetry(`${REPLICATE_API_BASE}/models/${model}/predictions`, {
        method: "POST",
        headers,
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

      const deadlineMs = resolveReplicatePollDeadlineMs();
      // Track the last status the poll actually observed so a timeout can say
      // whether the job was still `starting`/`processing` (slow) vs never moved.
      let lastStatus: ReplicatePrediction["status"] = submitted.status;

      const prediction = await pollWithBackoff(
        async () => {
          const statusRes = await fetchWithRetry(`${REPLICATE_API_BASE}/predictions/${submitted.id}`, {
            headers,
            timeoutMs: 15_000
          });
          if (!statusRes.ok) {
            throw new Error(`Replicate prediction ${submitted.id} status check failed: ${statusRes.status} ${await statusRes.text()}`);
          }
          const status = (await statusRes.json()) as ReplicatePrediction;
          lastStatus = status.status;
          if (status.status === "failed" || status.status === "canceled") {
            throw new Error(`Replicate prediction ${submitted.id} ${status.status}: ${JSON.stringify(status.error ?? status)}`);
          }
          return status.status === "succeeded" ? status : undefined;
        },
        // See DEFAULT_REPLICATE_POLL_DEADLINE_MS above for why these numbers.
        { initialDelayMs: 3000, maxDelayMs: 20_000, factor: 1.5, maxAttempts: 80, deadlineMs }
      );

      if (!prediction) {
        // Timed out (not a terminal failure — the closure throws for those). Best-effort
        // cancel so a paid job isn't left running server-side; a failed cancel must not
        // mask the timeout, which is the actionable error the caller needs to see.
        try {
          await fetchWithRetry(`${REPLICATE_API_BASE}/predictions/${submitted.id}/cancel`, {
            method: "POST",
            headers
          });
        } catch {
          // ignore — the "did not finish" error below is what matters
        }
        throw new Error(
          `Replicate prediction ${submitted.id} did not finish within ${Math.round(deadlineMs / 1000)}s ` +
            `(last status: ${lastStatus}); cancellation requested`
        );
      }

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
