import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import type { RawClip } from "@vvugc/shared-schema";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const KLING_API_BASE = "https://api.klingai.com/v1";

/**
 * Custom adapter around Kling's public text/image-to-video API — no
 * official MCP server exists for Kling, so this is a plain REST wrapper
 * kept behind the same VideoGenAdapter interface as the MCP-backed vendors.
 * Kling's API is async: submit a task, poll for completion, download result.
 */
export function createKlingAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "kling",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("KLING_API_KEY");

      const submitRes = await fetch(`${KLING_API_BASE}/videos/text2video`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: req.prompt,
          duration: req.durationSec,
          aspect_ratio: req.aspectRatio
        })
      });
      if (!submitRes.ok) {
        throw new Error(`Kling text2video submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const { task_id: taskId } = (await submitRes.json()) as { task_id: string };

      let videoUrl: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        const statusRes = await fetch(`${KLING_API_BASE}/videos/text2video/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        const status = (await statusRes.json()) as {
          task_status: string;
          task_result?: { videos?: { url: string }[] };
        };
        if (status.task_status === "succeed") {
          videoUrl = status.task_result?.videos?.[0]?.url;
          break;
        }
        if (status.task_status === "failed") {
          throw new Error(`Kling task ${taskId} failed`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (!videoUrl) throw new Error(`Kling task ${taskId} did not produce a video URL in time`);

      const filePath = `${outDir}/kling-${req.scriptSegmentIndex}-${taskId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetch(videoUrl)).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: taskId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "kling",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
