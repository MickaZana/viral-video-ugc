import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSilentAudioFixture } from "../test-fixtures.js";
import { createGrokAdapter } from "./grok.js";

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

describe("createGrokAdapter", () => {
  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "vvugc-grok-fixture-"));
    realSilentMp3Bytes = await makeSilentAudioFixture(fixtureDir, 1);
  }, 30000);

  afterAll(() => {
    if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-grok-test-"));
    process.env.XAI_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_VOICE_ID;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("throws a clear error when XAI_API_KEY is missing", async () => {
    delete process.env.XAI_API_KEY;
    const adapter = createGrokAdapter();
    await expect(adapter.synthesize("hello", join(testDir, "out.mp3"))).rejects.toThrow(/XAI_API_KEY/);
  });

  it(
    "POSTs to xAI's TTS endpoint with a Bearer auth header and text/voice_id/language body, and writes the returned audio to disk",
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

      const adapter = createGrokAdapter();
      const outPath = join(testDir, "cue-0.mp3");
      const result = await adapter.synthesize("Wait for it", outPath);

      expect(capturedUrl).toBe("https://api.x.ai/v1/tts");
      expect(capturedHeaders?.Authorization).toBe("Bearer test-key");
      expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
      expect(capturedBody).toEqual({ text: "Wait for it", voice_id: "eve", language: "en" });

      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath).length).toBeGreaterThan(0);
      expect(result.filePath).toBe(outPath);
      expect(result.durationSec).toBeGreaterThan(0);
    },
    15000
  );

  it("uses GROK_VOICE_ID when set, instead of the default 'eve' voice", async () => {
    process.env.GROK_VOICE_ID = "leo";
    let capturedBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return fakeMp3Response();
      })
    );

    await createGrokAdapter().synthesize("hi", join(testDir, "out.mp3"));
    expect(capturedBody.voice_id).toBe("leo");
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeMp3Response(false, 500)));
    const adapter = createGrokAdapter();
    await expect(adapter.synthesize("hi", join(testDir, "out.mp3"))).rejects.toThrow(/500/);
  });
});
