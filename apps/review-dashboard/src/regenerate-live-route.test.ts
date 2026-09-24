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
  const script = {
    videoId: "v1",
    hook: "Original hook",
    points: ["Original point one", "Original point two"],
    cta: "Original cta",
    durationSec: 24,
    brandVoice: "energetic",
    locale: "en",
    trendingPhrases: []
  };
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: "/tmp/old.mp4",
    platform: "tiktok",
    script,
    score: 70,
    flags: [],
    clips: [{ id: "c0", scriptSegmentIndex: 0, vendor: "kling", filePath: "/tmp/c0.mp4", durationSec: 6 }],
    captions: [{ startSec: 0, endSec: 6, text: "x" }],
    status: "approved",
    dryRun: true,
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

describe("regenerate-live route", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-regen-live-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("requires Basic Auth, same as the rest of /queue", async () => {
    insertReviewItem(makeItem());
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown item id", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/queue/does-not-exist/regenerate-live`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(res.status).toBe(404);
  });

  it("refuses to promote an item that is already a live render (409)", async () => {
    insertReviewItem(makeItem({ dryRun: false }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-live`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already a live/i);
  });

  it("requires a videoVendor when the item has no stored clips (400)", async () => {
    insertReviewItem(makeItem({ id: "no-clips", clips: undefined, captions: undefined }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/no-clips/regenerate-live`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/videoVendor is required/i);
  });
});
