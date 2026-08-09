import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const thisFilePath = fileURLToPath(import.meta.url);

const extractAudioMock = vi.fn();
vi.mock("./audio-extract.js", () => ({ extractAudio: extractAudioMock }));

const { fetchYouTubeCaptions, mockTranscript, transcribeCandidate, transcribeWithAsrFallback } = await import(
  "./lib.js"
);

function textResponse(body: string, ok = true): Response {
  return { ok, status: ok ? 200 : 404, text: async () => body } as Response;
}

function whisperResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      text: "extracted and transcribed",
      segments: [{ start: 0, end: 2, text: "extracted and transcribed" }]
    })
  } as Response;
}

const candidate = {
  id: "abc123",
  platform: "youtube_shorts" as const,
  url: "https://www.youtube.com/watch?v=abc123",
  title: "Test video",
  publishedAt: "2026-01-01T00:00:00.000Z",
  niche: "fitness",
  metrics: { views: 1000, likes: 10, comments: 2 }
};

describe("fetchYouTubeCaptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses timedtext XML into timestamped segments and joined text", async () => {
    const xml = `<transcript><text start="0.5" dur="2.5">Hello &amp; welcome</text><text start="3" dur="1.2">world</text></transcript>`;
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(xml)));

    const transcript = await fetchYouTubeCaptions("abc123");

    expect(transcript).toBeDefined();
    expect(transcript!.source).toBe("platform_captions");
    expect(transcript!.segments).toHaveLength(2);
    expect(transcript!.segments[0]).toEqual({ startSec: 0.5, endSec: 3, text: "Hello & welcome" });
    expect(transcript!.segments[1]).toEqual({ startSec: 3, endSec: 4.2, text: "world" });
    expect(transcript!.text).toBe("Hello & welcome world");
  });

  it("decodes &lt; &gt; &#39; &quot; entities in caption text", async () => {
    const xml = `<transcript><text start="0" dur="1">&lt;tag&gt; &#39;quote&#39; &quot;double&quot;</text></transcript>`;
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(xml)));

    const transcript = await fetchYouTubeCaptions("abc123");
    expect(transcript!.segments[0].text).toBe(`<tag> 'quote' "double"`);
  });

  it("returns undefined when the request fails (timedtext and yt-dlp both yield nothing)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("", false)));
    const runner = vi.fn(async () => { throw new Error("yt-dlp failed"); });
    expect(await fetchYouTubeCaptions("abc123", runner)).toBeUndefined();
  });

  it("returns undefined when the video has no caption track", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("")));
    const runner = vi.fn(async () => {});
    expect(await fetchYouTubeCaptions("abc123", runner)).toBeUndefined();
  });

  it("falls back to yt-dlp auto-subs when timedtext is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("")));
    const runner = vi.fn(async (_url: string, opts: Record<string, unknown>) => {
      const outDir = dirname(opts.output as string);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "abc123.en.json3"),
        JSON.stringify({
          events: [{ tStartMs: 500, dDurationMs: 2500, segs: [{ utf8: "Hello & welcome" }] }]
        })
      );
    });

    const transcript = await fetchYouTubeCaptions("abc123", runner);
    expect(transcript).toBeDefined();
    expect(transcript!.source).toBe("platform_captions");
    expect(transcript!.segments[0]).toEqual({ startSec: 0.5, endSec: 3, text: "Hello & welcome" });
  });
});

describe("transcribeWithAsrFallback (real extraction -> Whisper wiring)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    extractAudioMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("passes extractAudio's output file to Whisper and returns a whisper-sourced transcript", async () => {
    extractAudioMock.mockResolvedValue({ filePath: thisFilePath }); // any real, readable file path

    let capturedAuth: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
        return whisperResponse();
      })
    );

    const transcript = await transcribeWithAsrFallback(candidate, "/tmp/out");

    expect(extractAudioMock).toHaveBeenCalledWith(candidate, "/tmp/out");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(transcript.source).toBe("whisper");
    expect(transcript.text).toBe("extracted and transcribed");
  });

  it("propagates a failed extraction as a clear error, without calling Whisper", async () => {
    extractAudioMock.mockRejectedValue(new Error("Audio extraction failed for candidate \"abc123\": yt-dlp exited 1"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeWithAsrFallback(candidate, "/tmp/out")).rejects.toThrow(/yt-dlp exited 1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("transcribeCandidate", () => {
  beforeEach(() => {
    extractAudioMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses YouTube captions when available for youtube_shorts, skipping ASR entirely", async () => {
    const xml = `<transcript><text start="0" dur="1">hi</text></transcript>`;
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(xml)));

    const transcript = await transcribeCandidate(candidate, "/tmp/out");
    expect(transcript.source).toBe("platform_captions");
    expect(extractAudioMock).not.toHaveBeenCalled();
  });

  it("falls back to ASR when youtube_shorts has no captions", async () => {
    extractAudioMock.mockResolvedValue({ filePath: thisFilePath });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      return urlStr.includes("timedtext") ? textResponse("") : whisperResponse();
    }));
    process.env.OPENAI_API_KEY = "test-key";
    const subtitleRunner = vi.fn(async () => { throw new Error("yt-dlp found no subs"); });

    const transcript = await transcribeCandidate(candidate, "/tmp/out", subtitleRunner);
    expect(extractAudioMock).toHaveBeenCalled();
    expect(transcript.source).toBe("whisper");
    delete process.env.OPENAI_API_KEY;
  });

  it("skips the YouTube-captions path entirely for non-YouTube platforms", async () => {
    extractAudioMock.mockResolvedValue({ filePath: thisFilePath });
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => whisperResponse());
    vi.stubGlobal("fetch", fetchMock);

    await transcribeCandidate({ ...candidate, platform: "tiktok" }, "/tmp/out");
    expect(extractAudioMock).toHaveBeenCalledWith({ ...candidate, platform: "tiktok" }, "/tmp/out");
    delete process.env.OPENAI_API_KEY;
  });
});

describe("mockTranscript", () => {
  it("produces a valid Transcript shape with no network calls", () => {
    const transcript = mockTranscript(candidate);
    expect(transcript.videoId).toBe(candidate.id);
    expect(transcript.text).toContain(candidate.title);
    expect(transcript.segments.length).toBeGreaterThan(0);
  });
});
