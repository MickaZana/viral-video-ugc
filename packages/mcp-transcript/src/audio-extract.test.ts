import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAudio } from "./audio-extract.js";

const candidate = {
  id: "vid1",
  platform: "tiktok" as const,
  url: "https://www.tiktok.com/@user/video/vid1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  niche: "fitness",
  metrics: { views: 1000, likes: 10, comments: 2 }
};

describe("extractAudio", () => {
  let outDir: string;

  afterEach(() => {
    if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("invokes the runner with the candidate's URL and audio-extraction flags, targeting <id>.mp3", async () => {
    outDir = mkdtempSync(join(tmpdir(), "extract-audio-"));
    let capturedUrl: string | undefined;
    let capturedOpts: Record<string, unknown> | undefined;

    const result = await extractAudio(candidate, outDir, async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      writeFileSync(opts.output as string, Buffer.from("fake mp3"));
      return { stdout: "" };
    });

    expect(capturedUrl).toBe(candidate.url);
    expect(capturedOpts?.extractAudio).toBe(true);
    expect(capturedOpts?.audioFormat).toBe("mp3");
    expect(capturedOpts?.output).toBe(join(outDir, "vid1.mp3"));
    expect(result.filePath).toBe(join(outDir, "vid1.mp3"));
    expect(existsSync(result.filePath)).toBe(true);
  });

  it("wraps a runner failure in a clear, candidate-specific error", async () => {
    outDir = mkdtempSync(join(tmpdir(), "extract-audio-"));
    await expect(
      extractAudio(candidate, outDir, async () => {
        throw new Error("network unreachable");
      })
    ).rejects.toThrow(/Audio extraction failed for candidate "vid1".*network unreachable/);
  });

  it("throws a clear error if the runner reports success but writes no file", async () => {
    outDir = mkdtempSync(join(tmpdir(), "extract-audio-"));
    await expect(
      extractAudio(candidate, outDir, async () => {
        return { stdout: "" }; // no file written
      })
    ).rejects.toThrow(/yt-dlp reported success but produced no file/);
  });
});
