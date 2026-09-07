import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNvidiaAdapter } from "./nvidia.js";
import type { VideoGenRequest } from "./VideoGenAdapter.js";

// ---------------------------------------------------------------------------
// Test scaffolding — mirrors replicate.test.ts / wan.test.ts:
//  - vi.stubGlobal("fetch", vi.fn(...)) per test
//  - a jsonResponse helper
//  - an outDir under process.cwd()
//  - beforeEach sets process.env.NVIDIA_API_KEY
//  - afterEach: vi.unstubAllGlobals(), delete process.env.NVIDIA_*, rm outDir
// ---------------------------------------------------------------------------

const outDir = `${process.cwd()}/.test-out-nvidia`;
const GENERATIONS_URL = "https://integrate.api.nvidia.com/v1/videos/generations";

/** 12 bytes that pass validateGeneratedClip: bytes 4-8 === "ftyp", leading 0x00 box-size prefix. */
function validMp4(): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom")]);
}

/** Exact-length ArrayBuffer copy of a (possibly pooled) Buffer. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  Buffer.from(ab).set(buf);
  return ab;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

/** A response whose body is arbitrary text (used for error bodies + the retryable-status path). */
function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    },
    text: async () => text
  } as Response;
}

/** A 200 whose .json() throws — exercises the parse-json failure stage. */
function nonJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
    text: async () => "<html>not json</html>"
  } as Response;
}

/** A binary GET (reference-image fetch or URL-fallback clip download): arrayBuffer() + Headers, no body. */
function binaryResponse(buf: Buffer, headers: Record<string, string> = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => toArrayBuffer(buf)
  } as Response;
}

