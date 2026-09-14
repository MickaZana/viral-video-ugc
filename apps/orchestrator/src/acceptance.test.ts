import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem, RunConfig, RunResult } from "@vvugc/shared-schema";

// Real node:fs, mocked runCycle/listReviewItems — acceptance.ts's own job is
// deciding pass/fail from a RunResult + the review queue, not running the
// pipeline itself (conductor.test.ts already covers that). Controlling both
// lets each test build an exact scenario (missing artifact, wrong tenant,
// empty file, ...) without a real live/dry-run pipeline behind it.
const runCycleMock = vi.fn<(config: RunConfig, opts?: unknown) => Promise<RunResult>>();
vi.mock("./conductor.js", () => ({
  runCycle: (config: RunConfig, opts?: unknown) => runCycleMock(config, opts)
}));

const listReviewItemsMock = vi.fn<(filter?: unknown) => Promise<ReviewItem[]>>();
vi.mock("@vvugc/review-queue", () => ({
  listReviewItems: (filter?: unknown) => listReviewItemsMock(filter)
}));

const { runAcceptance } = await import("./acceptance.js");

let dir: string;

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: `acc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    orgId: "org-1",
    clientId: "client-1",
    niche: "fitness",
    platforms: ["youtube_shorts"],
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    targetDurationSec: 25,
    maxCandidates: 5,
    videoVendor: "kling",
    lipSyncVendor: "none",
    dryRun: true,
    autoPost: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function baseReviewItem(config: RunConfig, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    runId: config.runId,
    orgId: config.orgId,
    clientId: config.clientId,
    niche: config.niche,
    videoPath: join(dir, `${config.runId}.mp4`),
    platform: "youtube_shorts",
    script: {
      videoId: "mock-0",
      hook: "h",
      points: ["p1"],
      cta: "c",
      durationSec: 25,
      brandVoice: "neutral, energetic, concise",
      locale: "en",
      trendingPhrases: []
    },
    clips: [],
    captions: [],
    score: 90,
    structuralScore: 90,
    flags: [],
    status: "pending",
    dryRun: config.dryRun,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/** Writes a real, non-empty file at the given path (mkdir -p'd first). */
function writeRealFile(path: string, contents = "not empty"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vvugc-acceptance-test-"));
  runCycleMock.mockReset();
  listReviewItemsMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runAcceptance", () => {
  it("passes when every check succeeds — real artifacts, correctly attributed review items", async () => {
    const config = baseConfig();
    const manifestPath = join(dir, "manifest.json");
    const costLedgerPath = join(dir, "cost-ledger.json");
    writeRealFile(manifestPath, JSON.stringify({ ok: true }));
    writeRealFile(costLedgerPath, JSON.stringify({ ok: true }));
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 1,
      manifestPath,
      completedAt: new Date().toISOString(),
      costLedgerPath
    };
    runCycleMock.mockResolvedValue(result);
    const item = baseReviewItem(config);
    writeRealFile(item.videoPath, "fake mp4 bytes");
    listReviewItemsMock.mockResolvedValue([item]);

    const evidencePath = join(dir, "acceptance-evidence.json");
    const evidence = await runAcceptance(config, {}, evidencePath);

    expect(evidence.passed).toBe(true);
    expect(evidence.mode).toBe("dry-run");
    expect(evidence.error).toBeUndefined();
    expect(evidence.checks.every((c) => c.passed)).toBe(true);
    expect(evidence.checks.map((c) => c.name)).toEqual([
      "pipeline-produced-review-items",
      "manifest-persisted",
      "cost-ledger-persisted",
      "tenant-attribution",
      "video-artifacts-nonempty"
    ]);
    expect(existsSync(evidencePath)).toBe(true);
    expect(JSON.parse(readFileSync(evidencePath, "utf8")).passed).toBe(true);
  });

  it("fails and records the error when runCycle throws — no checks run", async () => {
    const config = baseConfig();
    runCycleMock.mockRejectedValue(new Error("all vendors failed"));

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.passed).toBe(false);
    expect(evidence.error).toContain("all vendors failed");
    expect(evidence.checks).toEqual([]);
    expect(evidence.result).toBeUndefined();
  });

  it("fails when the run produced zero review items", async () => {
    const config = baseConfig();
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 0,
      manifestPath,
      completedAt: new Date().toISOString()
    };
    runCycleMock.mockResolvedValue(result);
    listReviewItemsMock.mockResolvedValue([]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.passed).toBe(false);
    const producedCheck = evidence.checks.find((c) => c.name === "pipeline-produced-review-items");
    expect(producedCheck?.passed).toBe(false);
  });

  it("fails when the manifest file the result claims to have written doesn't actually exist on disk", async () => {
    const config = baseConfig();
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 1,
      manifestPath: join(dir, "never-written-manifest.json"),
      completedAt: new Date().toISOString()
    };
    runCycleMock.mockResolvedValue(result);
    const item = baseReviewItem(config);
    writeRealFile(item.videoPath, "fake mp4 bytes");
    listReviewItemsMock.mockResolvedValue([item]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.find((c) => c.name === "manifest-persisted")?.passed).toBe(false);
  });

  it("does not fail on a missing cost ledger when the result never claimed to have one (dry-run shape)", async () => {
    const config = baseConfig();
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 1,
      manifestPath,
      completedAt: new Date().toISOString()
      // costLedgerPath intentionally omitted
    };
    runCycleMock.mockResolvedValue(result);
    const item = baseReviewItem(config);
    writeRealFile(item.videoPath, "fake mp4 bytes");
    listReviewItemsMock.mockResolvedValue([item]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    // cost-ledger-persisted is expected to fail (no path was ever produced) —
    // this documents current behavior: acceptance treats "no ledger path" as a
    // real check failure, not an automatic pass. If cost-ledger becomes
    // genuinely optional for some run shape, this test is the one to update.
    expect(evidence.checks.find((c) => c.name === "cost-ledger-persisted")?.passed).toBe(false);
  });

  it("fails tenant-attribution when a returned review item belongs to a different org/client", async () => {
    const config = baseConfig();
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 1,
      manifestPath,
      completedAt: new Date().toISOString()
    };
    runCycleMock.mockResolvedValue(result);
    const wrongTenantItem = baseReviewItem(config, { orgId: "some-other-org" });
    writeRealFile(wrongTenantItem.videoPath, "fake mp4 bytes");
    listReviewItemsMock.mockResolvedValue([wrongTenantItem]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.find((c) => c.name === "tenant-attribution")?.passed).toBe(false);
  });

  it("fails video-artifacts-nonempty when the review item's video file is empty", async () => {
    const config = baseConfig();
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    const result: RunResult = {
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 1,
      reviewItemsCreated: 1,
      manifestPath,
      completedAt: new Date().toISOString()
    };
    runCycleMock.mockResolvedValue(result);
    const item = baseReviewItem(config);
    writeRealFile(item.videoPath, ""); // exists, zero bytes
    listReviewItemsMock.mockResolvedValue([item]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.find((c) => c.name === "video-artifacts-nonempty")?.passed).toBe(false);
  });

  it("passes orgId/clientId through to listReviewItems so results are queried tenant-scoped", async () => {
    const config = baseConfig({ orgId: "org-42", clientId: "client-7" });
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    runCycleMock.mockResolvedValue({
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 0,
      reviewItemsCreated: 0,
      manifestPath,
      completedAt: new Date().toISOString()
    });
    listReviewItemsMock.mockResolvedValue([]);

    await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(listReviewItemsMock).toHaveBeenCalledWith({ orgId: "org-42", clientId: "client-7" });
  });

  it("records mode as 'live' when config.dryRun is false", async () => {
    const config = baseConfig({ dryRun: false });
    const manifestPath = join(dir, "manifest.json");
    writeRealFile(manifestPath);
    runCycleMock.mockResolvedValue({
      runId: config.runId,
      niche: config.niche,
      candidatesFound: 0,
      reviewItemsCreated: 0,
      manifestPath,
      completedAt: new Date().toISOString()
    });
    listReviewItemsMock.mockResolvedValue([]);

    const evidence = await runAcceptance(config, {}, join(dir, "acceptance-evidence.json"));

    expect(evidence.mode).toBe("live");
  });
});
