import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform } from "@vvugc/shared-schema";

export interface AccountSettings {
  accountId: string;
  niche: string;
  brandVoice: string;
  platforms: Platform[];
  targetDurationSec: number;
  videoVendor: "higgsfield" | "kling" | "runway" | "pika" | "gemini" | "replicate";
  voiceVendor?: "elevenlabs" | "grok";
  /** "weekly" maps to this account being included in the scheduled cron run (see
   *  infra/cron); "manual" means the account only runs when a user clicks "Run now". */
  cadence: "weekly" | "manual";
  updatedAt: string;
}

export type AccountSettingsInput = Omit<AccountSettings, "accountId" | "updatedAt">;

const DEFAULT_SETTINGS: AccountSettingsInput = {
  niche: "",
  brandVoice: "neutral, energetic, concise",
  platforms: ["youtube_shorts"],
  targetDurationSec: 25,
  videoVendor: "higgsfield",
  cadence: "manual"
};

/** Same exclusive-lockfile pattern as accounts.ts / sessions.ts. */
function acquireLock(dbPath: string, timeoutMs = 5000): void {
  const lockPath = `${dbPath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for settings lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAllUnlocked(dbPath: string): AccountSettings[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, settings: AccountSettings[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(settings, null, 2));
}

export interface SettingsStore {
  /** Returns the account's saved settings, or built-in defaults if never saved — a brand-new
   *  account can always read something sensible without an explicit "create settings" step. */
  get(accountId: string): AccountSettings;
  /** Full replace, not a partial patch — the settings form always submits the complete shape. */
  upsert(accountId: string, input: AccountSettingsInput): AccountSettings;
}

export function createSettingsStore(dbPath: string): SettingsStore {
  return {
    get(accountId) {
      const existing = readAllUnlocked(dbPath).find((s) => s.accountId === accountId);
      if (existing) return existing;
      return { accountId, ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() };
    },

    upsert(accountId, input) {
      const settings: AccountSettings = { accountId, ...input, updatedAt: new Date().toISOString() };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        const all = readAllUnlocked(dbPath);
        const idx = all.findIndex((s) => s.accountId === accountId);
        if (idx === -1) all.push(settings);
        else all[idx] = settings;
        writeAllUnlocked(dbPath, all);
      } finally {
        releaseLock(dbPath);
      }
      return settings;
    }
  };
}
