import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReviewItem } from "@vvugc/shared-schema";
import { createPostgresStore } from "./postgres-store.js";

// Runs against a real Postgres — set locally (e.g. via `docker run -p 5432:5432
// postgres:16-alpine`) or in CI (.github/workflows/ci.yml provisions a service
// container and sets this). Skips instead of failing when unset, so this suite
// doesn't block environments without Postgres available — the JSON-store suite
// (db.test.ts) is the one that must always run.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

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

describe.skipIf(!TEST_DATABASE_URL)("review-queue postgres-store", () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const store = createPostgresStore(pool);

  beforeAll(async () => {
    // Triggers the store's lazy CREATE TABLE IF NOT EXISTS once. ensureSchema()
    // memoizes its readiness promise for the store's lifetime, so a DROP TABLE
    // per test (instead of TRUNCATE) would desync that memoized promise from
    // reality — the store would believe the schema still exists and every
    // insert after the first test would fail with "relation does not exist".
    await store.listReviewItems();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE review_items");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns an empty list before any item has been inserted", async () => {
    expect(await store.listReviewItems()).toEqual([]);
  });

  it("insertReviewItem persists a retrievable item", async () => {
    await store.insertReviewItem(makeItem());
    const items = await store.listReviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "item-1", status: "pending" });
  });

  it("listReviewItems sorts newest first by createdAt", async () => {
    await store.insertReviewItem(makeItem({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.insertReviewItem(makeItem({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" }));
    const items = await store.listReviewItems();
    expect(items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("listReviewItems filters by status, niche, and platform", async () => {
    await store.insertReviewItem(makeItem({ id: "a", niche: "fitness", platform: "tiktok", status: "pending" }));
    await store.insertReviewItem(makeItem({ id: "b", niche: "finance", platform: "tiktok", status: "approved" }));
    await store.insertReviewItem(makeItem({ id: "c", niche: "fitness", platform: "youtube_shorts", status: "pending" }));

    expect((await store.listReviewItems({ status: "approved" })).map((i) => i.id)).toEqual(["b"]);
    expect((await store.listReviewItems({ niche: "fitness" })).map((i) => i.id).sort()).toEqual(["a", "c"]);
    expect((await store.listReviewItems({ platform: "tiktok" })).map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect((await store.listReviewItems({ niche: "fitness", platform: "tiktok" })).map((i) => i.id)).toEqual(["a"]);
  });

  it("getReviewItem finds by id and returns undefined for an unknown id", async () => {
    await store.insertReviewItem(makeItem({ id: "findme" }));
    expect((await store.getReviewItem("findme"))?.id).toBe("findme");
    expect(await store.getReviewItem("nope")).toBeUndefined();
  });

  it("setReviewItemStatus updates only the matching item, in both the column and the JSONB payload", async () => {
    await store.insertReviewItem(makeItem({ id: "a" }));
    await store.insertReviewItem(makeItem({ id: "b" }));
    await store.setReviewItemStatus("a", "approved");

    expect((await store.getReviewItem("a"))?.status).toBe("approved");
    expect((await store.getReviewItem("b"))?.status).toBe("pending");
    // The denormalized `status` column drives listReviewItems' WHERE clause —
    // if only the JSONB payload were updated, this filter would miss it.
    expect((await store.listReviewItems({ status: "approved" })).map((i) => i.id)).toEqual(["a"]);
  });

  it("setReviewItemsStatus updates only the matching ids and returns the ones actually updated", async () => {
    await store.insertReviewItem(makeItem({ id: "a" }));
    await store.insertReviewItem(makeItem({ id: "b" }));
    await store.insertReviewItem(makeItem({ id: "c" }));
    const updated = await store.setReviewItemsStatus(["a", "c", "nonexistent"], "rejected");

    expect(updated.sort()).toEqual(["a", "c"]);
    expect((await store.getReviewItem("a"))?.status).toBe("rejected");
    expect((await store.getReviewItem("b"))?.status).toBe("pending");
    expect((await store.getReviewItem("c"))?.status).toBe("rejected");
  });

  it("setReviewItemsStatus on an empty id list is a no-op that returns an empty array", async () => {
    await store.insertReviewItem(makeItem({ id: "a" }));
    expect(await store.setReviewItemsStatus([], "approved")).toEqual([]);
    expect((await store.getReviewItem("a"))?.status).toBe("pending");
  });

  it("round-trips the full nested script payload through JSONB, not just the top-level fields", async () => {
    await store.insertReviewItem(
      makeItem({ id: "a", script: { videoId: "v9", hook: "hook text", points: ["one", "two"], cta: "cta text", durationSec: 40, brandVoice: "chill", locale: "en", trendingPhrases: ["x"] } })
    );
    const item = await store.getReviewItem("a");
    expect(item?.script).toEqual({
      videoId: "v9",
      hook: "hook text",
      points: ["one", "two"],
      cta: "cta text",
      durationSec: 40,
      brandVoice: "chill",
      locale: "en",
      trendingPhrases: ["x"]
    });
  });

  it("replaceReviewItem overwrites both the status column and the JSONB payload, leaving other rows untouched", async () => {
    await store.insertReviewItem(makeItem({ id: "a", videoPath: "/tmp/old.mp4", score: 50, status: "pending" }));
    await store.insertReviewItem(makeItem({ id: "b", videoPath: "/tmp/other.mp4" }));

    const regenerated = makeItem({ id: "a", videoPath: "/tmp/new.mp4", score: 90, status: "pending" });
    await store.replaceReviewItem(regenerated);

    expect(await store.getReviewItem("a")).toEqual(regenerated);
    expect((await store.getReviewItem("b"))?.videoPath).toBe("/tmp/other.mp4");
  });

  it("survives concurrent inserts without losing writes (real transactions, no app-level lock needed)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.insertReviewItem(makeItem({ id: `c${i}` }))));
    const items = await store.listReviewItems();
    expect(items).toHaveLength(20);
    expect(new Set(items.map((i) => i.id)).size).toBe(20);
  });
});
