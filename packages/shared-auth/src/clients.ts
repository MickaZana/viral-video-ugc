import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Platform } from "@vvugc/shared-schema";

export interface AgencyClient {
  id: string;
  orgId: string;
  name: string;
  niche: string;
  brandVoice: string;
  locale: string;
  platforms: Platform[];
  targetDurationSec: number;
  videoVendor: "higgsfield" | "kling" | "runway" | "pika" | "gemini" | "replicate";
  voiceVendor?: "elevenlabs" | "grok";
  cadence: "weekly" | "manual";
  active: boolean;
  nextRunAt?: string;
  lastScheduledRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgencyClientInput = Omit<AgencyClient, "id" | "orgId" | "createdAt" | "updatedAt">;

function nextWeeklyRun(from = new Date()): string {
  return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function acquireLock(dbPath: string, timeoutMs = 5000): void {
  const lockPath = `${dbPath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for clients lock at ${lockPath}`);
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function readAll(dbPath: string): AgencyClient[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, clients: AgencyClient[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(clients, null, 2));
}

export interface AgencyClientStore {
  listByOrg(orgId: string): AgencyClient[];
  getForOrg(orgId: string, id: string): AgencyClient | undefined;
  create(orgId: string, input: AgencyClientInput): AgencyClient;
  update(orgId: string, id: string, input: AgencyClientInput): AgencyClient | undefined;
  archive(orgId: string, id: string): boolean;
  /** Atomically leases due clients by advancing nextRunAt before work begins.
   * This prevents two scheduler instances from executing the same weekly run. */
  claimDue(now?: Date): AgencyClient[];
}

export function createAgencyClientStore(dbPath: string): AgencyClientStore {
  function mutate<T>(fn: (clients: AgencyClient[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const clients = readAll(dbPath);
      const result = fn(clients);
      writeAll(dbPath, clients);
      return result;
    } finally {
      rmSync(`${dbPath}.lock`, { force: true });
    }
  }

  return {
    listByOrg(orgId) {
      return readAll(dbPath).filter((client) => client.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
    },
    getForOrg(orgId, id) {
      return readAll(dbPath).find((client) => client.orgId === orgId && client.id === id);
    },
    create(orgId, input) {
      return mutate((clients) => {
        const now = new Date().toISOString();
        const client: AgencyClient = {
          id: randomUUID(),
          orgId,
          ...input,
          nextRunAt: input.cadence === "weekly" ? nextWeeklyRun(new Date(now)) : undefined,
          createdAt: now,
          updatedAt: now
        };
        clients.push(client);
        return client;
      });
    },
    update(orgId, id, input) {
      return mutate((clients) => {
        const index = clients.findIndex((client) => client.orgId === orgId && client.id === id);
        if (index === -1) return undefined;
        const cadenceChanged = clients[index].cadence !== input.cadence;
        clients[index] = {
          ...clients[index],
          ...input,
          id,
          orgId,
          nextRunAt:
            input.cadence === "weekly"
              ? cadenceChanged || !clients[index].nextRunAt
                ? nextWeeklyRun()
                : clients[index].nextRunAt
              : undefined,
          updatedAt: new Date().toISOString()
        };
        return clients[index];
      });
    },
    archive(orgId, id) {
      return mutate((clients) => {
        const client = clients.find((entry) => entry.orgId === orgId && entry.id === id);
        if (!client) return false;
        client.active = false;
        client.updatedAt = new Date().toISOString();
        return true;
      });
    },
    claimDue(now = new Date()) {
      return mutate((clients) => {
        const due = clients.filter(
          (client) =>
            client.active &&
            client.cadence === "weekly" &&
            client.nextRunAt !== undefined &&
            new Date(client.nextRunAt).getTime() <= now.getTime()
        );
        // Preserve the exact persisted due time for callers before advancing it.
        // Distributed schedulers use this stable value as their shared
        // idempotency boundary; their local `now` timestamps may differ.
        const claimed = due.map((client) => ({ ...client }));
        for (const client of due) {
          client.lastScheduledRunAt = now.toISOString();
          client.nextRunAt = nextWeeklyRun(now);
          client.updatedAt = now.toISOString();
        }
        return claimed;
      });
    }
  };
}