type Cap = { url?: string; auth?: string; body?: Record<string, unknown>; sideUrl?: string };

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => handler(url.toString(), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Handler that answers ONLY the generations POST (capturing url/auth/body) and
 * throws on any other fetch — so an unexpected image/download request fails loudly.
 */
function generationsOnly(responseBody: unknown, cap: Cap): FetchHandler {
  return (url, init) => {
    if (url.endsWith("/videos/generations") && init?.method === "POST") {
      cap.url = url;
      cap.auth = (init.headers as Record<string, string>).Authorization;
      cap.body = JSON.parse(init.body as string);
      return jsonResponse(responseBody);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

function baseReq(overrides: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return { scriptSegmentIndex: 0, prompt: "a hook", durationSec: 5, aspectRatio: "9:16", ...overrides };
}

const B64_OK = validMp4().toString("base64");

describe("createNvidiaAdapter", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_VIDEO_MODEL;
    delete process.env.NVIDIA_VIDEO_BASE_URL;
    delete process.env.NVIDIA_VIDEO_VARIANT;
    delete process.env.NVIDIA_VIDEO_TIMEOUT_MS;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("exposes vendor 'nvidia'", () => {
    expect(createNvidiaAdapter(outDir).vendor).toBe("nvidia");
  });

  // -------------------------------------------------------------------------
  // Text-to-video
  // -------------------------------------------------------------------------

  it("posts a prompt-only request with the documented body and Bearer auth (no image key)", async () => {
    const cap: Cap = {};
    const mock = stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq());

    expect(cap.url).toBe(GENERATIONS_URL);
    expect(cap.auth).toBe("Bearer test-key");
    expect(cap.body).toEqual({ model: "wan-ai/wan2.2", prompt: "a hook", size: "480x832", seconds: 5 });
    expect("image" in cap.body!).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("writes the decoded base64 MP4 to outDir and returns the RawClip", async () => {
    const mp4 = validMp4();
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: mp4.toString("base64") }] }, cap));

    const clip = await createNvidiaAdapter(outDir).generate(baseReq());

    expect(clip).toEqual({
      id: "vg1",
      scriptSegmentIndex: 0,
      vendor: "nvidia",
      filePath: `${outDir}/nvidia-0-vg1.mp4`,
      durationSec: 5
    });
    expect(existsSync(clip.filePath)).toBe(true);
    expect(readFileSync(clip.filePath).equals(mp4)).toBe(true);
  });

  it.each([
    ["9:16", "480x832"],
    ["1:1", "624x624"],
    ["16:9", "832x480"]
  ] as const)("maps aspectRatio %s -> size %s", async (aspectRatio, size) => {
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq({ aspectRatio }));

    expect(cap.body!.size).toBe(size);
  });

  it.each([
    [30, 8],
    [0, 1],
    [5, 5]
  ])("clamps durationSec %i -> seconds %i", async (durationSec, seconds) => {
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq({ durationSec }));

    expect(cap.body!.seconds).toBe(seconds);
  });

  it("uses NVIDIA_VIDEO_MODEL to override the model in the body", async () => {
    process.env.NVIDIA_VIDEO_MODEL = "acme/nim-video-7b";
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq());

    expect(cap.body!.model).toBe("acme/nim-video-7b");
  });

  it("applies NVIDIA_VIDEO_BASE_URL (with trailing slash) to the POST URL", async () => {
    process.env.NVIDIA_VIDEO_BASE_URL = "https://nim.internal:8000/v1/";
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq());

    expect(cap.url).toBe("https://nim.internal:8000/v1/videos/generations");
  });

  it("enriches the prompt with visual direction when provided", async () => {
    const cap: Cap = {};
    stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(baseReq({ visualDirection: { lighting: "golden_hour" } }));

    expect(typeof cap.body!.prompt).toBe("string");
    expect(cap.body!.prompt).not.toBe("a hook");
    expect((cap.body!.prompt as string).startsWith("a hook. ")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Image-to-video
  // -------------------------------------------------------------------------

  it("inlines referenceImageDataUri as body.image without any image fetch", async () => {
    const cap: Cap = {};
    const mock = stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(
      baseReq({ referenceImageDataUri: "data:image/png;base64,AAAA" })
    );

    expect(cap.body!.image).toBe("data:image/png;base64,AAAA");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("prefers startingFrame.imageDataUri over referenceImageUrl (no fetch)", async () => {
    const cap: Cap = {};
    const mock = stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(
      baseReq({
        startingFrame: { imageDataUri: "data:image/png;base64,SF" },
        referenceImageUrl: "https://example.com/x.jpg"
      })
    );

    expect(cap.body!.image).toBe("data:image/png;base64,SF");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("fetches a URL-only reference image first, then inlines it as a data URI in the POST", async () => {
    const imgBytes = Buffer.from([1, 2, 3]);
    const cap: Cap = {};
    const mock = stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        cap.body = JSON.parse(init.body as string);
        return jsonResponse({ id: "vg1", data: [{ b64_json: B64_OK }] });
      }
      cap.sideUrl = url;
      return binaryResponse(imgBytes, { "content-type": "image/jpeg", "content-length": "3" });
    });

    await createNvidiaAdapter(outDir).generate(baseReq({ referenceImageUrl: "https://example.com/x.jpg" }));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0][0]).toBe("https://example.com/x.jpg"); // GET happens first
    expect(cap.sideUrl).toBe("https://example.com/x.jpg");
    expect(cap.body!.image).toBe(`data:image/jpeg;base64,${imgBytes.toString("base64")}`);
  });

  it("NVIDIA_VIDEO_VARIANT=i2v with only a URL ref -> i2v (image inlined)", async () => {
    process.env.NVIDIA_VIDEO_VARIANT = "i2v";
    const imgBytes = Buffer.from([9, 9, 9, 9]);
    const cap: Cap = {};
    stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        cap.body = JSON.parse(init.body as string);
        return jsonResponse({ id: "vg1", data: [{ b64_json: B64_OK }] });
      }
      return binaryResponse(imgBytes, { "content-type": "image/png", "content-length": "4" });
    });

    await createNvidiaAdapter(outDir).generate(baseReq({ referenceImageUrl: "https://example.com/x.png" }));

    expect(cap.body!.image).toBe(`data:image/png;base64,${imgBytes.toString("base64")}`);
  });

  it("NVIDIA_VIDEO_VARIANT=t2v with a ref present -> body has NO image, no fetch of the ref", async () => {
    process.env.NVIDIA_VIDEO_VARIANT = "t2v";
    const cap: Cap = {};
    const mock = stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    await createNvidiaAdapter(outDir).generate(
      baseReq({ referenceImageDataUri: "data:image/png;base64,AAAA" })
    );

    expect("image" in cap.body!).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("i2v auto-selected but the ref image GET fails -> falls back to t2v, generation still succeeds", async () => {
    const cap: Cap = {};
    const mock = stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        cap.body = JSON.parse(init.body as string);
        return jsonResponse({ id: "vg1", data: [{ b64_json: B64_OK }] });
      }
      return textResponse(500, "upstream down");
    });

    const clip = await createNvidiaAdapter(outDir).generate(
      baseReq({ referenceImageUrl: "https://example.com/x.jpg" })
    );

    expect(clip.vendor).toBe("nvidia");
    expect("image" in cap.body!).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2); // image GET (no retry on non-ok) + generations POST
  });

  // -------------------------------------------------------------------------
  // HTTP failures — retry vs no-retry via fetchMock.mock.calls.length
  // -------------------------------------------------------------------------

  it.each([400, 401, 403, 422])("rejects on HTTP %i with NO retry (fetch called once)", async (status) => {
    const mock = stubFetch(() => textResponse(status, `{"error":"client fault"}`));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])("rejects on HTTP %i after 2 retries (fetch called 3 times)", async (status) => {
    vi.useFakeTimers();
    const mock = stubFetch(() => textResponse(status, "transient"));

    const p = createNvidiaAdapter(outDir).generate(baseReq());
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("rejects after 3 attempts on a transport error (fetch throws TypeError)", async () => {
    vi.useFakeTimers();
    const mock = stubFetch(() => {
      throw new TypeError("network");
    });

    const p = createNvidiaAdapter(outDir).generate(baseReq());
    const assertion = expect(p).rejects.toThrow(/network/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("rejects with a parse-json stage error when a 200 body is not JSON", async () => {
    const mock = stubFetch(() => nonJsonResponse());

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/stage=parse-json/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Invalid output
  // -------------------------------------------------------------------------

  it("rejects when data is an empty array (no base64 MP4 or video URL)", async () => {
    stubFetch(() => jsonResponse({ data: [] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(
      /No base64 MP4 or video URL/
    );
  });

  it("rejects with the async-job hint when the response looks like { id, status }", async () => {
    stubFetch(() => jsonResponse({ id: "vg1", status: "queued" }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/async job/);
  });

  it("rejects when the decoded base64 is not an MP4 (no ftyp box); NO file is left behind", async () => {
    const notMp4 = Buffer.from("<html>error</html>");
    stubFetch(() => jsonResponse({ data: [{ b64_json: notMp4.toString("base64") }] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/no ftyp box/);

    // validateGeneratedClip now runs on the `${filePath}.part` staging file BEFORE
    // it is promoted, and on failure the `.part` is removed — so a corrupt response
    // leaves NOTHING behind: no `nvidia-*.mp4` for a downstream glob to ingest, and
    // no `nvidia-*.mp4.part` either.
    const leftovers = readdirSync(outDir).filter((f) => /^nvidia-.*\.mp4(\.part)?$/.test(f));
    expect(leftovers).toEqual([]);
  });

  it('rejects an empty-string b64_json via the "no payload" branch (correct attribution)', async () => {
    // extractVideoPayload only accepts a NON-empty base64/url string, so `b64_json:""`
    // falls through to the "No base64 MP4 or video URL" path — the correct attribution:
    // an explicitly-empty field is "no payload", not a zero-byte clip.
    stubFetch(() => jsonResponse({ data: [{ b64_json: "" }] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(
      /No base64 MP4 or video URL/
    );
  });

  it('rejects an empty-string url the same way — an explicitly-empty field is "no payload"', async () => {
    stubFetch(() => jsonResponse({ data: [{ url: "" }] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(
      /No base64 MP4 or video URL/
    );
  });

  it('rejects with "empty (0 bytes)" when base64 is non-empty but decodes to zero bytes', async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: "====" }] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/empty \(0 bytes\)/);
  });

  it("downloads the clip when the response carries a URL instead of inline base64", async () => {
    const mp4 = validMp4();
    const cap: Cap = {};
    const mock = stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        return jsonResponse({ data: [{ url: "https://cdn.example/v.mp4" }] });
      }
      cap.sideUrl = url;
      return binaryResponse(mp4);
    });

    const clip = await createNvidiaAdapter(outDir).generate(baseReq());

    expect(cap.sideUrl).toBe("https://cdn.example/v.mp4");
    expect(clip.vendor).toBe("nvidia");
    expect(existsSync(clip.filePath)).toBe(true);
    expect(readFileSync(clip.filePath).equals(mp4)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("rejects with a download-stage error when the URL-fallback download is not ok", async () => {
    const mock = stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        return jsonResponse({ data: [{ url: "https://cdn.example/bad.mp4" }] });
      }
      return textResponse(404, "not found");
    });

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/stage=download/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  it("rejects when NVIDIA_API_KEY is unset", async () => {
    delete process.env.NVIDIA_API_KEY;
    const mock = stubFetch(() => jsonResponse({ data: [{ b64_json: B64_OK }] }));

    await expect(createNvidiaAdapter(outDir).generate(baseReq())).rejects.toThrow(/NVIDIA_API_KEY/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/x.png"
  ])("never fetches an SSRF-blocked reference image (%s); falls back to t2v", async (refUrl) => {
    const cap: Cap = {};
    const mock = stubFetch(generationsOnly({ id: "vg1", data: [{ b64_json: B64_OK }] }, cap));

    const clip = await createNvidiaAdapter(outDir).generate(baseReq({ referenceImageUrl: refUrl }));

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe(GENERATIONS_URL);
    expect("image" in cap.body!).toBe(false);
    expect(clip.vendor).toBe("nvidia");
  });

  it("scrubs Bearer / nvapi- tokens out of a sanitized 401 error message", async () => {
    const leaky = '{"error":"bad key: Bearer nvapi-SECRETVALUE123"}';
    stubFetch(() => textResponse(401, leaky));

    const err = (await createNvidiaAdapter(outDir)
      .generate(baseReq())
      .catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("SECRETVALUE123");
    expect(err.message).not.toContain("nvapi-SECRETVALUE123");
  });

  it("falls back to t2v when the reference image is over the size cap (Content-Length)", async () => {
    const cap: Cap = {};
    const mock = stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        cap.body = JSON.parse(init.body as string);
        return jsonResponse({ id: "vg1", data: [{ b64_json: B64_OK }] });
      }
      return binaryResponse(Buffer.alloc(0), {
        "content-type": "image/png",
        "content-length": String(20 * 1024 * 1024)
      });
    });

    const clip = await createNvidiaAdapter(outDir).generate(
      baseReq({ referenceImageUrl: "https://example.com/big.png" })
    );

    expect("image" in cap.body!).toBe(false);
    expect(clip.vendor).toBe("nvidia");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("falls back to t2v when the reference URL returns a non-image Content-Type", async () => {
    const cap: Cap = {};
    stubFetch((url, init) => {
      if (url.endsWith("/videos/generations") && init?.method === "POST") {
        cap.body = JSON.parse(init.body as string);
        return jsonResponse({ id: "vg1", data: [{ b64_json: B64_OK }] });
      }
      return binaryResponse(Buffer.from("<html>"), { "content-type": "text/html" });
    });

    await createNvidiaAdapter(outDir).generate(
      baseReq({ referenceImageUrl: "https://example.com/page.html" })
    );

    expect("image" in cap.body!).toBe(false);
  });
});
