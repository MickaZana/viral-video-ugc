import { createHmac } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKlingAdapter } from "./kling.js";

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-kling`;

describe("createKlingAdapter", () => {
  beforeEach(() => {
    process.env.KLING_ACCESS_KEY = "test-access-key";
    process.env.KLING_SECRET_KEY = "test-secret-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KLING_ACCESS_KEY;
    delete process.env.KLING_SECRET_KEY;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("signs a real, verifiable HS256 JWT with the access key as issuer", async () => {
    let capturedAuth: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/text2video") && init?.method === "POST") {
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        return jsonResponse({ code: 0, message: "ok", data: { task_id: "task-1" } });
      }
      if (urlStr.includes("/text2video/task-1")) {
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { task_status: "succeed", task_result: { videos: [{ url: "https://example.com/v.mp4" }] } }
        });
      }
      // download step
      return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createKlingAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "test", durationSec: 5, aspectRatio: "9:16" });

    expect(capturedAuth).toMatch(/^Bearer /);
    const jwt = capturedAuth!.replace("Bearer ", "");
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");

    const header = JSON.parse(base64UrlDecode(headerB64).toString());
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString());
    expect(payload.iss).toBe("test-access-key");
    expect(payload.exp).toBeGreaterThan(payload.nbf);
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeCloseTo(1800, -1);

    const expectedSig = createHmac("sha256", "test-secret-key")
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(signatureB64).toBe(expectedSig);
  });

  it("reads task_id and video URL from the .data envelope, not the response root", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/text2video") && !urlStr.includes("task-")) {
        return jsonResponse({ code: 0, message: "ok", data: { task_id: "task-envelope" } });
      }
      if (urlStr.includes("task-envelope")) {
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { task_status: "succeed", task_result: { videos: [{ url: "https://example.com/final.mp4" }] } }
        });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createKlingAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 2, prompt: "x", durationSec: 3, aspectRatio: "1:1" });

    expect(clip.id).toBe("task-envelope");
    expect(clip.vendor).toBe("kling");
    expect(clip.filePath).toContain("task-envelope");
  });

  it("throws immediately when the task status is failed, without retrying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/text2video") && !urlStr.includes("task-")) {
        return jsonResponse({ code: 0, message: "ok", data: { task_id: "task-fail" } });
      }
      return jsonResponse({ code: 0, message: "ok", data: { task_status: "failed" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createKlingAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/task-fail failed/);
  });

  it("throws a clear error when submit responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad request" }, false)));
    const adapter = createKlingAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/text2video submit failed/);
  });
});
