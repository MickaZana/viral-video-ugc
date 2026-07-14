import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYouTubeCaptions, mockTranscript, transcribeCandidate, transcribeWithAsrFallback } from "./lib.js";

function textResponse(body: string, ok = true): Response {
  return { ok, status: ok ? 200 : 404, text: async () => body } as Response;
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

  it("returns undefined when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("", false)));
    expect(await fetchYouTubeCaptions("abc123")).toBeUndefined();
  });

  it("returns undefined when the video has no caption track", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("")));
    expect(await fetchYouTubeCaptions("abc123")).toBeUndefined();
  });
});

describe("transcribeWithAsrFallback", () => {
  it("throws a clear, actionable error since no ASR provider is wired in", async () => {
    await expect(transcribeWithAsrFallback(candidate)).rejects.toThrow(/No ASR fallback provider configured/);
  });
});

describe("transcribeCandidate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses YouTube captions when available for youtube_shorts", async () => {
    const xml = `<transcript><text start="0" dur="1">hi</text></transcript>`;
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(xml)));

    const transcript = await transcribeCandidate(candidate);
    expect(transcript.source).toBe("platform_captions");
  });

  it("falls back to ASR (and throws, since none is configured) when youtube_shorts has no captions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("")));
    await expect(transcribeCandidate(candidate)).rejects.toThrow(/No ASR fallback provider configured/);
  });

  it("skips the YouTube-captions path entirely for non-YouTube platforms", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeCandidate({ ...candidate, platform: "tiktok" })).rejects.toThrow(
      /No ASR fallback provider configured/
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
