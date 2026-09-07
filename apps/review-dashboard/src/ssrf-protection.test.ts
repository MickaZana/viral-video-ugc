import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPrivateAddress } from "./accounts.js";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0];
}

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signupAndGetSession(email: string) {
  const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const cookie = sessionCookieFrom(signupRes);
  const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken, account: me.account };
}

// ─── isPrivateAddress: exhaustive unit tests ─────────────────────────────────

describe("isPrivateAddress: RFC 1918 + reserved range coverage", () => {
  // ── IPv4 private ranges ──

  describe("IPv4: RFC 1918 private", () => {
    it("10.0.0.0/8 — first address", () => expect(isPrivateAddress("10.0.0.0")).toBe(true));
    it("10.0.0.1 — typical private", () => expect(isPrivateAddress("10.0.0.1")).toBe(true));
    it("10.255.255.255 — last in range", () => expect(isPrivateAddress("10.255.255.255")).toBe(true));
    it("172.16.0.0 — start of 172.16/12", () => expect(isPrivateAddress("172.16.0.0")).toBe(true));
    it("172.16.0.1 — typical 172.16", () => expect(isPrivateAddress("172.16.0.1")).toBe(true));
    it("172.31.255.255 — end of 172.16/12", () => expect(isPrivateAddress("172.31.255.255")).toBe(true));
    it("172.32.0.1 — just outside 172.16/12 → public", () => expect(isPrivateAddress("172.32.0.1")).toBe(false));
    it("172.15.0.1 — just below 172.16/12 → public", () => expect(isPrivateAddress("172.15.0.1")).toBe(false));
    it("192.168.0.0 — start of 192.168/16", () => expect(isPrivateAddress("192.168.0.0")).toBe(true));
    it("192.168.0.1 — typical 192.168", () => expect(isPrivateAddress("192.168.0.1")).toBe(true));
    it("192.168.255.255 — end of 192.168/16", () => expect(isPrivateAddress("192.168.255.255")).toBe(true));
  });

  describe("IPv4: loopback (127.0.0.0/8)", () => {
    it("127.0.0.1 — standard loopback", () => expect(isPrivateAddress("127.0.0.1")).toBe(true));
    it("127.0.0.0 — first loopback", () => expect(isPrivateAddress("127.0.0.0")).toBe(true));
    it("127.255.255.255 — last loopback", () => expect(isPrivateAddress("127.255.255.255")).toBe(true));
  });

  describe("IPv4: link-local (169.254.0.0/16)", () => {
    it("169.254.0.0 — start", () => expect(isPrivateAddress("169.254.0.0")).toBe(true));
    it("169.254.1.1 — typical link-local", () => expect(isPrivateAddress("169.254.1.1")).toBe(true));
    it("169.254.169.254 — AWS metadata endpoint", () => expect(isPrivateAddress("169.254.169.254")).toBe(true));
    it("169.254.255.255 — end", () => expect(isPrivateAddress("169.254.255.255")).toBe(true));
  });

  describe("IPv4: this-network (0.0.0.0/8)", () => {
    it("0.0.0.0 — all-zeros", () => expect(isPrivateAddress("0.0.0.0")).toBe(true));
    it("0.0.0.1 — within 0/8", () => expect(isPrivateAddress("0.0.0.1")).toBe(true));
  });

  describe("IPv4: IETF protocol assignments (192.0.0.0/24)", () => {
    it("192.0.0.1 — IETF protocol", () => expect(isPrivateAddress("192.0.0.1")).toBe(true));
  });

  describe("IPv4: benchmarking (198.18.0.0/15)", () => {
    it("198.18.0.1 — benchmarking range", () => expect(isPrivateAddress("198.18.0.1")).toBe(true));
    it("198.19.255.255 — end of benchmarking", () => expect(isPrivateAddress("198.19.255.255")).toBe(true));
    it("198.20.0.1 — just outside benchmarking → public", () => expect(isPrivateAddress("198.20.0.1")).toBe(false));
  });

  describe("IPv4: shared address space (100.64.0.0/10)", () => {
    it("100.64.0.1 — CGNAT start", () => expect(isPrivateAddress("100.64.0.1")).toBe(true));
    it("100.127.255.255 — CGNAT end", () => expect(isPrivateAddress("100.127.255.255")).toBe(true));
    it("100.128.0.1 — just outside CGNAT → public", () => expect(isPrivateAddress("100.128.0.1")).toBe(false));
  });

  describe("IPv4: multicast and reserved (224+)", () => {
    it("224.0.0.1 — multicast", () => expect(isPrivateAddress("224.0.0.1")).toBe(true));
    it("239.255.255.255 — end multicast", () => expect(isPrivateAddress("239.255.255.255")).toBe(true));
    it("240.0.0.1 — reserved/future use", () => expect(isPrivateAddress("240.0.0.1")).toBe(true));
    it("255.255.255.255 — broadcast", () => expect(isPrivateAddress("255.255.255.255")).toBe(true));
  });

  describe("IPv4: public addresses (must return false)", () => {
    it("8.8.8.8 — Google DNS", () => expect(isPrivateAddress("8.8.8.8")).toBe(false));
    it("1.1.1.1 — Cloudflare DNS", () => expect(isPrivateAddress("1.1.1.1")).toBe(false));
    it("93.184.216.34 — example.com", () => expect(isPrivateAddress("93.184.216.34")).toBe(false));
    it("104.18.0.1 — Cloudflare", () => expect(isPrivateAddress("104.18.0.1")).toBe(false));
    it("203.0.113.1 — documentation range", () => expect(isPrivateAddress("203.0.113.1")).toBe(false));
  });

  // ── IPv6 ──

  describe("IPv6: loopback and private ranges", () => {
    it("::1 — loopback", () => expect(isPrivateAddress("::1")).toBe(true));
    it("fe80::1 — link-local", () => expect(isPrivateAddress("fe80::1")).toBe(true));
    it("fe80::abcd:1234 — link-local", () => expect(isPrivateAddress("fe80::abcd:1234")).toBe(true));
    it("fc00::1 — unique local (fc)", () => expect(isPrivateAddress("fc00::1")).toBe(true));
    it("fd00::1 — unique local (fd)", () => expect(isPrivateAddress("fd00::1")).toBe(true));
    it("fd12:3456:789a::1 — unique local", () => expect(isPrivateAddress("fd12:3456:789a::1")).toBe(true));
  });

  describe("IPv6: IPv4-mapped", () => {
    it("::ffff:127.0.0.1 — mapped loopback", () => expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true));
    it("::ffff:10.0.0.1 — mapped 10/8", () => expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true));
    it("::ffff:192.168.1.1 — mapped 192.168", () => expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true));
    it("::ffff:169.254.169.254 — mapped AWS metadata", () => expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true));
    it("::ffff:8.8.8.8 — mapped public → false", () => expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false));
    it("::ffff:1.1.1.1 — mapped public → false", () => expect(isPrivateAddress("::ffff:1.1.1.1")).toBe(false));
  });

  describe("IPv6: public addresses (must return false)", () => {
    it("2001:4860:4860::8888 — Google DNS", () => expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false));
    it("2606:4700::1111 — Cloudflare", () => expect(isPrivateAddress("2606:4700::1111")).toBe(false));
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("not a valid IP at all → true (fail-closed)", () => expect(isPrivateAddress("not-an-ip")).toBe(true));
    it("empty string → true (fail-closed)", () => expect(isPrivateAddress("")).toBe(true));
  });
});

