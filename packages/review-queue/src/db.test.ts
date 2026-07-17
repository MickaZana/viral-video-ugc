import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewItem } from "@vvugc/shared-schema";
import {
  getReviewItem,
  insertReviewItem,
  listReviewItems,
  replaceReviewItem,
  setReviewItemStatus,
  setReviewItemsStatus
} from "./db.js";

let testDir: string;

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
      locale: "en",
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// This suite exercises db.ts against its default backend (the JSON-file store,
// selected whenever DATABASE_URL is unset — see json-store.ts). The Postgres
// backend (postgres-store.ts) has its own suite in postgres-store.test.ts.
describe("review-queue db (JSON-file backend)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-review-queue-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns an empty list before any item has been inserted, without creating a file", async () => {
    expect(await listReviewItems()).toEqual([]);
    expect(existsSync(process.env.VVUGC_DB_PATH!)).toBe(false);
  });

  it("insertReviewItem creates the file and persists valid JSON", async () => {
    await insertReviewItem(makeItem());
    expect(existsSync(process.env.VVUGC_DB_PATH!)).toBe(true);
    const raw = JSON.parse(readFileSync(process.env.VVUGC_DB_PATH!, "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe("item-1");
  });

  it("listReviewItems round-trips an inserted item", async () => {
    await insertReviewItem(makeItem());
    const items = await listReviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "item-1", status: "pending" });
  });

  it("listReviewItems sorts newest first by createdAt", async () => {
    await insertReviewItem(makeItem({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await insertReviewItem(makeItem({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" }));
    const items = await listReviewItems();
    expect(items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("listReviewItems filters by status when given one", async () => {
    await insertReviewItem(makeItem({ id: "a", status: "pending" }));
    await insertReviewItem(makeItem({ id: "b", status: "approved" }));
    expect((await listReviewItems("approved")).map((i) => i.id)).toEqual(["b"]);
    expect((await listReviewItems("pending")).map((i) => i.id)).toEqual(["a"]);
  });

  it("getReviewItem finds by id and returns undefined for an unknown id", async () => {
    await insertReviewItem(makeItem({ id: "findme" }));
    expect((await getReviewItem("findme"))?.id).toBe("findme");
    expect(await getReviewItem("nope")).toBeUndefined();
  });

  it("setReviewItemStatus updates the status of the matching item only", async () => {
    await insertReviewItem(makeItem({ id: "a" }));
    await insertReviewItem(makeItem({ id: "b" }));
    await setReviewItemStatus("a", "approved");
    expect((await getReviewItem("a"))?.status).toBe("approved");
    expect((await getReviewItem("b"))?.status).toBe("pending");
  });

  it("setReviewItemStatus is a silent no-op for an unknown id", async () => {
    await insertReviewItem(makeItem({ id: "a" }));
    await expect(setReviewItemStatus("unknown-id", "approved")).resolves.not.toThrow();
    expect((await getReviewItem("a"))?.status).toBe("pending");
  });

  it("survives concurrent inserts without losing writes (lockfile serializes them)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => insertReviewItem(makeItem({ id: `c${i}` }))));
    expect(await listReviewItems()).toHaveLength(20);
    const ids = new Set((await listReviewItems()).map((i) => i.id));
    expect(ids.size).toBe(20);
  });

  it("does not leave a stale .lock file behind after a write", async () => {
    await insertReviewItem(makeItem());
    expect(existsSync(`${process.env.VVUGC_DB_PATH!}.lock`)).toBe(false);
  });

  it("listReviewItems filters by niche and platform via a filter object", async () => {
    await insertReviewItem(makeItem({ id: "a", niche: "fitness", platform: "tiktok" }));
    await insertReviewItem(makeItem({ id: "b", niche: "finance", platform: "tiktok" }));
    await insertReviewItem(makeItem({ id: "c", niche: "fitness", platform: "youtube_shorts" }));

    expect((await listReviewItems({ niche: "fitness" })).map((i) => i.id).sort()).toEqual(["a", "c"]);
    expect((await listReviewItems({ platform: "tiktok" })).map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect((await listReviewItems({ niche: "fitness", platform: "tiktok" })).map((i) => i.id)).toEqual(["a"]);
  });

  it("listReviewItems still accepts a bare status string (legacy call shape)", async () => {
    await insertReviewItem(makeItem({ id: "a", status: "pending" }));
    await insertReviewItem(makeItem({ id: "b", status: "approved" }));
    expect((await listReviewItems("approved")).map((i) => i.id)).toEqual(["b"]);
  });

  it("setReviewItemsStatus updates only the matching ids and returns the ones actually updated", async () => {
    await insertReviewItem(makeItem({ id: "a" }));
    await insertReviewItem(makeItem({ id: "b" }));
    await insertReviewItem(makeItem({ id: "c" }));
    const updated = await setReviewItemsStatus(["a", "c", "nonexistent"], "approved");
    expect(updated.sort()).toEqual(["a", "c"]);
    expect((await getReviewItem("a"))?.status).toBe("approved");
    expect((await getReviewItem("b"))?.status).toBe("pending");
    expect((await getReviewItem("c"))?.status).toBe("approved");
  });

  it("replaceReviewItem overwrites the stored item in place, leaving other items untouched", async () => {
    await insertReviewItem(makeItem({ id: "a", videoPath: "/tmp/old.mp4", score: 50 }));
    await insertReviewItem(makeItem({ id: "b", videoPath: "/tmp/other.mp4" }));

    const regenerated = makeItem({ id: "a", videoPath: "/tmp/new.mp4", score: 90, status: "pending" });
    await replaceReviewItem(regenerated);

    expect(await getReviewItem("a")).toEqual(regenerated);
    expect((await getReviewItem("b"))?.videoPath).toBe("/tmp/other.mp4");
  });

  it("replaceReviewItem is a no-op for an id that doesn't exist", async () => {
    await insertReviewItem(makeItem({ id: "a" }));
    await replaceReviewItem(makeItem({ id: "does-not-exist", videoPath: "/tmp/x.mp4" }));
    expect((await listReviewItems()).map((i) => i.id)).toEqual(["a"]);
  });
});
