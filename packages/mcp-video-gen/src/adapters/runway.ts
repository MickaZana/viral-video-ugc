import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const RUNWAY_API_BASE = "https://api.dev.runwayml.com";
// Runway requires this header on every request and versions it by date; check
// https://docs.dev.runwayml.com for the current value before relying on this in production.
const RUNWAY_API_VERSION = "2024-11-06";

interface RunwayTask {
  id: string;
  status: "queued" | "generating" | "completed" | "error" | "failed";
  output?: string[];
  failure?: string;
}

/**
 * Runway's real API (confirmed against https://docs.dev.runwayml.com, not guessed):
 * base host is api.dev.runwayml.com, every request needs an X-Runway-Version header,
 * polling is GET /v1/tasks/{id}, and status values are queued/generating/completed/error
 * — none of which match the generic "succeeded"/"failed" shape this adapter originally
 * assumed. One thing NOT confirmed from available docs: Runway's product is built
 * primarily around image-to-video (Gen-4), and a dedicated pure-text endpoint wasn't
 * clearly documented in what's publicly indexed — verify the exact endpoint path below
 * against your Runway account's API reference before the first real call.
 */
export function createRunwayAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "runway",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("RUNWAY_API_KEY");
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": RUNWAY_API_VERSION,
        "Content-Type": "application/json"
      };

      const submitRes = await fetch(`${RUNWAY_API_BASE}/v1/text_to_video`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          promptText: req.prompt,
          duration: req.durationSec,
          ratio: req.aspectRatio
        })
      });
      if (!submitRes.ok) {
        throw new Error(`Runway text_to_video submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const { id: taskId } = (await submitRes.json()) as { id: string };

      // Runway asks consumers not to poll faster than once per 5s — pollWithBackoff's 2s
      // initial delay ramps past that within the first couple of attempts.
      const videoUrl = await pollWithBackoff(async () => {
        const statusRes = await fetch(`${RUNWAY_API_BASE}/v1/tasks/${taskId}`, { headers });
        const task = (await statusRes.json()) as RunwayTask;
        if (task.status === "error" || task.status === "failed") {
          throw new Error(`Runway task ${taskId} failed: ${task.failure ?? "unknown error"}`);
        }
        return task.status === "completed" ? task.output?.[0] : undefined;
      });
      if (!videoUrl) throw new Error(`Runway task ${taskId} did not complete in time`);

      const filePath = `${outDir}/runway-${req.scriptSegmentIndex}-${taskId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetch(videoUrl)).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: taskId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "runway",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
