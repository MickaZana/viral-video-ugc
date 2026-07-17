import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateUsage } from "./usage.js";

/** Writes the real on-disk shape conductor.ts produces — see usage.ts's RunManifestJson
 *  comment for why this isn't a flat RunResult. Mirrors how a real run actually looks on
 *  disk, not a guessed-at shape — this fixture caught a real accountId-location bug once. */
function writeRun(
  runsDir: string,
  runId: string,
  opts: {
    accountId?: string;
    createdAt?: string;
    reviewItemsCreated?: number;
    ledger?: { totalUsd: number; totalsByVendor: Record<string, number> };
  }
): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  if (opts.ledger) {
    writeFileSync(join(runDir, "cost-ledger.json"), JSON.stringify(opts.ledger));
  }
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      config: {
        accountId: opts.accountId,
        niche: "fitness",
        createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z"
      },
      candidatesFound: 1,
      reviewItemsCreated: opts.reviewItemsCreated ?? 1,
      candidatesFailed: 0,
      platformsFailed: 0,
      failures: []
    })
  );
}

describe("aggregateUsage", () => {
  let runsDir: string;

  afterEach(() => {
    if (runsDir && existsSync(runsDir)) rmSync(runsDir, { recursive: true, force: true });
  });

  it("returns zeroed usage for an account with no runs, or a nonexistent runs dir", () => {
    runsDir = mkdtempSync(join(tmpdir(), "usage-"));
    const usage = aggregateUsage("account-1", runsDir);
    expect(usage).toEqual({
      accountId: "account-1",
      totalUsd: 0,
      totalRuns: 0,
      totalReviewItemsCreated: 0,
      totalsByVendor: {},
      runs: []
    });

    expect(aggregateUsage("account-1", join(runsDir, "does-not-exist"))).toEqual(usage);
  });

  it("sums cost-ledger totals only for runs belonging to the given account", () => {
    runsDir = mkdtempSync(join(tmpdir(), "usage-"));
    writeRun(runsDir, "run-a", {
      accountId: "account-1",
      reviewItemsCreated: 2,
      ledger: { totalUsd: 1.5, totalsByVendor: { higgsfield: 1.0, anthropic: 0.5 } }
    });
    writeRun(runsDir, "run-b", {
      accountId: "account-2", // different account — must not count toward account-1's usage
      ledger: { totalUsd: 99, totalsByVendor: { higgsfield: 99 } }
    });
    writeRun(runsDir, "run-c", {
      accountId: "account-1",
      reviewItemsCreated: 1,
      ledger: { totalUsd: 0.25, totalsByVendor: { anthropic: 0.25 } }
    });

    const usage = aggregateUsage("account-1", runsDir);
    expect(usage.totalRuns).toBe(2);
    expect(usage.totalReviewItemsCreated).toBe(3);
    expect(usage.totalUsd).toBeCloseTo(1.75, 6);
    expect(usage.totalsByVendor.higgsfield).toBeCloseTo(1.0, 6);
    expect(usage.totalsByVendor.anthropic).toBeCloseTo(0.75, 6);
    expect(usage.runs.map((r) => r.runId).sort()).toEqual(["run-a", "run-c"]);
  });

  it("skips runs with no accountId (untagged CLI/dry-run usage), attributing them to nobody", () => {
    runsDir = mkdtempSync(join(tmpdir(), "usage-"));
    writeRun(runsDir, "run-untagged", { ledger: { totalUsd: 5, totalsByVendor: { kling: 5 } } });

    const usage = aggregateUsage("account-1", runsDir);
    expect(usage.totalRuns).toBe(0);
    expect(usage.totalUsd).toBe(0);
  });

  it("tolerates a malformed manifest or missing cost-ledger without failing the whole aggregation", () => {
    runsDir = mkdtempSync(join(tmpdir(), "usage-"));
    mkdirSync(join(runsDir, "run-broken"), { recursive: true });
    writeFileSync(join(runsDir, "run-broken", "manifest.json"), "{not valid json");

    writeRun(runsDir, "run-no-ledger", { accountId: "account-1" });
    writeRun(runsDir, "run-good", {
      accountId: "account-1",
      ledger: { totalUsd: 2, totalsByVendor: { grok: 2 } }
    });

    const usage = aggregateUsage("account-1", runsDir);
    expect(usage.totalRuns).toBe(2); // run-broken skipped, both valid runs counted
    expect(usage.totalUsd).toBeCloseTo(2, 6); // run-no-ledger has no ledger file, contributes 0 to totalUsd
  });

  it("ignores non-directory entries in runsDir (accounts.json, sessions.json, lockfiles, etc.)", () => {
    runsDir = mkdtempSync(join(tmpdir(), "usage-"));
    writeFileSync(join(runsDir, "accounts.json"), "[]");
    writeFileSync(join(runsDir, "sessions.json"), "[]");
    writeRun(runsDir, "run-a", { accountId: "account-1", ledger: { totalUsd: 1, totalsByVendor: {} } });

    const usage = aggregateUsage("account-1", runsDir);
    expect(usage.totalRuns).toBe(1);
  });
});
