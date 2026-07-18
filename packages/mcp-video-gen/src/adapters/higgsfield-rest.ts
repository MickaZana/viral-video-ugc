import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const HIGGSFIELD_API_BASE = "https://platform.higgsfield.ai";

/**
 * The model Higgsfield's platform proxies for a general prompt-driven
 * image-to-video generation ("DoP" — Director of Photography). Their
 * platform proxies multiple underlying models under the same base URL/auth
 * (their docs also show kling-video/*, bytedance/seedance/* paths) — this is
 * the one their own guide documents as the general-purpose entry point, not
 * confirmed as the only option.
 */
const DEFAULT_MODEL_PATH = "higgsfield-ai/dop/standard";

/**
 * Standalone REST wrapper around Higgsfield's public platform API — contrary
 * to this package's own prior assumption (see VideoGenAdapter.ts's git
 * history), Higgsfield does expose one, documented at
 * https://docs.higgsfield.ai/docs/guides/video.md and
 * https://docs.higgsfield.ai/docs/how-to/webhooks.md. Built from those docs,
 * not verified against a live account/real credentials — same disclosed
 * status Kling/Runway/Pika started in. Concretely unverified:
 * - Whether `image_url` is truly required for every model path, or only the
 *   DoP one shown in the docs — the request throws the API's own error text
 *   if it rejects a request missing one, rather than guessing client-side.
 * - The polling endpoint path: the docs only confirm a `status_url` returned
 *   in the async response/webhook payload (of the documented shape
 *   `{base}/requests/{request_id}/status`) — this adapter polls that URL
 *   directly rather than hardcoding a path, so it stays correct even if the
 *   exact path scheme differs from what's assumed here.
 *
 * Auth is a static key:secret pair (`Authorization: Key {key}:{secret}`),
 * not a signed/expiring token like Kling's JWT — simpler, no per-call
 * re-signing needed.
 */
export function createHiggsfieldRestAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "higgsfield",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const accessKey = requireEnvVar("HIGGSFIELD_ACCESS_KEY");
      const secretKey = requireEnvVar("HIGGSFIELD_SECRET_KEY");
      const authHeader = { Authorization: `Key ${accessKey}:${secretKey}` };

      const body: Record<string, unknown> = { prompt: req.prompt, duration: req.durationSec };
      if (req.referenceImageUrl) body.image_url = req.referenceImageUrl;

      const submitRes = await fetchWithRetry(`${HIGGSFIELD_API_BASE}/${DEFAULT_MODEL_PATH}`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!submitRes.ok) {
        throw new Error(`Higgsfield generation submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const submitBody = (await submitRes.json()) as {
        request_id: string;
        status_url?: string;
        status?: string;
        video?: { url: string };
      };
      const requestId = submitBody.request_id;
      // A fast-completing request can return the result inline instead of async —
      // the docs don't rule this out, so check before assuming a poll is needed.
      if (submitBody.status === "completed" && submitBody.video?.url) {
        return downloadClip(submitBody.video.url, requestId, req, outDir);
      }

      const statusUrl = submitBody.status_url ?? `${HIGGSFIELD_API_BASE}/requests/${requestId}/status`;
      const videoUrl = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(statusUrl, { headers: authHeader, timeoutMs: 15_000 });
        if (!statusRes.ok) {
          throw new Error(`Higgsfield status check failed: ${statusRes.status} ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as { status: string; video?: { url: string }; error?: string };
        if (status.status === "failed" || status.status === "nsfw") {
          throw new Error(`Higgsfield request ${requestId} ${status.status}${status.error ? `: ${status.error}` : ""}`);
        }
        return status.status === "completed" ? status.video?.url : undefined;
      });
      if (!videoUrl) throw new Error(`Higgsfield request ${requestId} did not produce a video URL in time`);

      return downloadClip(videoUrl, requestId, req, outDir);
    }
  };
}

async function downloadClip(videoUrl: string, requestId: string, req: VideoGenRequest, outDir: string): Promise<RawClip> {
  const filePath = `${outDir}/higgsfield-${req.scriptSegmentIndex}-${requestId}.mp4`;
  mkdirSync(dirname(filePath), { recursive: true });
  const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
  writeFileSync(filePath, Buffer.from(bytes));

  return {
    id: requestId,
    scriptSegmentIndex: req.scriptSegmentIndex,
    vendor: "higgsfield",
    filePath,
    durationSec: req.durationSec
  };
}
