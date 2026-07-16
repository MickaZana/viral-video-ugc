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
    clips: [
      { id: "c0", scriptSegmentIndex: 0, vendor: "kling", filePath: "/tmp/c0.mp4", durationSec: 6 },
      { id: "c1", scriptSegmentIndex: 1, vendor: "kling", filePath: "/tmp/c1.mp4", durationSec: 6 },
      { id: "c2", scriptSegmentIndex: 2, vendor: "kling", filePath: "/tmp/c2.mp4", durationSec: 6 },
      { id: "c3", scriptSegmentIndex: 3, vendor: "kling", filePath: "/tmp/c3.mp4", durationSec: 6 }
    ],
    captions: [
      { startSec: 0, endSec: 6, text: script.hook },
      { startSec: 6, endSec: 12, text: script.points[0] },
      { startSec: 12, endSec: 18, text: script.points[1] },
      { startSec: 18, endSec: 24, text: script.cta }
    ],
    sourceTranscriptText: "An unrelated source transcript about a totally different topic.",
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

describe("scene/script regeneration routes", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-regen-routes-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("regenerate-scene replaces one clip, resets status to pending, and persists via replaceReviewItem", async () => {
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 1, dryRun: true })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.clips).toHaveLength(4);
    expect(body.clips[1].filePath).not.toBe("/tmp/c1.mp4");
    expect(body.clips[0].filePath).toBe("/tmp/c0.mp4"); // untouched

    const persisted = await (
      await fetch(`${baseUrl}/queue/item-1`, { headers: AUTH_HEADER })
    ).json();
    expect(persisted.videoPath).toBe(body.videoPath);
  });

  it("regenerate-scene requires a valid integer sceneIndex", async () => {
    insertReviewItem(makeItem());
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    expect(res.status).toBe(400);
  });

  it("regenerate-scene returns 404 for an unknown item id", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/queue/does-not-exist/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0, dryRun: true })
    });
    expect(res.status).toBe(404);
  });

  it("regenerate-scene returns 422 with a clear error for an item with no stored clips", async () => {
    insertReviewItem(makeItem({ id: "no-clips", clips: undefined, captions: undefined }));
    await startServer();
    const res = await fetch(`${baseUrl}/queue/no-clips/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0, videoVendor: "kling", dryRun: true })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/no stored clips/);
  });

  it("regenerate-script re-renders every clip against the edited text and resets status", async () => {
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-script`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ hook: "New hook", points: ["New point"], cta: "New cta", dryRun: true })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.script.hook).toBe("New hook");
    expect(body.clips).toHaveLength(3);
  });

  it("regenerate-script requires hook/points/cta in the body", async () => {
    insertReviewItem(makeItem());
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-script`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ hook: "New hook" })
    });
    expect(res.status).toBe(400);
  });

  it("both regeneration routes require Basic Auth, same as the rest of /queue", async () => {
    insertReviewItem(makeItem());
    await startServer();
    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0 })
    });
    expect(res.status).toBe(401);
  });
});
