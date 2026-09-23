/**
 * API Foundation tests — rate-limit config, billing-gate contract, response envelope.
 *
 * These three modules ship exported logic that platform.test.ts (Phase F security
 * suite) never exercised: rate-limit key resolution, the billing-gate assertion,
 * and the apiSuccess/apiError envelope helpers.
 */

import { describe, expect, it } from "vitest";
import {
  API_RATE_LIMITS,
  BILLING_ENFORCED_PATHS,
  API_RESPONSE_ENVELOPE,
  apiError,
  apiSuccess,
  assertBillingGateConsulted,
  generateRequestId,
  resolveRateLimitKey,
} from "./index.js";
import { API_ERROR_CODES } from "./api-envelope.js";

describe("rate limit key resolution", () => {
  it("keys by ip / credential / org as configured", () => {
    expect(resolveRateLimitKey("ip", { ip: "203.0.113.7" })).toBe("ip:203.0.113.7");
    expect(resolveRateLimitKey("credential", { credentialId: "cred-1", orgId: "org-1" })).toBe("cred:cred-1");
    expect(resolveRateLimitKey("org", { orgId: "org-1" })).toBe("org:org-1");
  });

  it("falls back to distinct 'unknown' keys rather than empty strings that would collide", () => {
    expect(resolveRateLimitKey("ip", {})).toBe("ip:unknown");
    expect(resolveRateLimitKey("credential", {})).toBe("cred:unknown");
    expect(resolveRateLimitKey("org", {})).toBe("org:unknown");
    // credential keying degrades to orgId when the credential id is absent
    expect(resolveRateLimitKey("credential", { orgId: "org-1" })).toBe("cred:org-1");
    // the three keying strategies never produce the same key for the same context
    const ctx = { ip: "1.2.3.4", credentialId: "c1", orgId: "o1" };
    const keys = ["ip", "credential", "org"].map((k) =>
      resolveRateLimitKey(k as "ip" | "credential" | "org", ctx)
    );
    expect(new Set(keys).size).toBe(3);
  });
});

describe("API_RATE_LIMITS security invariants", () => {
  it("keys paid/irreversible endpoints per organization with aggressive limits", () => {
    expect(API_RATE_LIMITS.runs_create.keyBy).toBe("org");
    expect(API_RATE_LIMITS.runs_create.limit).toBeLessThanOrEqual(10);
    expect(API_RATE_LIMITS.publish.keyBy).toBe("org");
    expect(API_RATE_LIMITS.publish.limit).toBeLessThanOrEqual(5);
    // a leaked API key must not be able to burn unlimited paid generation:
    // the expensive endpoints are strictly stricter than the read default
    expect(API_RATE_LIMITS.runs_create.limit).toBeLessThan(API_RATE_LIMITS.default.limit);
    expect(API_RATE_LIMITS.publish.limit).toBeLessThan(API_RATE_LIMITS.default.limit);
  });

  it("every configured limit is a positive count over a positive window", () => {
    for (const [name, cfg] of Object.entries(API_RATE_LIMITS)) {
      expect(cfg.limit, name).toBeGreaterThan(0);
      expect(cfg.windowMs, name).toBeGreaterThan(0);
      expect(cfg.description.length, name).toBeGreaterThan(0);
      expect(["ip", "credential", "org"]).toContain(cfg.keyBy);
    }
  });
});

describe("billing gate contract", () => {
  it("assertBillingGateConsulted throws when the gate was never consulted", () => {
    expect(() => assertBillingGateConsulted(undefined)).toThrow(/BILLING VIOLATION/);
    expect(() => assertBillingGateConsulted(undefined)).toThrow(/checkRunQuota/);
  });

  it("passes for any consulted result — including a denied run", () => {
    expect(() =>
      assertBillingGateConsulted({ allowed: false, overage: false, reason: "quota_exceeded" })
    ).not.toThrow();
    expect(() =>
      assertBillingGateConsulted({ allowed: true, overage: true, overagePriceUsdPerRun: 6 })
    ).not.toThrow();
  });

  it("enumerates every run-creating path that must enforce the gate", () => {
    expect(BILLING_ENFORCED_PATHS).toContain("POST /accounts/run");
    expect(BILLING_ENFORCED_PATHS).toContain("POST /accounts/jobs");
    expect(BILLING_ENFORCED_PATHS).toContain("POST /v1/runs");
    expect(BILLING_ENFORCED_PATHS).toContain("scheduler.runDueClientSchedules");
  });
});

describe("API response envelope", () => {
  it("generateRequestId is req_-prefixed and unique", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).toMatch(/^req_[0-9a-f-]+$/i);
    expect(a).not.toBe(b);
  });

  it("apiSuccess omits meta unless provided", () => {
    expect(apiSuccess({ ok: true }, "req_1")).toEqual({ data: { ok: true }, requestId: "req_1" });
    expect("meta" in apiSuccess(1, "req_2")).toBe(false);
    expect(apiSuccess(1, "req_2", { page: 2 }).meta).toEqual({ page: 2 });
  });

  it("apiError nests code/message/requestId under error", () => {
    expect(apiError("rate_limited", "slow down", "req_9")).toEqual({
      error: { code: "rate_limited", message: "slow down", requestId: "req_9" },
    });
  });

  it("API_RESPONSE_ENVELOPE documents the same shapes the helpers produce", () => {
    expect(API_RESPONSE_ENVELOPE.successFormat).toContain("data");
    expect(API_RESPONSE_ENVELOPE.successFormat).toContain("requestId");
    expect(API_RESPONSE_ENVELOPE.errorFormat).toContain("error");
    expect(Object.keys(apiSuccess(1, "r"))).toEqual(Object.keys({ data: 1, requestId: "r" }));
    expect(Object.keys(apiError("c", "m", "r").error)).toEqual(["code", "message", "requestId"]);
  });

  it("error codes are unique snake_case strings", () => {
    const codes = Object.values(API_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z_]+$/);
  });
});
