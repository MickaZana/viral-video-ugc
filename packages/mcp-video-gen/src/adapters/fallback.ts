import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import type { RawClip } from "@vvugc/shared-schema";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Runway and Pika share this shape closely enough (submit prompt -> poll ->
 * download) to generate from one factory. Both are optional fallbacks used
 * only when Higgsfield/Kling are unavailable or rate-limited.
 */
function createPollingRestAdapter(
  vendor: "runway" | "pika",
  envVar: "RUNWAY_API_KEY" | "PIKA_API_KEY",
  apiBase: string,
  outDir: string
): VideoGenAdapter {
  return {
    vendor,
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar(envVar);

      const submitRes = await fetch(`${apiBase}/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: req.prompt,
          duration: req.durationSec,
          aspect_ratio: req.aspectRatio
        })
      });
      if (!submitRes.ok) {
        throw new Error(`${vendor} generate submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const { id: taskId } = (await submitRes.json()) as { id: string };

      let videoUrl: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        const statusRes = await fetch(`${apiBase}/generate/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        const status = (await statusRes.json()) as { status: string; output?: string };
        if (status.status === "succeeded") {
          videoUrl = status.output;
          break;
        }
        if (status.status === "failed") throw new Error(`${vendor} task ${taskId} failed`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (!videoUrl) throw new Error(`${vendor} task ${taskId} did not produce a video URL in time`);

      const filePath = `${outDir}/${vendor}-${req.scriptSegmentIndex}-${taskId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetch(videoUrl)).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: taskId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor,
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}

export const createRunwayAdapter = (outDir: string) =>
  createPollingRestAdapter("runway", "RUNWAY_API_KEY", "https://api.runwayml.com/v1", outDir);

export const createPikaAdapter = (outDir: string) =>
  createPollingRestAdapter("pika", "PIKA_API_KEY", "https://api.pika.art/v1", outDir);
