import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function startServer() {
  const { app } = await import("./server.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

describe("review-dashboard HTTP API", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-review-dashboard-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("GET /queue returns items, optionally filtered by status", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));

    // Fresh import per test-server instance keeps this isolated from the module-level `app`
    // singleton across test files, and confirms importing server.ts has no side effects
    // (no accidental app.listen()) now that the isMain guard is in place.
    await startServer();

    const all = await (await fetch(`${baseUrl}/queue`)).json();
    expect(all).toHaveLength(2);

    const approvedOnly = await (await fetch(`${baseUrl}/queue?status=approved`)).json();
    expect(approvedOnly).toHaveLength(1);
    expect(approvedOnly[0].id).toBe("b");
  });

  it("GET /queue filters by niche and platform query params", async () => {
    insertReviewItem(makeItem({ id: "a", niche: "fitness", platform: "tiktok" }));
    insertReviewItem(makeItem({ id: "b", niche: "finance", platform: "tiktok" }));
    await startServer();

    const filtered = await (await fetch(`${baseUrl}/queue?niche=fitness&platform=tiktok`)).json();
    expect(filtered.map((i: ReviewItem) => i.id)).toEqual(["a"]);
  });

  it("POST /queue/:id/approve updates status and persists it", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    await startServer();

    const approveRes = await fetch(`${baseUrl}/queue/a/approve`, { method: "POST" });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("approved");

    const fetched = await (await fetch(`${baseUrl}/queue/a`)).json();
    expect(fetched.status).toBe("approved");
  });

  it("POST /queue/:id/reject on an unknown id returns 404", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/queue/does-not-exist/reject`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /queue/bulk/approve updates every id in the batch", async () => {
    insertReviewItem(makeItem({ id: "a" }));
    insertReviewItem(makeItem({ id: "b" }));
    insertReviewItem(makeItem({ id: "c" }));
    await startServer();

    const res = await fetch(`${baseUrl}/queue/bulk/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "c"] })
    });
    const body = await res.json();
    expect(body.updated.sort()).toEqual(["a", "c"]);

    const items = await (await fetch(`${baseUrl}/queue`)).json();
    expect(items.find((i: ReviewItem) => i.id === "a").status).toBe("approved");
    expect(items.find((i: ReviewItem) => i.id === "b").status).toBe("pending");
  });

  it("GET /stats aggregates counts by status and total estimated spend across runs", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));
    insertReviewItem(makeItem({ id: "c", status: "rejected" }));

    const runDir = join(testDir, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ config: { niche: "fitness" } }));
    writeFileSync(join(runDir, "cost-ledger.json"), JSON.stringify({ totalUsd: 2.5 }));

    await startServer();
    const stats = await (await fetch(`${baseUrl}/stats`)).json();
    expect(stats).toEqual({ pending: 1, approved: 1, rejected: 1, estimatedCostUsd: 2.5 });
  });

  it("GET /runs returns run history read from the runs directory", async () => {
    const runDir = join(testDir, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({ config: { niche: "fitness", platforms: ["tiktok"], createdAt: "2026-01-01T00:00:00.000Z" }, candidatesFound: 2, reviewItemsCreated: 2 })
    );
    await startServer();

    const runs = await (await fetch(`${baseUrl}/runs`)).json();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run-1", niche: "fitness", candidatesFound: 2 });
  });

  it("GET /tokens.css serves the shared design tokens stylesheet", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/tokens.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("--accent");
  });

  it("GET / renders the dashboard shell", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("Review Queue");
    expect(html).toContain('id="queue-list"');
  });
});
