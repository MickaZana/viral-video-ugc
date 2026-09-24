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
    // A test that sets this (e.g. "authenticates with GROK_API_KEY...") would
    // otherwise leak it into every later test in this file — xaiGrokKeyCandidates
    // tries GROK_API_KEY first, so a stale value here would silently steer
    // later tests' fetch calls onto the wrong key.
    delete process.env.GROK_API_KEY;
    delete process.env.GROK_VOICE_ID;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("throws a clear error when XAI_API_KEY and GROK_API_KEY are missing", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    const adapter = createGrokAdapter();
    await expect(adapter.synthesize("hello", join(testDir, "out.mp3"))).rejects.toThrow(/XAI_API_KEY/);
  });

  it("authenticates with GROK_API_KEY when XAI_API_KEY is not set", async () => {
    delete process.env.XAI_API_KEY;
    process.env.GROK_API_KEY = "grok-direct-key";
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return fakeMp3Response();
      })
    );

    const adapter = createGrokAdapter();
    await adapter.synthesize("test", join(testDir, "out.mp3"));
    expect(capturedHeaders?.Authorization).toBe("Bearer grok-direct-key");
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

  it("does not retry a non-403 failure against the alternate candidate key", async () => {
    process.env.GROK_API_KEY = "second-candidate-key";
    const fetchMock = vi.fn(async () => fakeMp3Response(false, 500));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokAdapter();
    await expect(adapter.synthesize("hi", join(testDir, "out.mp3"))).rejects.toThrow(/500/);
    // A 500 fails the same way on every candidate — burning a second live call
    // would just double the cost/latency for no chance of a different outcome.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete process.env.GROK_API_KEY;
  });

  it("retries with the alternate candidate key when the first returns 403 (unfunded/no-permission team)", async () => {
    // Two distinct real-looking keys under the two accepted names — reproduces
    // the reported incident: an unfunded key under one name shadowing a
    // working key under the other, except now it self-heals instead of failing.
    // beforeEach already set XAI_API_KEY = "test-key"; overwrite it with the
    // unfunded one. xaiGrokKeyCandidatesFrom tries GROK_API_KEY before
    // XAI_API_KEY (with no .env values present under Vitest), so the unfunded
    // key must be the one under GROK_API_KEY to actually land first.
    process.env.GROK_API_KEY = "unfunded-team-key";
    process.env.XAI_API_KEY = "funded-team-key";
    const capturedAuthHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      capturedAuthHeaders.push(auth);
      if (auth === "Bearer funded-team-key") return fakeMp3Response();
      return {
        ok: false,
        status: 403,
        text: async () => '{"error":"team has no credits or licenses yet"}'
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokAdapter();
    const result = await adapter.synthesize("hi", join(testDir, "out.mp3"));

    expect(existsSync(result.filePath)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(capturedAuthHeaders[0]).toBe("Bearer unfunded-team-key");
    expect(capturedAuthHeaders[1]).toBe("Bearer funded-team-key");
    delete process.env.GROK_API_KEY;
  });

  it("gives up after every candidate returns 403, surfacing the last response", async () => {
    process.env.GROK_API_KEY = "also-unfunded-key";
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":"no credits"}'
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokAdapter();
    await expect(adapter.synthesize("hi", join(testDir, "out.mp3"))).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    delete process.env.GROK_API_KEY;
  });
});
