import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlibabaAdapter } from "./alibaba.js";

const outDir = `${process.cwd()}/.test-out-alibaba`;
const endpoint = "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis";
const fakeMp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105, 115, 111, 109]);

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("createAlibabaAdapter", () => {
  beforeEach(() => {
    process.env.DASHSCOPE_API_KEY = "test-dashscope-key";
    delete process.env["WAN3.0_API_KEY"];
    process.env.ALIBABA_VIDEO_ENDPOINT = endpoint;
    process.env.ALIBABA_VIDEO_MODEL = "wan3.0-video";
    process.env.ALIBABA_VIDEO_POLL_INTERVAL_MS = "1";
    process.env.ALIBABA_VIDEO_MAX_WAIT_MS = "50";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ["DASHSCOPE_API_KEY", "WAN3.0_API_KEY", "ALIBABA_VIDEO_ENDPOINT", "ALIBABA_VIDEO_MODEL", "ALIBABA_VIDEO_POLL_INTERVAL_MS", "ALIBABA_VIDEO_MAX_WAIT_MS"]) delete process.env[key];
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("creates an async Wan task, polls its status and saves its MP4", async () => {
    const urls: string[] = [];
    const initValues: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(url.toString());
      initValues.push(init ?? {});
      if (url.toString() === endpoint) return json({ output: { task_id: "task-123", task_status: "PENDING" } });
      if (url.toString().endsWith("/tasks/task-123")) return json({ output: { task_id: "task-123", task_status: "SUCCEEDED", video_url: "https://result.example/video.mp4" } });
      return { ok: true, status: 200, arrayBuffer: async () => fakeMp4.buffer } as Response;
    }));

    const clip = await createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 2, prompt: "A paper kite in the wind", durationSec: 5, aspectRatio: "9:16" });
    expect(urls).toEqual([endpoint, "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/task-123", "https://result.example/video.mp4"]);
    expect(initValues[0].headers).toMatchObject({ Authorization: "Bearer test-dashscope-key", "X-DashScope-Async": "enable" });
    expect(JSON.parse(initValues[0].body as string)).toEqual({ model: "wan3.0-video", input: { prompt: "A paper kite in the wind" }, parameters: { ratio: "9:16", duration: 5, prompt_extend: true } });
    expect(clip.vendor).toBe("alibaba");
    expect(readFileSync(clip.filePath)).toEqual(Buffer.from(fakeMp4));
  });

  it("selects the HappyHorse image-to-video model for a configured t2v model when a first frame is supplied", async () => {
    process.env.ALIBABA_VIDEO_MODEL = "happyhorse-1.1-t2v";
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString() === endpoint) {
        body = JSON.parse(init!.body as string);
        return json({ output: { task_id: "task-image" } });
      }
      if (url.toString().includes("/tasks/")) return json({ output: { task_status: "SUCCEEDED", video_url: "https://result.example/image.mp4" } });
      return { ok: true, status: 200, arrayBuffer: async () => fakeMp4.buffer } as Response;
    }));
    await createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 0, prompt: "Animate this", durationSec: 2, aspectRatio: "9:16", startingFrame: { imageUrl: "https://image.example/frame.png" } });
    expect(body).toEqual({ model: "happyhorse-1.1-i2v", input: { prompt: "Animate this", media: [{ type: "first_frame", url: "https://image.example/frame.png" }] }, parameters: { duration: 3 } });
  });

  it("fails clearly when Model Studio does not return a task id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "InvalidApiKey", message: "Invalid API key" })));
    await expect(createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 5, aspectRatio: "9:16" })).rejects.toThrow(/did not include output.task_id/);
  });

  it("accepts WAN3.0_API_KEY when DASHSCOPE_API_KEY is absent", async () => {
    process.env.DASHSCOPE_API_KEY = "";
    process.env["WAN3.0_API_KEY"] = "test-wan-key";
    let auth = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString() === endpoint) {
        auth = (init?.headers as Record<string, string>).Authorization;
        return json({ output: { task_id: "alias-task" } });
      }
      if (url.toString().includes("/tasks/")) return json({ output: { task_status: "SUCCEEDED", video_url: "https://result.example/alias.mp4" } });
      return { ok: true, status: 200, arrayBuffer: async () => fakeMp4.buffer } as Response;
    }));
    const clip = await createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 5, aspectRatio: "9:16" });
    expect(auth).toBe("Bearer test-wan-key");
    expect(clip.vendor).toBe("alibaba");
  });

  it("routes Wan 2.7 first-frame requests to the i2v model", async () => {
    process.env.ALIBABA_VIDEO_MODEL = "wan2.7-t2v-2026-06-12";
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString() === endpoint) {
        requestBody = JSON.parse(init!.body as string);
        return json({ output: { task_id: "task-i2v" } });
      }
      if (url.toString().includes("/tasks/")) return json({ output: { task_status: "SUCCEEDED", video_url: "https://result.example/video.mp4" } });
      return { ok: true, status: 200, arrayBuffer: async () => fakeMp4.buffer } as Response;
    }));
    await createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 0, prompt: "Animate", durationSec: 5, aspectRatio: "9:16", startingFrame: { imageUrl: "https://image.example/frame.png" } });
    expect(requestBody?.model).toBe("wan2.7-i2v-2026-06-12");
  });

  it("rejects a non-MP4 successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (url.toString() === endpoint) return json({ output: { task_id: "task-invalid" } });
      if (url.toString().includes("/tasks/")) return json({ output: { task_status: "SUCCEEDED", video_url: "https://result.example/error" } });
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("not an mp4").buffer } as Response;
    }));
    await expect(createAlibabaAdapter(outDir).generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 5, aspectRatio: "9:16" })).rejects.toThrow(/not a valid MP4/);
  });
});
