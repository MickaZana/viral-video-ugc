import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RawClip } from "@vvugc/shared-schema";
import type { McpToolCaller, VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Wraps the environment-provided Higgsfield MCP server (generate_video,
 * job_status, reveal_generation). The conductor injects `callMcpTool`, which
 * dispatches to whatever MCP client/session it holds (e.g. the Claude Agent
 * SDK's connected `HiggsfieldAi` server) — this adapter never calls HTTP
 * itself, matching how Higgsfield is actually exposed.
 */
export function createHiggsfieldAdapter(callMcpTool: McpToolCaller, outDir: string): VideoGenAdapter {
  return {
    vendor: "higgsfield",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const job = (await callMcpTool("generate_video", {
        prompt: req.prompt,
        duration_seconds: req.durationSec,
        aspect_ratio: req.aspectRatio,
        reference_image_url: req.referenceImageUrl
      })) as { jobId: string };

      let result: { status: string; videoUrl?: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        result = (await callMcpTool("job_status", { job_id: job.jobId })) as typeof result;
        if (result?.status === "completed" || result?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (!result || result.status !== "completed" || !result.videoUrl) {
        throw new Error(`Higgsfield job ${job.jobId} did not complete: ${JSON.stringify(result)}`);
      }

      const filePath = `${outDir}/higgsfield-${req.scriptSegmentIndex}-${job.jobId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetch(result.videoUrl)).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: job.jobId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "higgsfield",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
