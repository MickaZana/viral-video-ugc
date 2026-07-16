import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBasicAuthMiddleware, credentialsFilePath, resolveCredentials } from "./auth.js";

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function fakeReqRes(authHeader?: string) {
  const req = { headers: { authorization: authHeader } } as any;
  const state = { status: undefined as number | undefined, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    set(key: string, value: string) {
      state.headers[key] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    }
  } as any;
  return { req, res, state };
}

describe("resolveCredentials", () => {
  let testDir: string;

  beforeEach(() => {
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    testDir = mkdtempSync(join(tmpdir(), "vvugc-dashboard-auth-test-"));
    process.env.VVUGC_RUNS_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.VVUGC_RUNS_DIR;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("uses DASHBOARD_USERNAME/DASHBOARD_PASSWORD when both are set, without warning", () => {
    process.env.DASHBOARD_USERNAME = "alice";
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const warn = vi.fn();

    const creds = resolveCredentials({ warn });

    expect(creds).toEqual({ username: "alice", password: "correct-horse-battery-staple", generated: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("generates a random credential and warns exactly once when both are unset", () => {
    const warn = vi.fn();
    const creds = resolveCredentials({ warn });

    expect(creds.generated).toBe(true);
    expect(creds.username).toBe("admin");
    expect(creds.password.length).toBeGreaterThanOrEqual(20); // 18 random bytes, base64url-encoded
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ username: "admin", password: creds.password });
  });

  it("generates a random credential when only one of the two is set (partial config is not treated as complete)", () => {
    process.env.DASHBOARD_USERNAME = "alice";
    const creds = resolveCredentials({ warn: vi.fn() });
    expect(creds.generated).toBe(true);
  });

  it("generates a different password on every call (never reuses a prior random value)", () => {
    const a = resolveCredentials({ warn: vi.fn() });
    const b = resolveCredentials({ warn: vi.fn() });
    expect(a.password).not.toBe(b.password);
  });

  it("writes the generated login to dashboard-credentials.txt in plain text, discoverable without parsing logs", () => {
    const creds = resolveCredentials({ warn: vi.fn() });
    const filePath = credentialsFilePath(testDir);
    expect(existsSync(filePath)).toBe(true);
    const contents = readFileSync(filePath, "utf-8");
    expect(contents).toContain(creds.username);
    expect(contents).toContain(creds.password);
  });

  it("removes a stale generated-credentials file once real DASHBOARD_USERNAME/DASHBOARD_PASSWORD are configured", () => {
    resolveCredentials({ warn: vi.fn() }); // writes a generated-credentials file
    const filePath = credentialsFilePath(testDir);
    expect(existsSync(filePath)).toBe(true);

    process.env.DASHBOARD_USERNAME = "alice";
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    resolveCredentials({ warn: vi.fn() });

    expect(existsSync(filePath)).toBe(false);
  });

  it("does not write a credentials file at all when explicit env vars are already configured", () => {
    process.env.DASHBOARD_USERNAME = "alice";
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    resolveCredentials({ warn: vi.fn() });
    expect(existsSync(credentialsFilePath(testDir))).toBe(false);
  });

  it("tolerates the credentials directory not existing yet (creates it)", () => {
    const nestedDir = join(testDir, "does", "not", "exist", "yet");
    process.env.VVUGC_RUNS_DIR = nestedDir;
    resolveCredentials({ warn: vi.fn() });
    expect(existsSync(credentialsFilePath(nestedDir))).toBe(true);
  });
});

describe("createBasicAuthMiddleware", () => {
  const middleware = createBasicAuthMiddleware({ username: "alice", password: "s3cret", generated: false });

  it("calls next() and does not touch the response when credentials match exactly", () => {
    const { req, res, state } = fakeReqRes(basicAuthHeader("alice", "s3cret"));
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
  });

  it("rejects with 401 and a WWW-Authenticate header when no Authorization header is sent", () => {
    const { req, res, state } = fakeReqRes(undefined);
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
    expect(state.headers["WWW-Authenticate"]).toContain("Basic");
  });

  it("rejects a wrong password", () => {
    const { req, res, state } = fakeReqRes(basicAuthHeader("alice", "wrong"));
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("rejects a wrong username", () => {
    const { req, res, state } = fakeReqRes(basicAuthHeader("mallory", "s3cret"));
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("rejects a non-Basic auth scheme", () => {
    const { req, res, state } = fakeReqRes("Bearer some-token");
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("rejects malformed base64 in the Authorization header without throwing", () => {
    const { req, res, state } = fakeReqRes("Basic not-valid-base64!!!");
    const next = vi.fn();
    expect(() => middleware(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("rejects a decoded header with no ':' separator", () => {
    const { req, res, state } = fakeReqRes("Basic " + Buffer.from("no-colon-here").toString("base64"));
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("rejects an empty Authorization header", () => {
    const { req, res, state } = fakeReqRes("");
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("a password that is a prefix of the real one is still rejected (not a substring match)", () => {
    const { req, res, state } = fakeReqRes(basicAuthHeader("alice", "s3cre"));
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(401);
  });

  it("handles a password containing a literal ':' correctly (only the first ':' separates user from pass)", () => {
    const withColonPassword = createBasicAuthMiddleware({ username: "alice", password: "pa:ss:word", generated: false });
    const { req, res, state } = fakeReqRes(basicAuthHeader("alice", "pa:ss:word"));
    const next = vi.fn();
    withColonPassword(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
  });
});
