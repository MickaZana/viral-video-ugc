import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAppMetrics, requestIdMiddleware } from "./index.js";

let server: Server | undefined;

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server!.address() as { port: number }).port;
  return `http://localhost:${port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("createAppMetrics", () => {
  it("exposes default process/runtime metrics with the service label set", async () => {
    const { registry } = createAppMetrics("test-service");
    const text = await registry.metrics();
    expect(text).toContain('service="test-service"');
    // A default Node.js metric from collectDefaultMetrics — proves it actually ran.
    expect(text).toContain("process_cpu_user_seconds_total");
  });

  it("metricsMiddleware records request count and duration, labeled by matched route/method/status", async () => {
    const { metricsMiddleware, metricsHandler, registry } = createAppMetrics("route-test");
    const app = express();
    app.use(metricsMiddleware);
    app.get("/items/:id", (_req, res) => res.json({ ok: true }));
    app.get("/metrics", metricsHandler);
    const base = await listen(app);

    await fetch(`${base}/items/42`);
    await fetch(`${base}/items/43`);

    const text = await registry.metrics();
    const line = text.split("\n").find((l) => l.startsWith("http_requests_total{") && l.includes('route="/items/:id"'));
    expect(line, text).toBeTruthy();
    expect(line).toContain('method="GET"');
    expect(line).toContain('status="200"');
    expect(line?.trim().endsWith(" 2")).toBe(true);
    expect(text).toContain("http_request_duration_seconds");
  });

  it("labels unmatched routes (404s) as route=\"unmatched\" instead of the raw path, avoiding unbounded cardinality", async () => {
    const { metricsMiddleware, metricsHandler, registry } = createAppMetrics("notfound-test");
    const app = express();
    app.use(metricsMiddleware);
    app.get("/metrics", metricsHandler);
    const base = await listen(app);

    await fetch(`${base}/this/path/does/not/exist`);

    const text = await registry.metrics();
    const line = text.split("\n").find((l) => l.startsWith("http_requests_total{") && l.includes('route="unmatched"'));
    expect(line, text).toBeTruthy();
    expect(line).toContain('status="404"');
    expect(line?.trim().endsWith(" 1")).toBe(true);
    expect(text).not.toContain("this/path/does/not/exist");
  });

  it("GET /metrics serves Prometheus text exposition format with the correct content type", async () => {
    const { metricsMiddleware, metricsHandler } = createAppMetrics("content-type-test");
    const app = express();
    app.use(metricsMiddleware);
    app.get("/metrics", metricsHandler);
    const base = await listen(app);

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("# HELP http_requests_total");
    expect(text).toContain("# TYPE http_requests_total counter");
  });

  it("two independent registries (two services) don't leak counts into each other", async () => {
    const a = createAppMetrics("service-a");
    const b = createAppMetrics("service-b");
    const appA = express();
    appA.use(a.metricsMiddleware);
    appA.get("/x", (_req, res) => res.json({}));
    const baseA = await listen(appA);
    await fetch(`${baseA}/x`);

    const textA = await a.registry.metrics();
    const textB = await b.registry.metrics();
    expect(textA).toMatch(/http_requests_total\{[^}]*route="\/x"[^}]*\}\s+1/);
    expect(textB).not.toContain('route="/x"');
  });
});

describe("requestIdMiddleware", () => {
  it("generates a fresh UUID and echoes it on the response when no inbound header is present", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (req: express.Request & { id?: string }, res) => res.json({ id: req.id }));
    const base = await listen(app);

    const res = await fetch(`${base}/`);
    const body = await res.json();
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toBeTruthy();
    expect(headerId).toBe(body.id);
    expect(headerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses an inbound X-Request-Id header instead of generating a new one", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (req: express.Request & { id?: string }, res) => res.json({ id: req.id }));
    const base = await listen(app);

    const res = await fetch(`${base}/`, { headers: { "X-Request-Id": "caller-supplied-id-123" } });
    expect(res.headers.get("x-request-id")).toBe("caller-supplied-id-123");
    expect((await res.json()).id).toBe("caller-supplied-id-123");
  });

  it("generates a different id on every request with no inbound header", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", (req: express.Request & { id?: string }, res) => res.json({ id: req.id }));
    const base = await listen(app);

    const [a, b] = await Promise.all([fetch(`${base}/`), fetch(`${base}/`)]);
    expect((await a.json()).id).not.toBe((await b.json()).id);
  });
});
