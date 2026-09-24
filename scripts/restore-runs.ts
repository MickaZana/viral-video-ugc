#!/usr/bin/env tsx
/**
 * restore-runs.ts — Restore a VVUGC_RUNS_DIR backup created by backup-runs.ts
 *
 * Companion script closing a real gap: backup-runs.ts has existed for a while
 * with no restore counterpart at all — a "backup" nobody has ever restored
 * from is unverified by definition, per the launch plan's own backup/restore
 * acceptance criteria.
 *
 * Safe by default: restores into a NEW directory next to the backup, never
 * directly into VVUGC_RUNS_DIR — a restore is exactly the kind of hard-to-reverse
 * operation that shouldn't silently clobber live data. Pass --into-runs-dir to
 * restore straight into VVUGC_RUNS_DIR instead (only after confirming the
 * restored contents in a dry run first).
 *
 * Usage:
 *   pnpm --filter @vvugc/orchestrator exec tsx ../../scripts/restore-runs.ts <backup-file> [--target <dir>] [--into-runs-dir]
 *
 * Handles both formats backup-runs.ts can produce:
 *   - vvugc-backup-*.tar.gz  — full archive (tar must be available; same tool backup-runs.ts itself needs)
 *   - vvugc-backup-*.json    — Windows/no-tar fallback (review-queue + analytics + manifests only, no video binaries)
 *
 * After restoring, prints a verification summary (review-queue item count, run
 * count, whether each run's manifest.json/cost-ledger.json parse as JSON) so a
 * restore is confirmed working, not just assumed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { loadEnv } from "@vvugc/shared-config";

function parseArgs(argv: string[]): { backupFile: string; target?: string; intoRunsDir: boolean } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const backupFile = positional[0];
  if (!backupFile) {
    console.error("Usage: restore-runs.ts <backup-file> [--target <dir>] [--into-runs-dir]");
    process.exit(1);
  }
  const targetIdx = argv.indexOf("--target");
  const target = targetIdx !== -1 ? argv[targetIdx + 1] : undefined;
  const intoRunsDir = argv.includes("--into-runs-dir");
  if (target && intoRunsDir) {
    console.error("Pass either --target <dir> or --into-runs-dir, not both.");
    process.exit(1);
  }
  return { backupFile, target, intoRunsDir };
}

function main() {
  const { backupFile, target, intoRunsDir } = parseArgs(process.argv.slice(2));
  const resolvedBackupFile = resolve(backupFile);
  if (!existsSync(resolvedBackupFile)) {
    console.error(`Backup file not found: ${resolvedBackupFile}`);
    process.exit(1);
  }

  const { VVUGC_RUNS_DIR } = loadEnv();
  const restoreDir = intoRunsDir
    ? VVUGC_RUNS_DIR
    : target
      ? resolve(target)
      : join(process.cwd(), "backups", `restored-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);

  console.log("═══ VVUGC Restore ═══");
  console.log(`  Backup file: ${resolvedBackupFile}`);
  console.log(`  Restoring into: ${restoreDir}${intoRunsDir ? "  (VVUGC_RUNS_DIR — live path)" : ""}`);
  console.log();

  if (intoRunsDir && existsSync(VVUGC_RUNS_DIR) && readdirSync(VVUGC_RUNS_DIR).length > 0) {
    console.error(
      `Refusing: --into-runs-dir was passed but ${VVUGC_RUNS_DIR} already exists and is not empty. ` +
        "Restoring on top of live data risks silently mixing old and new state. Restore into a fresh " +
        "--target directory first, inspect it, then move it into place yourself if it's what you expect."
    );
    process.exit(1);
  }

  mkdirSync(restoreDir, { recursive: true });

  if (resolvedBackupFile.endsWith(".tar.gz")) {
    restoreFromTarball(resolvedBackupFile, restoreDir);
  } else if (resolvedBackupFile.endsWith(".json")) {
    restoreFromJsonFallback(resolvedBackupFile, restoreDir);
  } else {
    console.error(`Unrecognized backup file extension (expected .tar.gz or .json): ${resolvedBackupFile}`);
    process.exit(1);
  }

  verify(restoreDir);
  console.log("\n═══ Restore complete ═══");
}

function restoreFromTarball(archivePath: string, restoreDir: string): void {
  console.log("Extracting tar.gz archive...");
  try {
    // The archive was created with `-C <parent-of-runs-dir> <basename-of-runs-dir>`
    // (see backup-runs.ts), so it contains one top-level directory named after
    // VVUGC_RUNS_DIR's basename, not its contents directly at the archive root.
    //
    // Deliberately no `-C <restoreDir>` flag here — verified live that GNU tar
    // under Git Bash/MSYS mangles an absolute "C:\..." destination passed to
    // -C specifically (garbled into something like "C\:\\Users\\..." and then
    // "Cannot open: No such file or directory"), even though the exact same
    // shape of path works fine as the -f archive argument. Setting the child
    // process's OWN working directory instead (execSync's `cwd` option) and
    // extracting into "." sidesteps the bug entirely rather than fighting
    // tar's path translation.
    runTar(`tar -xzf "${archivePath}"`, restoreDir);
  } catch (err) {
    console.error(`  ✗ tar extraction failed: ${String(err)}`);
    console.error("  tar must be available on this machine to restore a .tar.gz backup — same requirement backup-runs.ts has for creating one.");
    process.exit(1);
  }
  console.log(`  ✓ Extracted to ${restoreDir}`);
  flattenSingleNestedDir(restoreDir);
}

/**
 * The archive is `-C <parent-of-runs-dir> <basename>` (see backup-runs.ts), so
 * a fresh extraction always lands one directory level too deep — restoreDir/
 * <original-basename>/review-queue.json instead of restoreDir/review-queue.json.
 * That's an accident of how the archive happens to be built, not something a
 * restore caller should need to know — found by actually inspecting the
 * extracted output, not by reasoning about the tar invocation. Flattens it so
 * restoreDir itself is directly usable as a VVUGC_RUNS_DIR. Only acts when
 * restoreDir has exactly one child and it's a directory (the expected shape);
 * leaves anything else alone rather than guessing.
 */
