import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";
import { createPublishReceiptStore } from "./publish-receipts.js";

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
    dryRun: false,
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

/** Stubs global fetch so calls to Meta's Graph API succeed with a fixed
 *  postId, while every other fetch (including the test's own requests to
 *  the local server) passes through untouched — same pattern already
 *  proven in publish-route.test.ts, reused here so these tests exercise
 *  the real instagram_reels adapter rather than a hand-rolled fake one. */
function stubMetaGraphApi(mediaId = "media-99") {
  const realFetch = globalThis.fetch;
  const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    if (!urlStr.startsWith("https://graph.facebook.com/")) return realFetch(url, init);
    if (urlStr.endsWith("/ig-user-1/media")) return { ok: true, json: async () => ({ id: "container-1" }) } as Response;
    if (urlStr.includes("container-1?")) return { ok: true, json: async () => ({ status_code: "FINISHED" }) } as Response;
    if (urlStr.endsWith("/media_publish")) return { ok: true, json: async () => ({ id: mediaId }) } as Response;
    throw new Error(`unexpected URL in test: ${urlStr}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function creationCallCount(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => url.toString().endsWith("/ig-user-1/media")).length;
}

describe("POST /queue/:id/publish — idempotency (Phase 9)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-publish-idem-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    process.env.PUBLIC_BASE_URL = "http://localhost:9999";
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_IG_BUSINESS_ACCOUNT_ID = "ig-user-1";
    mkdirSync(join(testDir, "runs"), { recursive: true });
    writeFileSync(join(testDir, "runs", "final.mp4"), "fake video bytes");
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
    vi.unstubAllGlobals();
    vi.doUnmock("@vvugc/review-queue");
    server?.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("happy path: publish succeeds, item is updated, and a matching receipt is persisted (no regression)", async () => {
    const fetchSpy = stubMetaGraphApi();
    insertReviewItem(makeItem({ platform: "instagram_reels", videoPath: join(testDir, "runs", "final.mp4") }));
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publishedPostId).toBe("media-99");
    expect(creationCallCount(fetchSpy)).toBe(1);

    const receipts = createPublishReceiptStore(join(testDir, "runs", "publish-receipts.ndjson"));
    expect(receipts.find("item-1")).toMatchObject({ postId: "media-99", platform: "instagram_reels" });
  }, 20_000);

  it("retry after a crash between vendor success and the DB write: reads the receipt, does NOT call the vendor again", async () => {
    let shouldThrow = true;
    vi.doMock("@vvugc/review-queue", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@vvugc/review-queue")>();
      return {
        ...actual,
        // Simulates step 3 in the audit scenario: adapter.publish() already
        // returned successfully by the time this throws.
        replaceReviewItem: async (item: ReviewItem) => {
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error("simulated disk I/O crash");
          }
          return actual.replaceReviewItem(item);
        }
      };
    });

    const fetchSpy = stubMetaGraphApi();
    insertReviewItem(makeItem({ platform: "instagram_reels", videoPath: join(testDir, "runs", "final.mp4") }));
    await startServer();

    // First attempt: vendor call succeeds, receipt gets written, but the
    // item-update write is the one that's rigged to throw. It's caught by
    // the route's existing catch-all (same handler that turns adapter
    // errors into 422s) rather than reaching the outer error middleware.
    const first = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(first.status).toBe(422);
    expect(creationCallCount(fetchSpy)).toBe(1); // the vendor post already happened

    // Second attempt (the retry): item.publishedPostId is still unset
    // because the first attempt's write never landed — the L755-equivalent
    // guard alone would let this call straight through to the vendor again.
    const second = await fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.publishedPostId).toBe("media-99");
    // The real proof: still exactly one call to the vendor, not two.
    expect(creationCallCount(fetchSpy)).toBe(1);
  }, 20_000);

  it("a receipt recorded under a different orgId is ignored", () => {
    const receipts = createPublishReceiptStore(join(testDir, "runs", "publish-receipts.ndjson"));
    receipts.record({ itemId: "item-1", orgId: "org-B", postId: "someone-elses-post", platform: "tiktok", at: new Date().toISOString() });
    expect(receipts.find("item-1", "org-A")).toBeUndefined();
    // Sanity check: the same lookup with the matching org DOES find it, so
    // the negative result above is the org filter working, not a bug in find().
    expect(receipts.find("item-1", "org-B")).toMatchObject({ postId: "someone-elses-post" });
  });

  it("two concurrent publish requests for the same item: exactly one reaches the vendor, the other backs off", async () => {
    const fetchSpy = stubMetaGraphApi();
    insertReviewItem(makeItem({ platform: "instagram_reels", videoPath: join(testDir, "runs", "final.mp4") }));
    await startServer();

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER }),
      fetch(`${baseUrl}/queue/item-1/publish`, { method: "POST", headers: AUTH_HEADER })
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]); // one wins, one is told to back off — neither silently double-posts
    expect(creationCallCount(fetchSpy)).toBe(1);
  });
});
