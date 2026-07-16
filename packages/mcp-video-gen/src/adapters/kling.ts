import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const KLING_API_BASE = "https://api.klingai.com/v1";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Kling's API authenticates with a short-lived HS256 JWT signed from an
 * Access Key / Secret Key pair — NOT a static bearer API key. Tokens expire
 * after 30 minutes, so this signs a fresh one per adapter call rather than
 * caching (each `generate()` call is infrequent enough that this is cheap).
 */
function signKlingJwt(accessKey: string, secretKey: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = base64Url(createHmac("sha256", secretKey).update(`${encodedHeader}.${encodedPayload}`).digest());

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

interface KlingEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * Custom adapter around Kling's public text/image-to-video API — no
 * official MCP server exists for Kling, so this is a plain REST wrapper
 * kept behind the same VideoGenAdapter interface as the MCP-backed vendors.
 * Kling's API is async: submit a task, poll for completion, download result.
 * Responses are wrapped in a {code, message, data} envelope — every field
 * below is read from `.data`, not the response root.
 */
export function createKlingAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "kling",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const accessKey = requireEnvVar("KLING_ACCESS_KEY");
      const secretKey = requireEnvVar("KLING_SECRET_KEY");
      const authHeader = () => ({ Authorization: `Bearer ${signKlingJwt(accessKey, secretKey)}` });

      const submitRes = await fetchWithRetry(`${KLING_API_BASE}/videos/text2video`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: req.prompt,
          duration: String(req.durationSec),
          aspect_ratio: req.aspectRatio
        })
      });
      if (!submitRes.ok) {
        throw new Error(`Kling text2video submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const submitBody = (await submitRes.json()) as KlingEnvelope<{ task_id: string }>;
      const taskId = submitBody.data.task_id;

      // authHeader() re-signs a fresh JWT on every call, so backoff duration isn't constrained
      // by the token's 30-minute expiry the way a single cached token would be.
      const videoUrl = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(`${KLING_API_BASE}/videos/text2video/${taskId}`, {
          headers: authHeader(),
          timeoutMs: 15_000
        });
        const statusBody = (await statusRes.json()) as KlingEnvelope<{
          task_status: string;
          task_result?: { videos?: { url: string }[] };
        }>;
        const status = statusBody.data;
        if (status.task_status === "failed") {
          throw new Error(`Kling task ${taskId} failed`);
        }
        return status.task_status === "succeed" ? status.task_result?.videos?.[0]?.url : undefined;
      });
      if (!videoUrl) throw new Error(`Kling task ${taskId} did not produce a video URL in time`);

      const filePath = `${outDir}/kling-${req.scriptSegmentIndex}-${taskId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
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
