import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchRemixTranscriptMock = vi.fn(async () => ({
  parsed: { platform: "youtube_shorts", videoId: "dQw4w9WgXcQ" },
  transcript: {
    videoId: "dQw4w9WgXcQ",
    source: "platform_captions" as const,
    text: "Wait for this. The old way of onboarding is broken.",
    segments: []
  }
}));

const previewRemixMock = vi.fn(async () => ({
  transcript: {
    videoId: "dQw4w9WgXcQ",
    source: "platform_captions" as const,
    text: "Wait for this.",
    segments: []
  },
  script: {
    videoId: "dQw4w9WgXcQ",
    hook: "Wait for this...",
    points: ["The old way of onboarding is broken"],
    cta: "Try the new way today",
    durationSec: 25,
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    trendingPhrases: []
  }
}));

vi.mock("@vvugc/orchestrator", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/orchestrator")>("@vvugc/orchestrator");
  return {
    ...actual,
    fetchRemixTranscript: fetchRemixTranscriptMock,
    previewRemix: previewRemixMock
  };
});

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;

async function startServer() {
  vi.resetModules();
  const { app } = await import("./server.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

function sessionCookieFrom(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function signupAndSession(): Promise<{ cookie: string; csrf: string }> {
  const signup = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "remixer@example.com", password: "hunter22" })
  });
  const cookie = sessionCookieFrom(signup);
  const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

describe("POST /accounts/remix", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-remix-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    fetchRemixTranscriptMock.mockClear();
    previewRemixMock.mockClear();
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("requires an authenticated session (401 without a cookie)", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/remix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", previewOnly: true })
    });
    expect(res.status).toBe(401);
  });

  it("rejects a source URL we can't parse with 400 before any network call", async () => {
    await startServer();
    const { cookie, csrf } = await signupAndSession();
    const res = await fetch(`${baseUrl}/accounts/remix`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://vimeo.com/123", previewOnly: true })
    });
    expect(res.status).toBe(400);
    expect(previewRemixMock).not.toHaveBeenCalled();
  });

  it("requires a client/settings to exist before remixing", async () => {
    await startServer();
    const { cookie, csrf } = await signupAndSession();
    const res = await fetch(`${baseUrl}/accounts/remix`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", previewOnly: true })
    });
    expect(res.status).toBe(400);
    expect(res.status === 400 && true).toBe(true);
  });

  it("previewOnly: returns the adapted script without touching video generation", async () => {
    await startServer();
    const { cookie, csrf } = await signupAndSession();
    // Create a client so settings exist (gives the endpoint its niche/brandVoice).
    const clientRes = await fetch(`${baseUrl}/accounts/clients`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Brand",
        niche: "fitness",
        brandVoice: "energetic",
        platforms: ["tiktok"],
        targetDurationSec: 25,
        videoVendor: "higgsfield",
        cadence: "manual"
      })
    });
    const clientId = (await clientRes.json()).client.id;

    const res = await fetch(`${baseUrl}/accounts/remix`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", clientId, previewOnly: true })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previewOnly).toBe(true);
    expect(body.script.hook).toBe("Wait for this...");
    expect(previewRemixMock).toHaveBeenCalledTimes(1);
    // Preview never runs the pipeline — fetchRemixTranscript is only used by the full-run path.
    expect(fetchRemixTranscriptMock).not.toHaveBeenCalled();
  });
});
