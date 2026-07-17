import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const AUTH_HEADER = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64") };

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: "/tmp/final.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "Hook line",
      points: ["Point one"],
      cta: "Cta line",
      durationSec: 20,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 90,
    flags: [],
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

describe("POST /queue/:id/publish", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-publish-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    // No TIKTOK_ACCESS_TOKEN etc. set — every test below either expects a clean
    // requireEnvVar failure (proving the "real vendor call, not a stub" path is
    // actually reached) or is gated before ever reaching the adapter.
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("refuses to publish an item that isn't approved yet", async () => {
    insertReviewItem(makeItem({ status: "pending" }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/must be approved/);
  });

  it("refuses to double-publish an already-published item", async () => {
    insertReviewItem(makeItem({ status: "approved", publishedPostId: "already-posted-1" }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already published/);
  });

  it("returns 404 for an unknown item id", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/queue/does-not-exist/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });

  it("reaches the real adapter and surfaces its error cleanly when no credentials are configured", async () => {
    insertReviewItem(makeItem({ status: "approved" }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/TIKTOK_ACCESS_TOKEN/);
  });

  it("throws a clear, specific error for instagram_reels when PUBLIC_BASE_URL isn't configured, without ever attempting a network call", async () => {
    insertReviewItem(makeItem({ status: "approved", platform: "instagram_reels" }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/PUBLIC_BASE_URL/);
  });

  it("publishes an instagram_reels item via a self-hosted signed public video URL once PUBLIC_BASE_URL is set", async () => {
    process.env.PUBLIC_BASE_URL = "http://localhost:9999";
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_IG_BUSINESS_ACCOUNT_ID = "ig-user-1";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "fake video bytes");
    insertReviewItem(makeItem({ status: "approved", platform: "instagram_reels", videoPath }));

    // Only intercepts calls to Meta's Graph API — the test's own request to the
    // local server below still needs a working, unstubbed fetch to reach it.
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (!urlStr.startsWith("https://graph.facebook.com/")) return realFetch(url, init);
      if (urlStr.endsWith("/ig-user-1/media")) return { ok: true, json: async () => ({ id: "container-1" }) } as Response;
      if (urlStr.includes("container-1?")) return { ok: true, json: async () => ({ status_code: "FINISHED" }) } as Response;
      if (urlStr.endsWith("/media_publish")) return { ok: true, json: async () => ({ id: "media-99" }) } as Response;
      throw new Error(`unexpected URL in test: ${urlStr}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publishedPostId).toBe("media-99");

    // Confirms a real signed public video_url (not the raw local path) was sent to Meta.
    const createCall = fetchSpy.mock.calls.find(([url]) => url.toString().endsWith("/ig-user-1/media"));
    const sentBody = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(sentBody.video_url).toMatch(/^http:\/\/localhost:9999\/public\/assets\//);

    vi.unstubAllGlobals();
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
  });

  it("requires Basic Auth, same as the rest of /queue", async () => {
    insertReviewItem(makeItem({ status: "approved" }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
