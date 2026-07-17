import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signUpAndGetCookie(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from signup");
  return setCookie.split(";")[0];
}

describe("billing routes", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-billing-test-"));
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
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_GROWTH;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("GET /accounts/billing returns the tier list and no-plan state for a brand-new account", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("new@example.com");
    const res = await fetch(`${baseUrl}/accounts/billing`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.tierId).toBeNull();
    expect(body.tiers.map((t: { id: string }) => t.id)).toEqual(["starter", "growth", "agency"]);
  });

  it("GET /accounts/billing requires a session, not Basic Auth", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/billing`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("POST /accounts/billing/checkout rejects an unknown tierId with 400, no Stripe call attempted", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("badtier@example.com");
    const res = await fetch(`${baseUrl}/accounts/billing/checkout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: "not-a-real-tier" })
    });
    expect(res.status).toBe(400);
  });

  it("POST /accounts/billing/checkout reaches the real Stripe wiring and surfaces a clear error when unconfigured", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("checkout@example.com");
    const res = await fetch(`${baseUrl}/accounts/billing/checkout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: "growth" })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/STRIPE_SECRET_KEY|STRIPE_PRICE_ID_GROWTH/);
  });

  it("POST /webhooks/stripe requires a stripe-signature header", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/stripe-signature/);
  });

  it("POST /webhooks/stripe with a bad signature is rejected, not silently accepted", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    await startServer();
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "not-a-real-signature" },
      body: JSON.stringify({ type: "checkout.session.completed" })
    });
    expect(res.status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
