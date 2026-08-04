import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneNdjsonByAge, pruneRetainedLogs } from "./retention.js";

let testDir: string;
let runsDir: string;

function writeNdjson(name: string, lines: Array<Record<string, unknown> | string>) {
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n") + "\n";
  writeFileSync(join(runsDir, name), content);
}

describe("retention pruning of audit/security logs", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-retention-test-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.VVUGC_RUNS_DIR = runsDir;
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("drops lines older than the retention window and keeps everything newer", () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const path = join(runsDir, "audit.ndjson");
    writeNdjson("audit.ndjson", [{ at: old }, { at: fresh }]);

    const removed = pruneNdjsonByAge(path, 90);
    expect(removed).toBe(1);
    const kept = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]).at).toBe(fresh);
  });

  it("never deletes unparseable lines (crash-truncated tail lines are preserved)", () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    writeNdjson("audit.ndjson", [{ at: old }, '{ "at": "torn-line']);

    const removed = pruneNdjsonByAge(join(runsDir, "audit.ndjson"), 90);
    expect(removed).toBe(1);
    const kept = readFileSync(join(runsDir, "audit.ndjson"), "utf-8");
    expect(kept).toContain('{ "at": "torn-line');
  });

  it("pruneRetainedLogs prunes both streams honoring SECURITY_LOG_RETENTION_DAYS", () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    writeNdjson("audit.ndjson", [{ at: old }, { at: fresh }]);
    writeNdjson("security-events.ndjson", [{ at: old, type: "login.succeeded" }, { at: fresh, type: "login.succeeded" }]);
    process.env.SECURITY_LOG_RETENTION_DAYS = "7";

    const result = pruneRetainedLogs();
    expect(result.audit).toBe(1);
    expect(result.securityEvents).toBe(1);

    const auditLines = readFileSync(join(runsDir, "audit.ndjson"), "utf-8").split("\n").filter((l) => l.trim());
    expect(auditLines).toHaveLength(1);
    expect(JSON.parse(auditLines[0]).at).toBe(fresh);
    const eventLines = readFileSync(join(runsDir, "security-events.ndjson"), "utf-8").split("\n").filter((l) => l.trim());
    expect(eventLines).toHaveLength(1);
    expect(JSON.parse(eventLines[0]).at).toBe(fresh);
  });

  it("is a no-op on missing files", () => {
    expect(pruneNdjsonByAge(join(runsDir, "does-not-exist.ndjson"), 90)).toBe(0);
    expect(pruneRetainedLogs()).toEqual({ securityEvents: 0, audit: 0 });
  });
});
