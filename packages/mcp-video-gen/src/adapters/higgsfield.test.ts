import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldAdapter } from "./higgsfield.js";
import type { McpToolCaller } from "./VideoGenAdapter.js";

const outDir = `${process.cwd()}/.test-out-higgsfield`;

describe("createHiggsfieldAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("calls generate_video with the real tool's field names (model, duration, aspect_ratio), not the old guessed ones", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const callMcpTool: McpToolCaller = vi.fn(async (toolName, args) => {
      if (toolName === "generate_video") {
        capturedArgs = args;
        return { jobId: "job-1" };
      }
      if (toolName === "job_status") {
        return { status: "completed", video: { url: "https://example.com/v.mp4" } };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as Response));

    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "a hook", durationSec: 5, aspectRatio: "9:16" });

    expect(capturedArgs).toEqual({ model: "kling3_0_turbo", prompt: "a hook", duration: 5, aspect_ratio: "9:16" });
  });

  it("imports a reference image to a media_id first, and passes medias[] (not a raw reference_image_url)", async () => {
    let generateArgs: Record<string, unknown> | undefined;
    const callMcpTool: McpToolCaller = vi.fn(async (toolName, args) => {
      if (toolName === "media_import_url") {
        expect(args).toEqual({ url: "https://example.com/ref.jpg", type: "image" });
        return { media_id: "media-abc" };
      }
      if (toolName === "generate_video") {
        generateArgs = args;
        return { jobId: "job-img" };
      }
      if (toolName === "job_status") {
        return { status: "completed", video: { url: "https://example.com/v.mp4" } };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) as Response));

    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "1:1",
      referenceImageUrl: "https://example.com/ref.jpg"
    });

    expect(generateArgs?.medias).toEqual([{ value: "media-abc", role: "image" }]);
  });

  it("reads job id and video URL correctly regardless of camelCase/snake_case field naming", async () => {
    const callMcpTool: McpToolCaller = vi.fn(async (toolName) => {
      if (toolName === "generate_video") return { job_id: "job-snake" };
      if (toolName === "job_status") return { status: "completed", video_url: "https://example.com/final.mp4" };
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) as Response));

    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 3, prompt: "x", durationSec: 3, aspectRatio: "9:16" });

    expect(clip.id).toBe("job-snake");
    expect(clip.filePath).toContain("job-snake");
  });

  it("throws immediately with the raw response when the job status is failed, without retrying", async () => {
    const callMcpTool: McpToolCaller = vi.fn(async (toolName) => {
      if (toolName === "generate_video") return { jobId: "job-fail" };
      return { status: "failed", error: "content policy" };
    });

    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/job-fail failed/);
  });

  it("throws immediately on an ip_detected status rather than treating it as still-pending", async () => {
    const callMcpTool: McpToolCaller = vi.fn(async (toolName) => {
      if (toolName === "generate_video") return { jobId: "job-ip" };
      return { status: "ip_detected" };
    });

    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/job-ip ip_detected/);
  });

  it("throws a clear, diagnostic error when generate_video returns no recognizable job id", async () => {
    const callMcpTool: McpToolCaller = vi.fn(async () => ({ unexpected: "shape" }));
    const adapter = createHiggsfieldAdapter(callMcpTool, outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/no recognizable job id/);
  });
});
