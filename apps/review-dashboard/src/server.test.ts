import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const AUTH_HEADER = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64") };

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: "/tmp/x.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "hi",
      points: ["p1"],
      cta: "cta",
      durationSec: 25,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    dryRun: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function startServer() {
  // resolveCredentials() runs once at server.js's module top level — resetModules()
  // forces a fresh evaluation per test so it re-reads whatever DASHBOARD_USERNAME/
  // DASHBOARD_PASSWORD this test's beforeEach just set, instead of reusing whatever
  // the first test in the file happened to see.
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

describe("review-dashboard HTTP API", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-review-dashboard-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("GET /queue returns items, optionally filtered by status", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));

    // Fresh import per test-server instance keeps this isolated from the module-level `app`
    // singleton across test files, and confirms importing server.ts has no side effects
    // (no accidental app.listen()) now that the isMain guard is in place.
    await startServer();

    const all = await (await fetch(`${baseUrl}/queue`, { headers: AUTH_HEADER })).json();
    expect(all.items).toHaveLength(2);

    const approvedOnly = await (await fetch(`${baseUrl}/queue?status=approved`, { headers: AUTH_HEADER })).json();
    expect(approvedOnly.items).toHaveLength(1);
    expect(approvedOnly.items[0].id).toBe("b");
  });

  it("GET /queue filters by niche and platform query params", async () => {
    insertReviewItem(makeItem({ id: "a", niche: "fitness", platform: "tiktok" }));
    insertReviewItem(makeItem({ id: "b", niche: "finance", platform: "tiktok" }));
    await startServer();

    const filtered = await (
      await fetch(`${baseUrl}/queue?niche=fitness&platform=tiktok`, { headers: AUTH_HEADER })
    ).json();
    expect(filtered.items.map((i: ReviewItem) => i.id)).toEqual(["a"]);
  });

  it("GET /queue rejects an invalid status query param with 400 instead of silently passing it through", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    await startServer();

    const res = await fetch(`${baseUrl}/queue?status=not-a-real-status`, { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("pending");
    expect(body.error).toContain("approved");
    expect(body.error).toContain("rejected");
  });

  it("GET /queue rejects an invalid platform query param with 400 instead of silently passing it through", async () => {
    insertReviewItem(makeItem({ id: "a", platform: "tiktok" }));
    await startServer();

    const res = await fetch(`${baseUrl}/queue?platform=not-a-real-platform`, { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("tiktok");
  });

  it("POST /queue/:id/approve updates status and persists it", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    await startServer();

    const approveRes = await fetch(`${baseUrl}/queue/a/approve`, { method: "POST", headers: AUTH_HEADER });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("approved");

    const fetched = await (await fetch(`${baseUrl}/queue/a`, { headers: AUTH_HEADER })).json();
    expect(fetched.status).toBe("approved");
  });

  it("POST /queue/:id/reject on an unknown id returns 404", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/queue/does-not-exist/reject`, { method: "POST", headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });

  it("POST /queue/bulk/approve updates every id in the batch", async () => {
    insertReviewItem(makeItem({ id: "a" }));
    insertReviewItem(makeItem({ id: "b" }));
    insertReviewItem(makeItem({ id: "c" }));
    await startServer();

    const res = await fetch(`${baseUrl}/queue/bulk/approve`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "c"] })
    });
    const body = await res.json();
    expect(body.updated.sort()).toEqual(["a", "c"]);

    const data = await (await fetch(`${baseUrl}/queue`, { headers: AUTH_HEADER })).json();
    expect(data.items.find((i: ReviewItem) => i.id === "a").status).toBe("approved");
    expect(data.items.find((i: ReviewItem) => i.id === "b").status).toBe("pending");
  });

  it("GET /stats aggregates counts by status and total estimated spend across runs", async () => {
    insertReviewItem(makeItem({ id: "a", status: "pending" }));
    insertReviewItem(makeItem({ id: "b", status: "approved" }));
    insertReviewItem(makeItem({ id: "c", status: "rejected" }));

    const runDir = join(testDir, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ config: { niche: "fitness" } }));
    writeFileSync(join(runDir, "cost-ledger.json"), JSON.stringify({ totalUsd: 2.5 }));

    await startServer();
    const stats = await (await fetch(`${baseUrl}/stats`, { headers: AUTH_HEADER })).json();
    expect(stats).toEqual(expect.objectContaining({ pending: 1, approved: 1, rejected: 1, estimatedCostUsd: 2.5 }));
    expect(typeof stats.isLLMLive).toBe("boolean");
  });

  it("GET /runs returns run history read from the runs directory", async () => {
    const runDir = join(testDir, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({ config: { niche: "fitness", platforms: ["tiktok"], createdAt: "2026-01-01T00:00:00.000Z" }, candidatesFound: 2, reviewItemsCreated: 2 })
    );
    await startServer();

    const runs = await (await fetch(`${baseUrl}/runs`, { headers: AUTH_HEADER })).json();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run-1", niche: "fitness", candidatesFound: 2 });
  });

  it("GET /tokens.css serves the shared design tokens stylesheet", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/tokens.css`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("--accent");
  });

  it("GET / redirects guests to /app", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });

  it("GET /app serves the control-panel SPA without operator auth (when built)", async () => {
    await startServer();
    // Only meaningful when the control-panel has been built (true in CI and after
    // `pnpm build`); if the dist is absent the route intentionally 404s and this
    // check is skipped rather than failing the suite.
    const res = await fetch(`${baseUrl}/app`);
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Viral Video UGC");
    expect(html).toContain('<div id="root">');
    const nested = await fetch(`${baseUrl}/app/intel`);
    if (nested.status !== 404) {
      expect(nested.status).toBe(200);
      expect(await nested.text()).toContain('<div id="root">');
    }
  });

  it("GET /api/* is rewritten to the backend's real routes", async () => {
    await startServer();
    // /api/healthz must reach the real public /healthz handler (the prefix is
    // stripped before routing) — proves the control-panel's /api calls work
    // same-origin in production.
    const res = await fetch(`${baseUrl}/api/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /metrics serves Prometheus text format without credentials, and records prior requests", async () => {
    await startServer();
    await fetch(`${baseUrl}/queue`, { headers: AUTH_HEADER }); // generate at least one recorded request first
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("http_requests_total");
    expect(text).toContain('service="review-dashboard"');
  });

  it("every response carries an X-Request-Id header, and a caller-supplied one is echoed back", async () => {
    await startServer();
    const withoutHeader = await fetch(`${baseUrl}/healthz`);
    expect(withoutHeader.headers.get("x-request-id")).toBeTruthy();

    const withHeader = await fetch(`${baseUrl}/healthz`, { headers: { "X-Request-Id": "caller-id-abc" } });
    expect(withHeader.headers.get("x-request-id")).toBe("caller-id-abc");
  });

  it("GET /healthz reports ok without touching the review-queue store", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok" });
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  describe("authentication", () => {
    it("GET /healthz requires no credentials at all", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
    });

    it("every other route rejects a request with no credentials", async () => {
      await startServer();
      const targets: [string, RequestInit?][] = [
        [`${baseUrl}/queue`],
        [`${baseUrl}/stats`],
        [`${baseUrl}/runs`],
        [`${baseUrl}/queue/does-not-exist`],
        [`${baseUrl}/queue/does-not-exist/approve`, { method: "POST" }],
        [`${baseUrl}/queue/bulk/approve`, { method: "POST" }]
      ];
      for (const [url, init] of targets) {
        const res = await fetch(url, init);
        expect(res.status, `${init?.method ?? "GET"} ${url}`).toBe(401);
      }
    });

    it("GET / is intentionally public — it redirects to the SPA rather than requiring auth", async () => {
      await startServer();
      // redirect: "manual" so fetch doesn't follow the 302 to /app (which would
      // resolve to 200 via the SPA fallback and mask the intended unauthenticated redirect.
      const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
      expect(res.status, "GET /").toBe(302);
    });

    it("GET /tokens.css requires no credentials — it's non-sensitive and the public /account page depends on it", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/tokens.css`);
      expect(res.status).toBe(200);
    });

    it("GET /account/join requires no credentials — the invite link account-page.ts hands the owner to send a teammate must not fall through to the operator Basic Auth gate", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/account/join?token=some-invite-token`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Your Account");
    });

    it("rejects the wrong password", async () => {
      await startServer();
      const badHeader = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:wrong-password`).toString("base64") };
      const res = await fetch(`${baseUrl}/queue`, { headers: badHeader });
      expect(res.status).toBe(401);
    });

    it("rejects the wrong username", async () => {
      await startServer();
      const badHeader = { Authorization: "Basic " + Buffer.from(`nobody:${TEST_PASS}`).toString("base64") };
      const res = await fetch(`${baseUrl}/queue`, { headers: badHeader });
      expect(res.status).toBe(401);
    });

    it("a 401 response includes a WWW-Authenticate header so browsers prompt for credentials", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/queue`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
    });

    it("accepts the correct credentials", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/queue`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
    });

    it("without DASHBOARD_USERNAME/DASHBOARD_PASSWORD configured, still enforces auth using a generated credential (never runs open)", async () => {
      delete process.env.DASHBOARD_USERNAME;
      delete process.env.DASHBOARD_PASSWORD;
      await startServer();

      const unauthed = await fetch(`${baseUrl}/queue`);
      expect(unauthed.status).toBe(401);

      // No way to know the generated password from outside the process (by design) —
      // confirm the guessable default "admin:admin" still doesn't work.
      const guessed = { Authorization: "Basic " + Buffer.from("admin:admin").toString("base64") };
      const guessedRes = await fetch(`${baseUrl}/queue`, { headers: guessed });
      expect(guessedRes.status).toBe(401);
    });
  });

  describe("rate limiting", () => {
    it(
      "returns 429 after 20 failed-login attempts from the same client within the window, without ever leaking a 401 vs 429 distinction that would help an attacker",
      async () => {
        await startServer();
        const wrongAuth = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:wrong-password`).toString("base64") };

        const statuses: number[] = [];
        for (let i = 0; i < 25; i++) {
          const res = await fetch(`${baseUrl}/queue`, { headers: wrongAuth });
          statuses.push(res.status);
        }

        expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
        expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
      },
      15000
    );

    it("does not count successful authenticated requests against the failed-login limit", async () => {
      await startServer();
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${baseUrl}/queue`, { headers: AUTH_HEADER });
        expect(res.status).toBe(200);
      }
    });
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
