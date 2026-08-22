/**
 * Atom C — Higgsfield MCP Session Adapter
 *
 * Worker-owned MCP client/session interface. The request path enqueues work,
 * it never owns the MCP session. This module manages:
 * - Connection initialization
 * - Health state tracking
 * - Automatic reconnection with backoff
 * - Availability detection before spending credits
 * - Testable via a fake MCP caller injection
 */

import type { McpToolCaller } from "@vvugc/mcp-video-gen";

export type McpSessionState = "disconnected" | "connecting" | "connected" | "unhealthy";

export interface McpSessionConfig {
  /** How to actually call the MCP server — injected by the environment. */
  connect: () => Promise<McpToolCaller>;
  /** Max time to wait for a connection attempt (ms). Default: 30_000 */
  connectTimeoutMs?: number;
  /** How long between health checks when idle (ms). Default: 30_000 */
  healthCheckIntervalMs?: number;
  /** Max consecutive failures before marking unhealthy. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Backoff base for reconnection attempts (ms). Default: 2_000 */
  reconnectBaseMs?: number;
  /** Max reconnection attempts before giving up. Default: 5 */
  maxReconnectAttempts?: number;
}

export interface McpSession {
  /** Current connection state. */
  state: McpSessionState;
  /** Get a working callMcpTool, or undefined if unavailable. */
  getToolCaller(): McpToolCaller | undefined;
  /** Check if the session is healthy and ready for work. */
  isHealthy(): boolean;
  /** Attempt to establish a connection. Resolves true if connected. */
  connect(): Promise<boolean>;
  /** Graceful disconnect. */
  disconnect(): void;
  /** Last error (sanitized — no tokens/keys). */
  lastError?: string;
  /** Number of consecutive failures. */
  consecutiveFailures: number;
}

/**
 * Creates a managed MCP session with health monitoring and reconnection.
 */
export function createMcpSession(config: McpSessionConfig): McpSession {
  const connectTimeoutMs = config.connectTimeoutMs ?? 30_000;
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  const reconnectBaseMs = config.reconnectBaseMs ?? 2_000;
  const maxReconnectAttempts = config.maxReconnectAttempts ?? 5;

  let state: McpSessionState = "disconnected";
  let toolCaller: McpToolCaller | undefined;
  let consecutiveFailures = 0;
  let lastError: string | undefined;

  const session: McpSession = {
    get state() { return state; },
    get consecutiveFailures() { return consecutiveFailures; },
    get lastError() { return lastError; },

    getToolCaller() {
      if (state !== "connected") return undefined;
      return wrapWithHealthTracking(toolCaller!);
    },

    isHealthy() {
      return state === "connected" && consecutiveFailures < maxConsecutiveFailures;
    },

    async connect() {
      if (state === "connected") return true;
      state = "connecting";

      for (let attempt = 0; attempt <= maxReconnectAttempts; attempt++) {
        try {
          const caller = await withTimeout(config.connect(), connectTimeoutMs);
          toolCaller = caller;
          state = "connected";
          consecutiveFailures = 0;
          lastError = undefined;
          return true;
        } catch (err) {
          lastError = sanitizeError(err);

          if (attempt < maxReconnectAttempts) {
            const backoff = reconnectBaseMs * 2 ** attempt + Math.random() * 1000;
            await sleep(backoff);
          }
        }
      }

      state = "disconnected";
      return false;
    },

    disconnect() {
      toolCaller = undefined;
      state = "disconnected";
      consecutiveFailures = 0;
    },
  };

  function wrapWithHealthTracking(caller: McpToolCaller): McpToolCaller {
    return async (toolName: string, args: Record<string, unknown>) => {
      try {
        const result = await caller(toolName, args);
        consecutiveFailures = 0;
        return result;
      } catch (err) {
        consecutiveFailures++;
        lastError = sanitizeError(err);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          state = "unhealthy";
        }
        throw err;
      }
    };
  }

  return session;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Strip anything that looks like a token, key, or secret
  return message
    .replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/key[=:]\s*\S+/gi, "key=[REDACTED]")
    .slice(0, 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP connection timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