// ─── assertSafeExternalUrl & fetchExternalBytes route tests ─────────────────

describe("Route-level SSRF defense (/accounts/products/ingest-url)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-ssrf-test-"));
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

  it("rejects file:// protocol with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-file@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "file:///etc/passwd" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only http and https|URL|invalid/i);
  });

  it("rejects AWS metadata endpoint (http://169.254.169.254/latest/meta-data/) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-aws@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "http://169.254.169.254/latest/meta-data/" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private or reserved address/i);
  });

  it("rejects embedded credentials (http://user:pass@host) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-creds@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "http://admin:secret@example.com/product" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/embedded credentials/i);
  });

  it("rejects loopback address (http://127.0.0.1:8080/admin) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-loopback@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "http://127.0.0.1:8080/admin" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private or reserved address/i);
  });

  it("rejects private 10.0.0.0/8 network address with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-10net@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "http://10.0.0.1/internal" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private or reserved address/i);
  });

  it("rejects IPv6 loopback (http://[::1]:3000/internal) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-ipv6@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "http://[::1]:3000/internal" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private or reserved address/i);
  });

  it("rejects ftp:// and other non-http(s) schemes with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("ssrf-ftp@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/ingest-url`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "ftp://internal.server/file.txt" })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only http and https/i);
  });
});
