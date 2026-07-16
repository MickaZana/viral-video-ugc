import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSilentAudioFixture } from "../test-fixtures.js";
import { createElevenLabsAdapter } from "./elevenlabs.js";

// A real, valid ~1s silent MP3, generated once via ffmpeg — needed because
// synthesize() probes the written file's duration via ffprobe, so the mocked
// response body must be bytes ffprobe can actually parse, not hand-crafted
// guesswork at what an MP3 header looks like.
let realSilentMp3Bytes: Buffer;

function fakeMp3Response(ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    arrayBuffer: async () =>
      realSilentMp3Bytes.buffer.slice(realSilentMp3Bytes.byteOffset, realSilentMp3Bytes.byteOffset + realSilentMp3Bytes.byteLength),
    text: async () => (ok ? "" : "synthesis failed")
  } as Response;
}

let testDir: string;
let fixtureDir: string;

describe("createElevenLabsAdapter", () => {
  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "vvugc-elevenlabs-fixture-"));
    realSilentMp3Bytes = await makeSilentAudioFixture(fixtureDir, 1);
  }, 30000);

  afterAll(() => {
    if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-elevenlabs-test-"));
    process.env.ELEVENLABS_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("throws a clear error when ELEVENLABS_API_KEY is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const adapter = createElevenLabsAdapter();
    await expect(adapter.synthesize("hello", join(testDir, "out.mp3"))).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  it(
    "POSTs to the documented text-to-speech endpoint with the xi-api-key header and text/model_id body, and writes the returned audio to disk",
    async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      let capturedBody: any;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          capturedUrl = url.toString();
          capturedHeaders = init?.headers as Record<string, string>;
          capturedBody = JSON.parse(init?.body as string);
          return fakeMp3Response();
        })
      );

      const adapter = createElevenLabsAdapter();
      const outPath = join(testDir, "cue-0.mp3");
      const result = await adapter.synthesize("Wait for it", outPath);

      expect(capturedUrl).toContain("/v1/text-to-speech/");
      expect(capturedHeaders?.["xi-api-key"]).toBe("test-key");
      expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
      expect(capturedBody.text).toBe("Wait for it");
      expect(capturedBody.model_id).toBeTruthy();

      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath).length).toBeGreaterThan(0);
      expect(result.filePath).toBe(outPath);
      expect(result.durationSec).toBeGreaterThan(0);
    },
    15000
  );

  it("uses ELEVENLABS_VOICE_ID in the URL when set, instead of the default voice", async () => {
    process.env.ELEVENLABS_VOICE_ID = "custom-voice-id";
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        capturedUrl = url.toString();
        return fakeMp3Response();
      })
    );

    await createElevenLabsAdapter().synthesize("hi", join(testDir, "out.mp3"));
    expect(capturedUrl).toContain("/text-to-speech/custom-voice-id");
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeMp3Response(false, 422)));
    const adapter = createElevenLabsAdapter();
    await expect(adapter.synthesize("hi", join(testDir, "out.mp3"))).rejects.toThrow(/422/);
  });
});
