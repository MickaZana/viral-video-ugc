/**
 * Agency/Client Extended Model — PHASE C.1, C.2, C.3
 *
 * Extends the existing AgencyClient with workspace relationship and
 * future client-level isolation support.
 *
 * THIS FEATURE IS DORMANT.
 * - The public frontend MUST NOT display it
 * - Gated by VVUGC_AGENCY_CLIENTS_ENABLED=true
 * - The existing AgencyClient in shared-auth continues to work as-is
 * - This extension layer adds workspace binding and status management
 *
 * The existing AgencyClient model in packages/shared-auth/src/clients.ts
 * already handles the core CRUD. This module adds:
 *   - workspaceId linkage (client → workspace relationship)
 *   - contactEmail for future client portal access
 *   - metadata for extensibility
 *   - archival/suspension status beyond simple active/inactive
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Extended Client model (wraps existing AgencyClient)
// ---------------------------------------------------------------------------

export type ClientStatus = "active" | "archived" | "suspended" | "onboarding";

/**
 * Extended client metadata — stored alongside the existing AgencyClient.
 * This is NOT a replacement; it's an additive layer.
 */
export interface AgencyClientExt {
  /** Matches the existing AgencyClient.id */
  clientId: string;
  orgId: string;
  /** Workspace this client is assigned to (future isolation boundary). */
  workspaceId?: string;
  /** Client's primary contact email (for future portal invitations). */
  contactEmail?: string;
  /** Extended status beyond the existing active/inactive boolean. */
  status: ClientStatus;
  /** Free-form metadata for future extensibility. */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

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
        throw new Error(`Timed out waiting for agency-client-ext lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAll(dbPath: string): AgencyClientExt[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, records: AgencyClientExt[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, dbPath);
}

export interface AgencyClientExtStore {
  /** Gets extended info for a client. Returns undefined if no extended record exists yet. */
  get(orgId: string, clientId: string): AgencyClientExt | undefined;
  
  /** Creates or updates extended client metadata. */
  upsert(orgId: string, clientId: string, data: Partial<Omit<AgencyClientExt, "clientId" | "orgId" | "createdAt" | "updatedAt">>): AgencyClientExt;
  
  /** Lists all extended client records for an org. */
  listByOrg(orgId: string): AgencyClientExt[];
  
  /** Lists clients assigned to a specific workspace. */
  listByWorkspace(orgId: string, workspaceId: string): AgencyClientExt[];
  
  /** Removes all records for an org (org deletion). */
  deleteOrg(orgId: string): number;
}

export function createAgencyClientExtStore(dbPath: string): AgencyClientExtStore {
  function mutate<T>(fn: (records: AgencyClientExt[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const records = readAll(dbPath);
      const result = fn(records);
      writeAll(dbPath, records);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    get(orgId, clientId) {
      return readAll(dbPath).find((r) => r.orgId === orgId && r.clientId === clientId);
    },

    upsert(orgId, clientId, data) {
      return mutate((records) => {
        const now = new Date().toISOString();
        const idx = records.findIndex((r) => r.orgId === orgId && r.clientId === clientId);
        
        if (idx === -1) {
          const record: AgencyClientExt = {
            clientId,
            orgId,
            status: "active",
            ...data,
            createdAt: now,
            updatedAt: now
          };
          records.push(record);
          return record;
        }

        records[idx] = {
          ...records[idx],
          ...data,
          clientId,
          orgId,
          updatedAt: now
        };
        return records[idx];
      });
    },

    listByOrg(orgId) {
      return readAll(dbPath).filter((r) => r.orgId === orgId);
    },

    listByWorkspace(orgId, workspaceId) {
      return readAll(dbPath).filter(
        (r) => r.orgId === orgId && r.workspaceId === workspaceId
      );
    },

    deleteOrg(orgId) {
      return mutate((records) => {
        const before = records.length;
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i].orgId === orgId) records.splice(i, 1);
        }
        return before - records.length;
      });
    }
  };
}
