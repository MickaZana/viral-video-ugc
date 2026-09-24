/**
 * Webhook Architecture — PHASE D (Section 23)
 *
 * Future webhook support for organizations.
 * DORMANT: not exposed publicly, gated by VVUGC_WEBHOOKS_ENABLED.
 *
 * Webhook processing must be idempotent.
 * Deliveries have: delivery ID, event ID, attempt count, status, timestamp.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Webhook event types (future)
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "review_item.created"
  | "review_item.approved"
  | "review_item.rejected"
  | "publish.completed"
  | "publish.failed";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type WebhookEndpointStatus = "active" | "disabled" | "failing";

export interface WebhookEndpoint {
  id: string;
  orgId: string;
  url: string;
  /** HMAC signing secret for payload verification. */
  secret: string;
  /** Which events this endpoint subscribes to. */
  events: WebhookEventType[];
  status: WebhookEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  orgId: string;
  eventType: WebhookEventType;
  eventId: string;
  /** Delivery attempt number (1-based). */
  attempt: number;
  /** HTTP status code from the endpoint, or null if connection failed. */
  responseStatus: number | null;
  status: "success" | "failed" | "pending";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store
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
        throw new Error(`Timed out waiting for webhooks lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

interface WebhookStoreData {
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
}

function readAll(dbPath: string): WebhookStoreData {
  if (!existsSync(dbPath)) return { endpoints: [], deliveries: [] };
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, data: WebhookStoreData): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, dbPath);
}

export interface WebhookEndpointStore {
  /** Creates a new webhook endpoint with a generated signing secret. */
  create(orgId: string, url: string, events: WebhookEventType[]): WebhookEndpoint;
  
  /** Lists endpoints for an org. */
  listByOrg(orgId: string): Omit<WebhookEndpoint, "secret">[];
  
  /** Gets an endpoint, verifying org ownership. */
  getForOrg(orgId: string, endpointId: string): WebhookEndpoint | undefined;
  
  /** Updates endpoint URL/events. */
  update(orgId: string, endpointId: string, url?: string, events?: WebhookEventType[]): WebhookEndpoint | undefined;
  
  /** Disables an endpoint. */
  disable(orgId: string, endpointId: string): boolean;
  
  /** Records a delivery attempt. */
  recordDelivery(endpointId: string, orgId: string, eventType: WebhookEventType, eventId: string, attempt: number, responseStatus: number | null, status: "success" | "failed"): WebhookDelivery;
  
  /** Gets recent deliveries for an endpoint. */
  getDeliveries(orgId: string, endpointId: string, limit?: number): WebhookDelivery[];
  
  /** Removes all endpoints and deliveries for an org (org deletion). */
  deleteOrg(orgId: string): number;
}

export function createWebhookEndpointStore(dbPath: string): WebhookEndpointStore {
  function mutate<T>(fn: (data: WebhookStoreData) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const data = readAll(dbPath);
      const result = fn(data);
      writeAll(dbPath, data);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    create(orgId, url, events) {
      return mutate((data) => {
        const now = new Date().toISOString();
        const endpoint: WebhookEndpoint = {
          id: randomUUID(),
          orgId,
          url,
          secret: `whsec_${randomBytes(24).toString("base64url")}`,
          events,
          status: "active",
          createdAt: now,
          updatedAt: now
        };
        data.endpoints.push(endpoint);
        return endpoint;
      });
    },

    listByOrg(orgId) {
      return readAll(dbPath).endpoints
        .filter((e) => e.orgId === orgId)
        .map(({ secret: _, ...rest }) => rest);
    },

    getForOrg(orgId, endpointId) {
      return readAll(dbPath).endpoints.find(
        (e) => e.orgId === orgId && e.id === endpointId
      );
    },

    update(orgId, endpointId, url, events) {
      return mutate((data) => {
        const ep = data.endpoints.find((e) => e.orgId === orgId && e.id === endpointId);
        if (!ep) return undefined;
        if (url) ep.url = url;
        if (events) ep.events = events;
        ep.updatedAt = new Date().toISOString();
        return ep;
      });
    },

    disable(orgId, endpointId) {
      return mutate((data) => {
        const ep = data.endpoints.find((e) => e.orgId === orgId && e.id === endpointId);
        if (!ep) return false;
        ep.status = "disabled";
        ep.updatedAt = new Date().toISOString();
        return true;
      });
    },

    recordDelivery(endpointId, orgId, eventType, eventId, attempt, responseStatus, status) {
      return mutate((data) => {
        const delivery: WebhookDelivery = {
          id: randomUUID(),
          endpointId,
          orgId,
          eventType,
          eventId,
          attempt,
          responseStatus,
          status,
          createdAt: new Date().toISOString()
        };
        data.deliveries.push(delivery);
        // Keep only last 1000 deliveries to prevent unbounded growth
        if (data.deliveries.length > 1000) {
          data.deliveries = data.deliveries.slice(-1000);
        }
        return delivery;
      });
    },

    getDeliveries(orgId, endpointId, limit = 50) {
      return readAll(dbPath).deliveries
        .filter((d) => d.orgId === orgId && d.endpointId === endpointId)
        .slice(-limit)
        .reverse();
    },

    deleteOrg(orgId) {
      return mutate((data) => {
        const before = data.endpoints.length;
        data.endpoints = data.endpoints.filter((e) => e.orgId !== orgId);
        data.deliveries = data.deliveries.filter((d) => d.orgId !== orgId);
        return before - data.endpoints.length;
      });
    }
  };
}
