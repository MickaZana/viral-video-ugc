import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";

export interface SecurityEvent {
  /** Machine-readable event type, e.g. "login.succeeded", "password.changed", "member.role_changed". */
  type: string;
  /** The account performing the action (undefined for e.g. a failed pre-account login attempt). */
  actorAccountId?: string;
  /** The org the event belongs to (a failed login has no org until the email resolves). */
  orgId?: string;
  /** The acting account's email — kept on the event so audit trails are readable without a join. */
  email?: string;
  /** Client IP when known. */
  ip?: string;
  /** For actions targeting another member (role change, removal). */
  targetAccountId?: string;
  /** Free-form extra context (e.g. "role: reviewer -> editor", "reason: password changed"). */
  detail?: string;
}

/**
 * Appends a structured, account-tied security event to runs/security-events.ndjson.
 *
 * This is deliberately separate from the HTTP request audit in server.ts (audit.ndjson —
 * "who hit which endpoint") — security events are the smaller, higher-signal set of
 * identity- and access-control changes ("who logged in / changed a password / was
 * re-roled / removed") that an incident response or a GDPR access-log request would
 * actually care about, keyed by account and org rather than by request.
 *
 * Writes are best-effort: logging must never take down a request because the runs
 * directory is unavailable.
 */
export function writeSecurityEvent(event: SecurityEvent): void {
  try {
    const { VVUGC_RUNS_DIR } = loadEnv();
    mkdirSync(VVUGC_RUNS_DIR, { recursive: true });
    appendFileSync(
      join(VVUGC_RUNS_DIR, "security-events.ndjson"),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"
    );
  } catch {
    /* logging failure must not break the request that triggered it */
  }
}

export interface SecurityEventFilter {
  /** Match events where this account was the actor OR the target. */
  accountId?: string;
  /** Match events belonging to this org. */
  orgId?: string;
  /** Most recent N matching events, newest first. Defaults to all matches. */
  limit?: number;
}

/**
 * Reads back security events for the account page's audit view. Best-effort like
 * writes: a missing or unreadable file simply returns an empty list rather than
 * failing the request that asked for it.
 */
export function listSecurityEvents(filter: SecurityEventFilter = {}): SecurityEvent[] {
  try {
    const { VVUGC_RUNS_DIR } = loadEnv();
    const path = join(VVUGC_RUNS_DIR, "security-events.ndjson");
    if (!existsSync(path)) return [];
    const events = readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as SecurityEvent & { at: string };
        } catch {
          return undefined;
        }
      })
      .filter((event): event is SecurityEvent & { at: string } => event !== undefined);

    const matches = events.filter((event) => {
      if (filter.accountId && event.actorAccountId !== filter.accountId && event.targetAccountId !== filter.accountId) {
        return false;
      }
      if (filter.orgId && event.orgId !== filter.orgId) return false;
      return true;
    });
    // File is append-only, so later lines are newer.
    const newestFirst = matches.reverse();
    return typeof filter.limit === "number" ? newestFirst.slice(0, filter.limit) : newestFirst;
  } catch {
    return [];
  }
}

/**
 * Rewrites the event file without the given org's events (org owner's account
 * deletion). Best-effort like every other operation in this module — a missing
 * file is a no-op, and a locked/unreadable file fails quietly rather than
 * breaking the deletion that triggered it. Returns how many events were removed.
 */
export function deleteSecurityEventsForOrg(orgId: string): number {
  return deleteSecurityEvents((event) => event.orgId !== orgId);
}

/** Rewrites the event file without events tied to a specific account (either as
 *  actor or target) — used when a member deletes their own account so their
 *  audit trail doesn't outlive them under a deleted accountId. */
export function deleteSecurityEventsForAccount(accountId: string): number {
  return deleteSecurityEvents(
    (event) => event.actorAccountId !== accountId && event.targetAccountId !== accountId
  );
}

function deleteSecurityEvents(keep: (event: SecurityEvent & { at: string }) => boolean): number {
  try {
    const { VVUGC_RUNS_DIR } = loadEnv();
    const path = join(VVUGC_RUNS_DIR, "security-events.ndjson");
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim().length > 0);
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      let event: SecurityEvent & { at: string } | undefined;
      try {
        event = JSON.parse(line) as SecurityEvent & { at: string };
      } catch {
        kept.push(line); // unparseable lines are never silently destroyed
        continue;
      }
      if (keep(event)) kept.push(line);
      else removed++;
    }
    if (removed > 0) {
      writeFileSync(path, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
    }
    return removed;
  } catch {
    return 0;
  }
}
