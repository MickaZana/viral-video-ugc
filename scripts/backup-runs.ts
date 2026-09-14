#!/usr/bin/env tsx
/**
 * backup-runs.ts — Automated backup for VVUGC_RUNS_DIR
 *
 * Creates a timestamped compressed archive of the runs directory,
 * including all video assets, run manifests, analytics state, and
 * the review-queue JSON database.
 *
 * Usage:
 *   pnpm --filter @vvugc/orchestrator exec tsx ../../scripts/backup-runs.ts
 *
 * Scheduling (recommended: daily at 2 AM):
 *   0 2 * * * cd /path/to/vvugc && pnpm --filter @vvugc/orchestrator exec tsx ../../scripts/backup-runs.ts
 *
 * Options (env vars):
 *   BACKUP_DIR        — Where to store backups (default: ./backups/)
 *   BACKUP_RETAIN_DAYS — How many days of backups to keep (default: 7)
 *   BACKUP_EXCLUDE_VIDEOS — Set "true" to skip .mp4 files (smaller backups)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { loadEnv } from "@vvugc/shared-config";

const { VVUGC_RUNS_DIR } = loadEnv();
const BACKUP_DIR = process.env.BACKUP_DIR || join(process.cwd(), "backups");
const RETAIN_DAYS = parseInt(process.env.BACKUP_RETAIN_DAYS || "7", 10);
const EXCLUDE_VIDEOS = process.env.BACKUP_EXCLUDE_VIDEOS === "true";

/**
 * Runs a tar command, self-adapting to whichever tar is on PATH — found to
 * genuinely matter on Windows, which can have EITHER of two different tars
 * depending on the shell: Git Bash puts GNU tar first, while a plain
 * cmd.exe/PowerShell session picks up Windows' own bundled bsdtar
 * (System32\tar.exe, libarchive-based). They disagree on this exact case:
 * GNU tar misreads an absolute "C:\..." path's colon as remote host syntax
 * ("host:path", its legacy tar-over-rsh feature) and fails with "Cannot
 * connect to C: resolve failed" unless given --force-local; bsdtar has no
 * such remote-path heuristic at all and, when actually tested, rejects
 * --force-local outright as an unsupported option. Neither environment
 * variable nor a version string reliably tells you which one you have ahead
 * of time — so this tries the plain command first (correct for bsdtar and for
 * GNU tar on a non-colon path) and only retries with --force-local when the
 * failure is specifically GNU tar's remote-parse error, rather than assuming
 * one tar flavor and breaking the other. Verified against both, on this
 * machine, not just reasoned about.
 */
function runTar(cmd: string): void {
  try {
    execSync(cmd, { stdio: "pipe", timeout: 300_000 }); // 5-min timeout
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? String(err);
    const looksLikeGnuTarRemoteMisparse = /Cannot connect to .*resolve failed|Cannot connect to .*Unknown/i.test(stderr);
    if (!looksLikeGnuTarRemoteMisparse || !cmd.startsWith("tar ")) throw err;
    execSync(cmd.replace(/^tar /, "tar --force-local "), { stdio: "pipe", timeout: 300_000 });
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log("═══ VVUGC Backup ═══");
  console.log(`  Source: ${VVUGC_RUNS_DIR}`);
  console.log(`  Destination: ${BACKUP_DIR}`);
  console.log(`  Retain: ${RETAIN_DAYS} days`);
  console.log(`  Exclude videos: ${EXCLUDE_VIDEOS}`);
  console.log();

  mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveName = `vvugc-backup-${timestamp}.tar.gz`;
  const archivePath = join(BACKUP_DIR, archiveName);

  const excludeFlags = EXCLUDE_VIDEOS ? '--exclude="*.mp4" --exclude="*.webm"' : "";
  const tarCmd = `tar -czf "${archivePath}" ${excludeFlags} -C "${join(VVUGC_RUNS_DIR, "..")}" "${basename(VVUGC_RUNS_DIR)}"`;

  console.log(`Creating archive: ${archiveName}`);
  try {
    runTar(tarCmd);
    const size = statSync(archivePath).size;
    console.log(`  ✓ Archive created: ${(size / 1024 / 1024).toFixed(1)} MB`);
  } catch (err) {
    // tar might not be available at all — fall back to a manifest-only backup
    console.error(`  ✗ tar failed: ${String(err)}`);
    console.log("  Attempting manifest-only backup (JSON files)...");
    fallbackJsonBackup(archivePath.replace(".tar.gz", ".json"));
    return;
  }

  // Prune old backups
  pruneOldBackups();

  console.log("\n═══ Backup complete ═══");
}

function fallbackJsonBackup(outPath: string) {
  // On Windows where tar may not exist, just copy the critical JSON files
  const criticalFiles = [
    "review-queue.json",
    "_analytics/hook-registry.json",
    "_analytics/growth-memory.json",
    "_analytics/performance-records.json",
  ];

  const backup: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    source: VVUGC_RUNS_DIR,
  };

  for (const file of criticalFiles) {
    const path = join(VVUGC_RUNS_DIR, file);
    if (existsSync(path)) {
      try {
        backup[file] = JSON.parse(readFileSync(path, "utf-8"));
        console.log(`  ✓ ${file}`);
      } catch {
        console.log(`  ✗ ${file} (parse error)`);
      }
    }
  }

  // Also capture run manifests (lightweight metadata, no video binaries)
  const runs = readdirSync(VVUGC_RUNS_DIR).filter((d) => {
    const p = join(VVUGC_RUNS_DIR, d);
    return statSync(p).isDirectory() && d !== "_analytics" && d !== "backups";
  });

  const manifests: Record<string, unknown> = {};
  for (const run of runs) {
    const manifestPath = join(VVUGC_RUNS_DIR, run, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        manifests[run] = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch { /* skip corrupt manifests */ }
    }
  }
  backup["run-manifests"] = manifests;

  writeFileSync(outPath, JSON.stringify(backup, null, 2));
  const size = statSync(outPath).size;
  console.log(`  ✓ JSON backup created: ${(size / 1024).toFixed(1)} KB (${runs.length} run manifests)`);
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith("vvugc-backup-"));

  let pruned = 0;
  for (const file of files) {
    const path = join(BACKUP_DIR, file);
    const stat = statSync(path);
    if (stat.mtimeMs < cutoff) {
      unlinkSync(path);
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`  Pruned ${pruned} backup(s) older than ${RETAIN_DAYS} days`);
  }
}

main();
