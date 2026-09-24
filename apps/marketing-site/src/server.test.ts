import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitlistPath } from "./waitlist.js";

let server: Server;
let baseUrl: string;
let testDir: string;
let app: import("express").Express;

async function startServer() {
  // Without this, every test in this file would share the same cached ./server.js
  // module instance (and so the same Express app, including the waitlist rate
  // limiter's in-memory request counter) — a request in one test would silently
  // count against another test's quota. resetModules() forces a fresh app per test.
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

describe("marketing-site HTTP API", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-marketing-site-test-"));
    process.env.VVUGC_RUNS_DIR = testDir;
  });

  afterEach(() => {
    server?.close();
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it(
    "GET /healthz reports ok",
    async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "ok" });
      expect(typeof body.uptimeSeconds).toBe("number");
    },
    15000
  );

  it("GET / renders the landing page", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Viral Video UGC");
  });

  it("GET / falls back to the request's own origin for og:image/twitter:image when PUBLIC_BASE_URL is unset", async () => {
    delete process.env.PUBLIC_BASE_URL;
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).not.toContain("{{BASE_URL}}");
    expect(html).toContain(`content="${baseUrl}/videos/hero-reel.svg"`);
    expect(html).toContain(`content="${baseUrl}/"`);
  });

  it("GET / uses PUBLIC_BASE_URL (trailing slash stripped) for og:image/twitter:image when configured", async () => {
    process.env.PUBLIC_BASE_URL = "https://vvugc.example.com/";
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).not.toContain("{{BASE_URL}}");
    expect(html).toContain('content="https://vvugc.example.com/videos/hero-reel.svg"');
    expect(html).toContain('content="https://vvugc.example.com/"');
    delete process.env.PUBLIC_BASE_URL;
  });

  it("GET / links to the real product (Sign In / Try it now) at the local-dev default when APP_BASE_URL is unset", async () => {
    delete process.env.APP_BASE_URL;
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).not.toContain("{{APP_BASE_URL}}");
    expect(html).toContain('href="http://localhost:4310/app?mode=signin"');
    expect(html).toContain('href="http://localhost:4310/app?mode=signup"');
  });

  it("GET / uses APP_BASE_URL (trailing slash stripped) for the Sign In / Try it now links when configured", async () => {
    process.env.APP_BASE_URL = "https://app.vvugc.example.com/";
    await startServer();
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).not.toContain("{{APP_BASE_URL}}");
    expect(html).toContain('href="https://app.vvugc.example.com/app?mode=signin"');
    expect(html).toContain('href="https://app.vvugc.example.com/app?mode=signup"');
    delete process.env.APP_BASE_URL;
  });

  it("GET /tokens.css serves the shared design tokens stylesheet", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/tokens.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("--accent");
  });

  it("GET /privacy renders the privacy policy, using LEGAL_ENTITY_NAME/LEGAL_PRIVACY_EMAIL when configured", async () => {
    process.env.LEGAL_ENTITY_NAME = "Test Legal Entity AB";
    process.env.LEGAL_PRIVACY_EMAIL = "privacy@test-legal-entity.example";
    await startServer();
    const res = await fetch(`${baseUrl}/privacy`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Test Legal Entity AB");
    expect(html).toContain("privacy@test-legal-entity.example");
    delete process.env.LEGAL_ENTITY_NAME;
    delete process.env.LEGAL_PRIVACY_EMAIL;
  });

  it("GET /privacy falls back to an obviously-not-real placeholder when unconfigured (never fabricates real legal content)", async () => {
    delete process.env.LEGAL_ENTITY_NAME;
    delete process.env.LEGAL_PRIVACY_EMAIL;
    await startServer();
    const res = await fetch(`${baseUrl}/privacy`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("[Configure LEGAL_ENTITY_NAME]");
    expect(html).toContain("configure-LEGAL_PRIVACY_EMAIL@example.invalid");
  });

  it("GET /terms renders the terms page and links back to /privacy", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/terms`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/privacy"');
  });

  it("refuses to boot in production without LEGAL_ENTITY_NAME/LEGAL_PRIVACY_EMAIL configured", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.LEGAL_ENTITY_NAME;
    delete process.env.LEGAL_PRIVACY_EMAIL;
    process.env.NODE_ENV = "production";
    vi.resetModules();
    await expect(import("./server.js")).rejects.toThrow(/LEGAL_ENTITY_NAME and LEGAL_PRIVACY_EMAIL are required/);
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("GET /api/manifest returns the video manifest", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/manifest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("POST /api/waitlist persists a valid email and returns ok", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(waitlistPath())).toBe(true);
    expect(JSON.parse(readFileSync(waitlistPath(), "utf-8").trim()).email).toBe("person@example.com");
  });

  it("POST /api/waitlist rejects an invalid email with 400", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("GET /metrics serves Prometheus text format and records prior requests", async () => {
    await startServer();
    await fetch(`${baseUrl}/`);
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("http_requests_total");
    expect(text).toContain('service="marketing-site"');
  });

  it(
    "POST /api/waitlist returns 429 after 10 submissions from the same client within the window",
    async () => {
      await startServer();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${baseUrl}/api/waitlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: `person${i}@example.com` })
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    },
    15000
  );

  it("every response carries an X-Request-Id header, and a caller-supplied one is echoed back", async () => {
    await startServer();
    const withoutHeader = await fetch(`${baseUrl}/healthz`);
    expect(withoutHeader.headers.get("x-request-id")).toBeTruthy();

    const withHeader = await fetch(`${baseUrl}/healthz`, { headers: { "X-Request-Id": "caller-id-xyz" } });
    expect(withHeader.headers.get("x-request-id")).toBe("caller-id-xyz");
  });

  describe("trust proxy", () => {
    it("defaults to not trusting any proxy hop (req.ip is the direct TCP peer, not X-Forwarded-For)", async () => {
      delete process.env.TRUST_PROXY_HOPS;
      await startServer();
      expect(app.get("trust proxy")).toBe(false);
    });

    it("trusts the configured number of proxy hops when TRUST_PROXY_HOPS is set", async () => {
      process.env.TRUST_PROXY_HOPS = "1";
      await startServer();
      expect(app.get("trust proxy")).toBe(1);
      delete process.env.TRUST_PROXY_HOPS;
    });
  });
});
