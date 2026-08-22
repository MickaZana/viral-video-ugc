/**
 * Atom B (entry point) — Video Worker Process
 *
 * Persistent process with:
 * - Graceful SIGTERM/SIGINT shutdown
 * - MCP session initialization
 * - Configurable concurrency
 * - Health/metrics HTTP server
 * - Dry-run enforcement from environment
 */

import pino from "pino";
import { loadEnv, type Env } from "@vvugc/shared-config";
import { createFileProviderJobStore } from "@vvugc/review-queue";
import { join } from "node:path";
import { createMcpSession, type McpSessionConfig } from "./mcp-session.js";
import { createVideoWorker, type WorkerConfig } from "./worker.js";
import { createWorkerMetrics } from "./metrics.js";
import { startHealthServer } from "./health.js";
import type { McpToolCaller } from "@vvugc/mcp-video-gen";

const logger = pino({ name: "video-worker" });

async function main() {
  const env = loadEnv();

  // ---------------------------------------------------------------------------
  // Dry-run enforcement: same two-key lock as the rest of the system.
  // Without VVUGC_LLM_LIVE=true, the worker never contacts a real provider.
  // ---------------------------------------------------------------------------
  const dryRun = env.VVUGC_LLM_LIVE !== "true";
  if (dryRun) {
    logger.info("VVUGC_LLM_LIVE is not 'true' — worker will run in dry-run mode (no real provider calls)");
  }

  // ---------------------------------------------------------------------------
  // Provider job store
  // ---------------------------------------------------------------------------
  // The dashboard and worker are separate containers.  Their shared runs
  // volume is the durable handoff boundary; an in-memory queue would strand
  // every dashboard-enqueued job in the dashboard process.
  const store = createFileProviderJobStore(join(env.VVUGC_RUNS_DIR, "provider-jobs.json"));

  // ---------------------------------------------------------------------------
  // MCP Session Configuration
  // ---------------------------------------------------------------------------
  const mcpConfig: McpSessionConfig = {
    connect: createMcpConnector(env),
    connectTimeoutMs: parseInt(env.MCP_CONNECT_TIMEOUT_MS ?? "30000", 10),
    maxReconnectAttempts: parseInt(env.MCP_MAX_RECONNECT_ATTEMPTS ?? "5", 10),
  };
  const mcpSession = createMcpSession(mcpConfig);

  // Attempt MCP connection (non-blocking — worker can still serve REST-vendor jobs)
  if (!dryRun) {
    logger.info("Attempting MCP session connection...");
    const connected = await mcpSession.connect();
    if (connected) {
      logger.info("MCP session connected");
    } else {
      logger.warn("MCP session unavailable — Higgsfield jobs will fallback to REST vendors");
    }
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  const metrics = createWorkerMetrics();
  metrics.mcpSessionHealthy.set(mcpSession.isHealthy() ? 1 : 0);

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------
  const workerConfig: WorkerConfig = {
    concurrency: parseInt(env.VIDEO_WORKER_CONCURRENCY ?? "2", 10),
    pollIntervalMs: parseInt(env.VIDEO_WORKER_POLL_MS ?? "5000", 10),
    leaseMs: parseInt(env.VIDEO_WORKER_LEASE_MS ?? "120000", 10),
    outDir: env.VVUGC_RUNS_DIR ?? "./runs",
    dryRun,
  };

  const worker = createVideoWorker(store, mcpSession, metrics, workerConfig);

  // ---------------------------------------------------------------------------
  // Health server
  // ---------------------------------------------------------------------------
  const healthPort = parseInt(env.VIDEO_WORKER_HEALTH_PORT ?? "4330", 10);
  const healthServer = startHealthServer(worker, mcpSession, metrics, { port: healthPort });
  logger.info({ port: healthPort }, "Health/metrics server listening");

  // ---------------------------------------------------------------------------
  // Start worker
  // ---------------------------------------------------------------------------
  worker.start();

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    await worker.stop();
    await healthServer.close();
    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// MCP Connector Factory
// ---------------------------------------------------------------------------

/**
 * Creates the MCP connection function based on environment configuration.
 * In production, this would establish a connection to a Claude Agent SDK session
 * or a direct MCP server. For now, provides a stub that indicates unavailability
 * when no MCP_SERVER_URL is configured.
 */
function createMcpConnector(env: Env): () => Promise<McpToolCaller> {
  return async () => {
    const serverUrl = env.MCP_SERVER_URL;
    if (!serverUrl) {
      throw new Error(
        "MCP_SERVER_URL not configured — Higgsfield adapter requires an MCP server connection. " +
        "Set MCP_SERVER_URL to point to a Claude Agent SDK session with HiggsfieldAi MCP attached, " +
        "or rely on REST-vendor fallbacks (Kling/Replicate/Gemini)."
      );
    }

    // Production implementation would:
    // 1. Connect to the MCP server via stdio or HTTP transport
    // 2. Authenticate if required
    // 3. Return a callMcpTool function bound to the session
    //
    // For now, this is a placeholder that throws — the worker gracefully
    // falls back to REST vendors when MCP is unavailable.
    throw new Error(`MCP connection to ${serverUrl} not yet implemented — use REST vendor fallbacks`);
  };
}

main().catch((err) => {
  logger.fatal({ err }, "Video worker failed to start");
  process.exit(1);
});
