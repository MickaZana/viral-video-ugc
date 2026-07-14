import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeWithWhisper } from "./asr.js";

describe("transcribeWithWhisper", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("posts multipart form data to OpenAI's transcription endpoint with the bearer key", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            text: "hello world",
            segments: [{ start: 0, end: 1.5, text: " hello world " }]
          }),
          { status: 200 }
        );
      })
    );

    const result = await transcribeWithWhisper({ videoId: "v1", audio: Buffer.from("fake-audio") });

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((capturedInit!.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(capturedInit!.body).toBeInstanceOf(FormData);

    expect(result).toEqual({
      videoId: "v1",
      source: "whisper",
      text: "hello world",
      segments: [{ startSec: 0, endSec: 1.5, text: "hello world" }]
    });
  });

  it("throws a descriptive error on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad audio format", { status: 400 }))
    );

    await expect(transcribeWithWhisper({ videoId: "v1", audio: Buffer.from("x") })).rejects.toThrow(
      /Whisper transcription failed \(400\)/
    );
  });

  it("throws when OPENAI_API_KEY is not configured", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(transcribeWithWhisper({ videoId: "v1", audio: Buffer.from("x") })).rejects.toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("defaults segments to an empty array when Whisper omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ text: "no segments here" }), { status: 200 }))
    );
    const result = await transcribeWithWhisper({ videoId: "v2", audio: Buffer.from("x") });
    expect(result.segments).toEqual([]);
  });
});
