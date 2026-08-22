import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import type { McpToolCaller, VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Fast, prompt-driven text-to-video model — Higgsfield's own generate_video
 * tool description names this the default for "single start-frame animation"
 * / general text-to-video use, which is this pipeline's actual shape (one
 * prompt per script segment, usually no reference image).
 */
const DEFAULT_MODEL = "kling3_0_turbo";

/**
 * Wraps the environment-provided Higgsfield MCP server. The conductor injects
 * `callMcpTool`, which dispatches to whatever MCP client/session it holds
 * (e.g. a Claude Agent SDK session with the `HiggsfieldAi` server connected)
 * — this adapter never calls HTTP itself, matching how Higgsfield is actually
 * exposed (there is no standalone REST API — confirmed directly against
 * https://higgsfield.ai/{mcp,cli,skills}, all of which state "No API keys to
 * manage or configure"; authentication is account-login-based only).
 *
 * Request-side field names (model, prompt, duration, aspect_ratio,
 * medias[].{value,role}) are taken directly from the real generate_video/
 * job_status/media_import_url tool schemas as connected in a live session —
 * not guessed or fetched from external docs (see git history for what
 * happened the one time that was tried). The account this was checked
 * against is on Higgsfield's free plan (4 credits), which 403s on
 * generate_video for `kling3_0_turbo` with `job_minimum_basic_plan_required`
 * — so the *request* shape below is verified against the real tool schema,
 * but the *response* shape (what a successful generate_video/job_status call
 * actually returns) has not been observed end-to-end. extractJobId/
 * extractVideoUrl below check multiple plausible field names and throw with
 * the full raw response on a mismatch, rather than silently misparsing —
 * whoever hits this with a paid plan gets a real payload to correct these
 * against, instead of a confusing downstream failure.
 */
export function createHiggsfieldAdapter(callMcpTool: McpToolCaller, outDir: string): VideoGenAdapter {
  return {
    vendor: "higgsfield",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      // Soul ID: if identityRef is present, import ALL reference images (primary + additional)
      // as medias for maximum face consistency. Higgsfield supports up to 9 references.
      let medias: Array<{ value: string; role: string }> | undefined;

      if (req.identityRef?.primaryImageUrl) {
        const allUrls = [req.identityRef.primaryImageUrl, ...req.identityRef.additionalImageUrls].slice(0, 9);
        const imported = await Promise.all(
          allUrls.map((url) => importMedia(callMcpTool, url))
        );
        medias = imported.map((mediaId) => ({ value: mediaId, role: "image" }));
      } else if (req.referenceImageUrl) {
        medias = [{ value: await importMedia(callMcpTool, req.referenceImageUrl), role: "image" }];
      }

      // Cinema Controls: enrich prompt with visual direction
      const enrichedPrompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;

      const submitResult = await callMcpTool("generate_video", {
        model: DEFAULT_MODEL,
        prompt: enrichedPrompt,
        duration: req.durationSec,
        aspect_ratio: req.aspectRatio,
        ...(medias ? { medias } : {})
      });
      const jobId = extractJobId(submitResult);

      const result = await pollWithBackoff(async () => {
        const status = await callMcpTool("job_status", { jobId });
        const statusValue = extractStatus(status);
        if (statusValue === "failed" || statusValue === "ip_detected") {
          throw new Error(`Higgsfield job ${jobId} ${statusValue}: ${JSON.stringify(status)}`);
        }
        return statusValue === "completed" ? status : undefined;
      });

      const videoUrl = extractVideoUrl(result);
      if (!videoUrl) {
        throw new Error(`Higgsfield job ${jobId} completed but no video URL was found in the response: ${JSON.stringify(result)}`);
      }

      const filePath = `${outDir}/higgsfield-${req.scriptSegmentIndex}-${jobId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: jobId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "higgsfield",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}

/** media_import_url takes a fetchable image URL and returns a media_id — generate_video's
 *  medias[].value must be that id, not the raw URL (confirmed from the real tool schema). */
async function importMedia(callMcpTool: McpToolCaller, url: string): Promise<string> {
  const result = await callMcpTool("media_import_url", { url, type: "image" });
  const mediaId = extractField(result, ["media_id", "mediaId", "id"]);
  if (!mediaId) throw new Error(`Higgsfield media_import_url for ${url} returned no media id: ${JSON.stringify(result)}`);
  return mediaId;
}

function extractField(obj: unknown, keys: string[]): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractJobId(submitResult: unknown): string {
  const jobId = extractField(submitResult, ["jobId", "job_id", "id"]);
  if (!jobId) throw new Error(`Higgsfield generate_video returned no recognizable job id: ${JSON.stringify(submitResult)}`);
  return jobId;
}

function extractStatus(statusResult: unknown): string | undefined {
  return extractField(statusResult, ["status"]);
}

function extractVideoUrl(statusResult: unknown): string | undefined {
  if (typeof statusResult !== "object" || statusResult === null) return undefined;
  const record = statusResult as Record<string, unknown>;
  const direct = extractField(record, ["videoUrl", "video_url"]);
  if (direct) return direct;
  const video = record.video;
  if (typeof video === "object" && video !== null) {
    return extractField(video, ["url"]);
  }
  return undefined;
}
