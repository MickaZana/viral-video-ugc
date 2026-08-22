import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import type { Platform } from "@vvugc/shared-schema";

/**
 * "Tracked creators" are derived from real discovery candidates persisted in each
 * run's manifest.json under the `chosen` array. The backend does not store social
 * handles/follower counts (the discovery adapters only surface a candidate's
 * platform, title, url, publishedAt and metrics) — so rather than fabricate a
 * @handle and follower number, we surface the real source videos that were
 * discovered and rewritten, grouped by their real platform + source id, with the
 * real engagement metrics each run recorded.
 *
 * This is a read-only connection for the control panel's Creator Spy tab. It is
 * registered behind the same operator Basic Auth gate as /queue and /runs, so it
 * never exposes data to an unauthenticated caller.
 */

interface ManifestCandidate {
  id: string;
  platform: Platform;
  title?: string;
  url?: string;
  publishedAt?: string;
  niche?: string;
  metrics?: { views?: number; likes?: number; comments?: number; velocityScore?: number };
}

interface RunManifest {
  config?: { niche?: string; platforms?: Platform[] };
  chosen?: ManifestCandidate[];
}

export interface TrackedCreator {
  sourceId: string;
  label: string;
  platform: Platform;
  niche: string;
  url?: string;
  views: number;
  likes: number;
  velocityScore: number;
  publishedAt?: string;
  runs: string[];
}

/**
 * Lists tracked creators derived from run manifests. When orgId is provided,
 * only creators from runs belonging to that organization are included
 * (tenant isolation). When omitted (operator context), all creators are returned.
 */
export function listTrackedCreators(orgId?: string): TrackedCreator[] {
  const { VVUGC_RUNS_DIR } = loadEnv();
  if (!existsSync(VVUGC_RUNS_DIR)) return [];

  const byKey = new Map<string, TrackedCreator>();

  const add = (key: string, c: TrackedCreator) => {
    const existing = byKey.get(key);
    if (existing) {
      existing.views = Math.max(existing.views, c.views);
      existing.likes = Math.max(existing.likes, c.likes);
      existing.velocityScore = Math.max(existing.velocityScore, c.velocityScore);
      if (!existing.url && c.url) existing.url = c.url;
      if (!existing.publishedAt && c.publishedAt) existing.publishedAt = c.publishedAt;
      existing.runs = [...new Set([...existing.runs, ...c.runs])];
      return;
    }
    byKey.set(key, c);
  };

  for (const entry of readdirSync(VVUGC_RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(VVUGC_RUNS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: RunManifest & { config?: { accountId?: string } };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue; // malformed manifest — skip this run
    }

    // Tenant isolation: skip runs that don't belong to the requesting org
    if (orgId && manifest.config?.accountId !== orgId) continue;

    const runNiche = manifest.config?.niche ?? "unknown";
    for (const c of manifest.chosen ?? []) {
      const views = c.metrics?.views ?? 0;
      const likes = c.metrics?.likes ?? 0;
      const velocity = c.metrics?.velocityScore ?? 0;
      add(`${c.platform}:${c.id}`, {
        sourceId: c.id,
        label: c.title || c.id,
        platform: c.platform,
        niche: c.niche ?? runNiche,
        url: c.url,
        views,
        likes,
        velocityScore: velocity,
        publishedAt: c.publishedAt,
        runs: [entry.name]
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.views - a.views);
}
