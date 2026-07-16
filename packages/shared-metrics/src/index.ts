import { randomUUID } from "node:crypto";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export { installLifecycleHandlers, type LifecycleLogger, type LifecycleOptions } from "./lifecycle.js";

export interface AppMetrics {
  registry: Registry;
  /** Records every request's count + duration, labeled by method/matched-route/status. */
  metricsMiddleware: RequestHandler;
  /** Serves the registry in Prometheus text exposition format — mount at GET /metrics. */
  metricsHandler: RequestHandler;
}

/**
 * Self-hosted metrics — no external account, no cost, no SaaS dependency. Any
 * Prometheus-compatible scraper (Prometheus itself, Grafana Agent, VictoriaMetrics,
 * etc.) can pull GET /metrics directly; nothing to sign up for. Deliberately not
 * behind the dashboard's Basic Auth (see apps/review-dashboard/src/auth.ts) — it's
 * aggregate operational data (request counts/timings, process stats), not content,
 * and /metrics being separately network-restricted (not app-level authed) is the
 * standard Prometheus/Kubernetes convention scrapers expect by default.
 */
export function createAppMetrics(serviceName: string): AppMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests handled",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry]
  });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry]
  });

  const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      // req.route is only populated once Express has matched a route — read inside
      // finish (after routing/handling completed), not at the top of this middleware
      // (which runs before routing). Falls back to "unmatched" for 404s so arbitrary
      // probed/attacker-supplied paths don't create unbounded label cardinality.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, durationSec);
    });
    next();
  };

  const metricsHandler = async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  };

  return { registry, metricsMiddleware, metricsHandler };
}

/**
 * Assigns a per-request correlation id (from an inbound X-Request-Id header if the
 * caller/load-balancer already set one, otherwise a fresh UUID) and echoes it back
 * on the response. Attach it to every log line for the request (`req.id`) so a
 * specific failed request can be traced through logs — this is the appropriately-scoped
 * amount of "tracing" for a small number of monolithic services with no cross-service
 * call graph to visualize yet; full distributed spans (OpenTelemetry) would be
 * over-engineering until there's an actual multi-hop request path to trace.
 */
export function requestIdMiddleware(req: Request & { id?: string }, res: Response, next: NextFunction): void {
  const id = (req.headers["x-request-id"] as string | undefined) || randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
