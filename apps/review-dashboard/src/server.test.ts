import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

let testDir: string;
let server: Server;
let baseUrl: string;

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: "/tmp/x.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "hi",
      points: ["p1"],
      cta: "cta",
      durationSec: 25,
      brandVoice: "energetic",
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("review-dashboard HTTP API", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-review-dashboard-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("GET /queue returns items, optionally filtered by status", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));

    // Fresh import per test-server instance keeps this isolated from the module-level `app`
    // singleton across test files, and confirms importing server.ts has no side effects
    // (no accidental app.listen()) now that the isMain guard is in place.
    const { app } = await import("./server.js");
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;

    const all = await (await fetch(`${baseUrl}/queue`)).json();
    expect(all).toHaveLength(2);

    const approvedOnly = await (await fetch(`${baseUrl}/queue?status=approved`)).json();
    expect(approvedOnly).toHaveLength(1);
    expect(approvedOnly[0].id).toBe("b");

    server.close();
  });

  it("POST /queue/:id/approve updates status and persists it", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));

    const { app } = await import("./server.js");
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;

    const approveRes = await fetch(`${baseUrl}/queue/a/approve`, { method: "POST" });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("approved");

    const fetched = await (await fetch(`${baseUrl}/queue/a`)).json();
    expect(fetched.status).toBe("approved");

    server.close();
  });

  it("POST /queue/:id/reject on an unknown id returns 404", async () => {
    const { app } = await import("./server.js");
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;

    const res = await fetch(`${baseUrl}/queue/does-not-exist/reject`, { method: "POST" });
    expect(res.status).toBe(404);

    server.close();
  });
});
