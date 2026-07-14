import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewItem } from "@vvugc/shared-schema";
import { getReviewItem, insertReviewItem, listReviewItems, setReviewItemStatus } from "./db.js";

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
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("review-queue db", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-review-queue-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns an empty list before any item has been inserted, without creating a file", () => {
    expect(listReviewItems()).toEqual([]);
    expect(existsSync(process.env.VVUGC_DB_PATH!)).toBe(false);
  });

  it("insertReviewItem creates the file and persists valid JSON", () => {
    insertReviewItem(makeItem());
    expect(existsSync(process.env.VVUGC_DB_PATH!)).toBe(true);
    const raw = JSON.parse(readFileSync(process.env.VVUGC_DB_PATH!, "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe("item-1");
  });

  it("listReviewItems round-trips an inserted item", () => {
    insertReviewItem(makeItem());
    const items = listReviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "item-1", status: "pending" });
  });

  it("listReviewItems sorts newest first by createdAt", () => {
    insertReviewItem(makeItem({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }));
    insertReviewItem(makeItem({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" }));
    const items = listReviewItems();
    expect(items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("listReviewItems filters by status when given one", () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));
    expect(listReviewItems("approved").map((i) => i.id)).toEqual(["b"]);
    expect(listReviewItems("pending").map((i) => i.id)).toEqual(["a"]);
  });

  it("getReviewItem finds by id and returns undefined for an unknown id", () => {
    insertReviewItem(makeItem({ id: "findme" }));
    expect(getReviewItem("findme")?.id).toBe("findme");
    expect(getReviewItem("nope")).toBeUndefined();
  });

  it("setReviewItemStatus updates the status of the matching item only", () => {
    insertReviewItem(makeItem({ id: "a" }));
    insertReviewItem(makeItem({ id: "b" }));
    setReviewItemStatus("a", "approved");
    expect(getReviewItem("a")?.status).toBe("approved");
    expect(getReviewItem("b")?.status).toBe("pending");
  });

  it("setReviewItemStatus is a silent no-op for an unknown id", () => {
    insertReviewItem(makeItem({ id: "a" }));
    expect(() => setReviewItemStatus("unknown-id", "approved")).not.toThrow();
    expect(getReviewItem("a")?.status).toBe("pending");
  });
});
