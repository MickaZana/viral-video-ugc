import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/review-queue";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const AUTH_HEADER = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64") };

let testDir: string;
let runsDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: join(runsDir, "final.mp4"),
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
    ...overrides,
    dryRun: overrides.dryRun ?? false
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

describe("GET /media/:itemId (History tab video playback)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-media-route-test-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
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

  it("requires authentication — no Basic Auth, no session → 401", async () => {
    insertReviewItem(makeItem());
    await startServer();
    const res = await fetch(`${baseUrl}/media/item-1`);
    expect(res.status).toBe(401);
  });

  it("serves the item's real video bytes as video/mp4", async () => {
    const videoPath = join(runsDir, "final.mp4");
    writeFileSync(videoPath, "these are the real video bytes");
    insertReviewItem(makeItem({ videoPath }));
    await startServer();

    const res = await fetch(`${baseUrl}/media/item-1`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength("these are the real video bytes")));
    expect(await res.text()).toBe("these are the real video bytes");
  });

  it("returns 404 for an unknown item id", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/media/does-not-exist`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  it("returns 404 for an item with an empty video path", async () => {
    insertReviewItem(makeItem({ videoPath: "" }));
    await startServer();
    const res = await fetch(`${baseUrl}/media/item-1`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });

  it("refuses to serve a video outside VVUGC_RUNS_DIR (traversal guard, indistinguishable 404)", async () => {
    const secretPath = join(testDir, "secret.mp4");
    writeFileSync(secretPath, "not supposed to be servable");
    insertReviewItem(makeItem({ videoPath: secretPath }));
    await startServer();

    const res = await fetch(`${baseUrl}/media/item-1`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  it("refuses a path that walks up through '..' to escape the runs dir", async () => {
    writeFileSync(join(testDir, "secret.mp4"), "not supposed to be servable");
    insertReviewItem(makeItem({ videoPath: join(runsDir, "..", "secret.mp4") }));
    await startServer();

    const res = await fetch(`${baseUrl}/media/item-1`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the item's video file is missing on disk", async () => {
    insertReviewItem(makeItem({ videoPath: join(runsDir, "missing.mp4") }));
    await startServer();
    const res = await fetch(`${baseUrl}/media/item-1`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });
});
