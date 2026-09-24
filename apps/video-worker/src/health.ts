/**
 * Atom F — Health Check HTTP Server
 *
 * Lightweight Express server exposing:
 * - GET /healthz — liveness probe
 * - GET /readyz — readiness (worker running + store reachable)
 * - GET /metrics — Prometheus exposition format
 * - GET /status — operator diagnostics (sanitized provider health)
 */

import express from "express";
import type { WorkerMetrics } from "./metrics.js";
import type { McpSession } from "./mcp-session.js";
import type { VideoWorker } from "./worker.js";

export interface HealthServerConfig {
  port?: number;
}

export function startHealthServer(
  worker: VideoWorker,
  mcpSession: McpSession,
  metrics: WorkerMetrics,
  config: HealthServerConfig = {}
) {
  const port = config.port ?? 4330;
  const app = express();
  const startedAt = Date.now();

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/readyz", (_req, res) => {
    const ready = worker.isRunning();
    res.status(ready ? 200 : 503).json({
      ready,
      mcpState: mcpSession.state,
      mcpHealthy: mcpSession.isHealthy(),
    });
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  });

  app.get("/status", (_req, res) => {
    res.json({
      worker: {
        running: worker.isRunning(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
      mcp: {
        state: mcpSession.state,
        healthy: mcpSession.isHealthy(),
        consecutiveFailures: mcpSession.consecutiveFailures,
        lastError: mcpSession.lastError, // Already sanitized in mcp-session.ts
      },
    });
  });

  const server = app.listen(port, () => {
    // Logged by caller
  });

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port,
  };
}
