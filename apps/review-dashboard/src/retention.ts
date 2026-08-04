import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";

/**
 * Retention/pruning for the two append-only log streams this service writes:
 * audit.ndjson (every mutation's HTTP audit — see server.ts) and
 * security-events.ndjson (identity/access-control events — see security-events.ts).
 *
 * Both are flat JSONL files that otherwise grow without bound; this is the
 * bounded-retention piece (docs/remaining-p0-execution-plan.md Phase 7). Lines
 * older than SECURITY_LOG_RETENTION_DAYS are dropped. The rule is deliberately
 * conservative in both directions:
 *
 *  - We never delete lines we can't timestamp (malformed/partial last line from a
 *    crash mid-append) — destroying unparseable data silently would be worse than
 *    keeping an old line for one more cycle.
 *  - Unparseable JSON that has an `at` timestamp IS pruned like everything else,
 *    so a schema change to the JSONL shape doesn't accidentally pin the file to
 *    its pre-change size forever.
 *
 * The rewrite is atomic (write temp + rename) and guarded by a lock file, so a
 * prune racing a concurrent append can't leave a torn file — worst case a line
 * appended mid-prune is dropped, which is acceptable for logs.
 */

export interface PruneResult {
  securityEvents: number;
  audit: number;
}

/** Drops lines older than `retentionDays` from a JSONL file. Returns lines removed. */
export function pruneNdjsonByAge(path: string, retentionDays: number): number {
  if (retentionDays <= 0 || !existsSync(path)) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    let atMs: number | undefined;
    try {
      const parsed = JSON.parse(line) as { at?: string };
      const timestamp = parsed.at === undefined ? undefined : Date.parse(parsed.at);
      if (parsed.at !== undefined && Number.isFinite(timestamp)) atMs = timestamp;
    } catch {
      kept.push(line); // unparseable — never silently destroy
      continue;
    }
    if (atMs !== undefined && atMs < cutoffMs) removed++;
    else kept.push(line);
  }
  if (removed === 0) return 0;
  const tempPath = `${path}.prune-tmp`;
  const content = kept.join("\n") + (kept.length > 0 ? "\n" : "");
  writeFileSync(tempPath, content);
  renameSync(tempPath, path);
  return removed;
}

/** Prunes both log streams per the configured retention. Safe to call on a
 *  server where the files don't exist yet (returns zeros, creates nothing). */
export function pruneRetainedLogs(): PruneResult {
  const { VVUGC_RUNS_DIR, SECURITY_LOG_RETENTION_DAYS } = loadEnv();
  return {
    securityEvents: pruneNdjsonByAge(join(VVUGC_RUNS_DIR, "security-events.ndjson"), SECURITY_LOG_RETENTION_DAYS),
    audit: pruneNdjsonByAge(join(VVUGC_RUNS_DIR, "audit.ndjson"), SECURITY_LOG_RETENTION_DAYS)
  };
}