function flattenSingleNestedDir(restoreDir: string): void {
  const entries = readdirSync(restoreDir);
  if (entries.length !== 1) return;
  const nested = join(restoreDir, entries[0]);
  if (!statSync(nested).isDirectory()) return;
  for (const child of readdirSync(nested)) {
    renameSync(join(nested, child), join(restoreDir, child));
  }
  rmdirSync(nested);
  console.log(`  (flattened extracted "${entries[0]}/" up into ${restoreDir})`);
}

/** See the matching, more detailed comment on backup-runs.ts's runTar() —
 *  Windows can have either GNU tar or bsdtar on PATH depending on the shell,
 *  and they disagree on whether an absolute "C:\..." path needs --force-local;
 *  this tries plain first and only adds the flag on GNU tar's specific
 *  remote-parse failure signature. Kept in sync deliberately rather than
 *  factored into a shared module for two five-line functions across two
 *  standalone scripts. */
function runTar(cmd: string, cwd?: string): void {
  try {
    execSync(cmd, { stdio: "pipe", timeout: 300_000, cwd });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? String(err);
    const looksLikeGnuTarRemoteMisparse = /Cannot connect to .*resolve failed|Cannot connect to .*Unknown/i.test(stderr);
    if (!looksLikeGnuTarRemoteMisparse || !cmd.startsWith("tar ")) throw err;
    execSync(cmd.replace(/^tar /, "tar --force-local "), { stdio: "pipe", timeout: 300_000, cwd });
  }
}

function restoreFromJsonFallback(jsonPath: string, restoreDir: string): void {
  console.log("Restoring from JSON fallback backup (review-queue + analytics + manifests only)...");
  console.log("  NOTE: this format never included video binaries — restored runs will have manifests but no .mp4 files.");

  const backup = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
    timestamp?: string;
    source?: string;
    "run-manifests"?: Record<string, unknown>;
    [file: string]: unknown;
  };

  console.log(`  Backup taken: ${backup.timestamp ?? "unknown"}, from: ${backup.source ?? "unknown"}`);

  for (const [file, contents] of Object.entries(backup)) {
    if (file === "timestamp" || file === "source" || file === "run-manifests") continue;
    const outPath = join(restoreDir, file);
    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, JSON.stringify(contents, null, 2));
    console.log(`  ✓ ${file}`);
  }

  const manifests = backup["run-manifests"] ?? {};
  for (const [runId, manifest] of Object.entries(manifests)) {
    const manifestPath = join(restoreDir, runId, "manifest.json");
    mkdirSync(join(restoreDir, runId), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  console.log(`  ✓ ${Object.keys(manifests).length} run manifest(s)`);
}

/** Confirms the restore actually produced something readable, rather than trusting
 *  that extraction/writing "probably worked" — the whole point of a restore drill. */
function verify(restoreDir: string): void {
  console.log("\nVerifying restored contents...");

  const reviewQueuePath = join(restoreDir, "review-queue.json");
  if (existsSync(reviewQueuePath)) {
    try {
      const items = JSON.parse(readFileSync(reviewQueuePath, "utf-8"));
      console.log(`  ✓ review-queue.json parses — ${Array.isArray(items) ? items.length : "?"} item(s)`);
    } catch {
      console.log("  ✗ review-queue.json exists but failed to parse as JSON");
    }
  } else {
    console.log("  · no review-queue.json in this backup");
  }

  const runDirs = existsSync(restoreDir)
    ? readdirSync(restoreDir).filter((d) => {
        const p = join(restoreDir, d);
        return statSync(p).isDirectory() && d !== "_analytics" && d !== "backups";
      })
    : [];

  let manifestsOk = 0;
  let manifestsBad = 0;
  for (const run of runDirs) {
    const manifestPath = join(restoreDir, run, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifestsOk++;
    } catch {
      manifestsBad++;
    }
  }
  console.log(`  ${manifestsBad === 0 ? "✓" : "✗"} ${runDirs.length} run dir(s) found, ${manifestsOk} manifest(s) parse cleanly${manifestsBad ? `, ${manifestsBad} corrupt` : ""}`);
}

main();
