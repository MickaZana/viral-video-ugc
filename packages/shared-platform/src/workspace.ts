/**
 * Workspace Abstraction — PHASE B.2
 *
 * A workspace belongs to exactly one organization. It's the container for
 * projects, runs, clients, and resources within an org.
 *
 * For the current public application:
 *   - Every org gets one default "internal" workspace automatically
 *   - Users do NOT manually interact with workspaces
 *   - The abstraction exists to prevent future architectural surgery
 *
 * Future workspace types:
 *   - "internal" — default org workspace (current behavior)
 *   - "brand"    — dedicated brand workspace within an org
 *   - "client"   — client workspace (agency feature, DORMANT)
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export type WorkspaceType = "internal" | "brand" | "client";
export type WorkspaceStatus = "active" | "archived" | "suspended";

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  type: WorkspaceType;
  status: WorkspaceStatus;
  /** For client workspaces: the associated clientId. */
  clientId?: string;
  createdAt: string;
  updatedAt: string;
}

/** The default workspace name for organizations that haven't customized it. */
export const DEFAULT_WORKSPACE_NAME = "Default";

// ---------------------------------------------------------------------------
// Workspace store (JSON file — same pattern as existing stores)
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
        throw new Error(`Timed out waiting for workspace lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAll(dbPath: string): Workspace[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, workspaces: Workspace[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(workspaces, null, 2));
  renameSync(tmp, dbPath);
}

export interface WorkspaceStore {
  /** Returns all active workspaces for an org. */
  listByOrg(orgId: string): Workspace[];
  
  /** Returns the default workspace for an org, creating it if it doesn't exist.
   *  This is the key compatibility function: existing orgs get a default workspace
   *  transparently without any migration step. */
  getOrCreateDefault(orgId: string): Workspace;
  
  /** Gets a specific workspace, verifying org ownership. */
  getForOrg(orgId: string, workspaceId: string): Workspace | undefined;
  
  /** Creates a new workspace. */
  create(orgId: string, name: string, type: WorkspaceType, clientId?: string): Workspace;
  
  /** Archives a workspace (soft delete). */
  archive(orgId: string, workspaceId: string): boolean;
  
  /** Removes all workspaces for an org (org deletion). */
  deleteOrg(orgId: string): number;
}

export function createWorkspaceStore(dbPath: string): WorkspaceStore {
  function mutate<T>(fn: (workspaces: Workspace[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const workspaces = readAll(dbPath);
      const result = fn(workspaces);
      writeAll(dbPath, workspaces);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    listByOrg(orgId) {
      return readAll(dbPath)
        .filter((w) => w.orgId === orgId && w.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    getOrCreateDefault(orgId) {
      // First try without lock (read-only fast path for the common case)
      const existing = readAll(dbPath).find(
        (w) => w.orgId === orgId && w.type === "internal" && w.status === "active"
      );
      if (existing) return existing;

      // Create the default workspace atomically
      return mutate((workspaces) => {
        // Re-check under lock
        const found = workspaces.find(
          (w) => w.orgId === orgId && w.type === "internal" && w.status === "active"
        );
        if (found) return found;

        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: randomUUID(),
          orgId,
          name: DEFAULT_WORKSPACE_NAME,
          type: "internal",
          status: "active",
          createdAt: now,
          updatedAt: now
        };
        workspaces.push(workspace);
        return workspace;
      });
    },

    getForOrg(orgId, workspaceId) {
      return readAll(dbPath).find(
        (w) => w.orgId === orgId && w.id === workspaceId
      );
    },

    create(orgId, name, type, clientId) {
      return mutate((workspaces) => {
        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: randomUUID(),
          orgId,
          name,
          type,
          status: "active",
          clientId,
          createdAt: now,
          updatedAt: now
        };
        workspaces.push(workspace);
        return workspace;
      });
    },

    archive(orgId, workspaceId) {
      return mutate((workspaces) => {
        const ws = workspaces.find((w) => w.orgId === orgId && w.id === workspaceId);
        if (!ws) return false;
        ws.status = "archived";
        ws.updatedAt = new Date().toISOString();
        return true;
      });
    },

    deleteOrg(orgId) {
      return mutate((workspaces) => {
        const before = workspaces.length;
        for (let i = workspaces.length - 1; i >= 0; i--) {
          if (workspaces[i].orgId === orgId) workspaces.splice(i, 1);
        }
        return before - workspaces.length;
      });
    }
  };
}
