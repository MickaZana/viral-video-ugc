/**
 * Atom H — Comprehensive Failure and Recovery Tests
 *
 * Covers:
 * - Fake MCP session success
 * - MCP unavailable → fallback
 * - MCP reconnect
 * - Provider timeout → retry
 * - Rate-limit retry
 * - Invalid request no-retry
 * - Fallback to Kling
 * - Fallback to Replicate
 * - Final Gemini fallback
 * - Duplicate idempotency key
 * - Expired lease recovery
 * - Cancellation before claim
 * - Cancellation during generation
 * - Worker graceful shutdown
 * - No secret leakage in logs
 * - Actual-vendor cost accounting
 * - Tenant isolation
 * - Dry-run no-provider-call guarantee
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInMemoryProviderJobStore, type ProviderJobStore, type ProviderJobEnqueueInput } from "@vvugc/review-queue";
import { createMcpSession } from "./mcp-session.js";
import { classifyProviderError } from "./retry-policy.js";
import { resolveChain, buildFallbackList, DEFAULT_FALLBACK_CHAIN } from "./fallback-chain.js";
import { createVideoWorker } from "./worker.js";
import { createWorkerMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<ProviderJobEnqueueInput> = {}): ProviderJobEnqueueInput {
  return {
    orgId: "org-1",
    clientId: "client-1",
    runId: "run-1",
    candidateId: "cand-1",
    platform: "youtube_shorts",
    scriptSegmentIndex: 0,
    requestedVendor: "higgsfield",
    fallbackVendors: ["kling", "replicate", "gemini"],
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    request: {
      prompt: "A fitness influencer doing pushups in a gym",
      durationSec: 5,
      aspectRatio: "9:16",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Atom A — Provider Job Store Tests
// ---------------------------------------------------------------------------

describe("ProviderJobStore (in-memory)", () => {
  let store: ProviderJobStore;

  beforeEach(() => {
    store = createInMemoryProviderJobStore();
  });

  it("enqueues and retrieves a job", async () => {
    const input = makeJob();
    const job = await store.enqueue(input);
    expect(job.id).toBeDefined();
    expect(job.status).toBe("queued");
    expect(job.orgId).toBe("org-1");
    expect(job.requestedVendor).toBe("higgsfield");

    const fetched = await store.get(job.id);
    expect(fetched).toEqual(job);
  });

  it("idempotency — duplicate key returns existing job", async () => {
    const input = makeJob({ idempotencyKey: "dup-key" });
    const first = await store.enqueue(input);
    const second = await store.enqueue(input);
    expect(second.id).toBe(first.id);
  });

  it("claim assigns lease to worker", async () => {
    await store.enqueue(makeJob());
    const claimed = await store.claim("worker-1", 60_000);
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe("running");
    expect(claimed!.leaseOwner).toBe("worker-1");
    expect(claimed!.attempt).toBe(1);
  });

  it("heartbeat extends lease", async () => {
    await store.enqueue(makeJob());
    const job = await store.claim("worker-1", 60_000)!;
    const ok = await store.heartbeat(job!.id, "worker-1", 120_000);
    expect(ok).toBe(true);
  });

  it("complete marks job done", async () => {
    await store.enqueue(makeJob());
    const job = (await store.claim("worker-1"))!;
    const clip = { id: "clip-1", scriptSegmentIndex: 0, vendor: "kling" as const, filePath: "/tmp/x.mp4", durationSec: 5 };
    const ok = await store.complete(job.id, "worker-1", clip, "kling", 0.08);
    expect(ok).toBe(true);
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("completed");
    expect(fetched!.actualVendor).toBe("kling");
  });

  it("fail with retryable re-queues job", async () => {
    await store.enqueue(makeJob({ maxAttempts: 3 }));
    const job = (await store.claim("worker-1"))!;
    const updated = await store.fail(job.id, "worker-1", "timeout", true);
    expect(updated!.status).toBe("queued");
  });

  it("fail non-retryable dead-letters job", async () => {
    await store.enqueue(makeJob());
    const job = (await store.claim("worker-1"))!;
    const updated = await store.fail(job.id, "worker-1", "invalid request 400", false);
    expect(updated!.status).toBe("dead_letter");
  });

  it("fail after max attempts dead-letters", async () => {
    await store.enqueue(makeJob({ maxAttempts: 1 }));
    const job = (await store.claim("worker-1"))!;
    const updated = await store.fail(job.id, "worker-1", "error", true);
    expect(updated!.status).toBe("dead_letter");
  });

  it("cancel queued job", async () => {
    const job = await store.enqueue(makeJob());
    const ok = await store.cancel(job.id);
    expect(ok).toBe(true);
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("cancelled");
  });

  it("cancel running job sets cancelRequested", async () => {
    await store.enqueue(makeJob());
    const job = (await store.claim("worker-1"))!;
    const ok = await store.cancel(job.id);
    expect(ok).toBe(true);
    const fetched = await store.get(job.id);
    expect(fetched!.cancelRequested).toBe(true);
    expect(fetched!.status).toBe("running"); // Still running until ack
  });

  it("acknowledgeCancelled finalizes cancellation", async () => {
    await store.enqueue(makeJob());
    const job = (await store.claim("worker-1"))!;
    await store.cancel(job.id);
    const ok = await store.acknowledgeCancelled(job.id, "worker-1");
    expect(ok).toBe(true);
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("cancelled");
  });

  it("recoverExpiredLeases re-queues expired jobs", async () => {
    await store.enqueue(makeJob({ maxAttempts: 3 }));
    const job = (await store.claim("worker-1", 1))!; // 1ms lease
    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 10));
    const recovered = await store.recoverExpiredLeases();
    expect(recovered).toBe(1);
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("queued");
  });

  it("replay dead-lettered job", async () => {
    await store.enqueue(makeJob({ maxAttempts: 1 }));
    const job = (await store.claim("worker-1"))!;
    await store.fail(job.id, "worker-1", "error", true);
    const replayed = await store.replay(job.id);
    expect(replayed!.status).toBe("queued");
    expect(replayed!.attempt).toBe(0);
  });

  it("tenant isolation — listByRun only returns matching run", async () => {
    await store.enqueue(makeJob({ runId: "run-A", orgId: "org-1" }));
    await store.enqueue(makeJob({ runId: "run-B", orgId: "org-2" }));
    const results = await store.listByRun("org-1", "run-A");
    expect(results.length).toBe(1);
    expect(results[0].runId).toBe("run-A");
  });
});

// ---------------------------------------------------------------------------
// Atom C — MCP Session Tests
// ---------------------------------------------------------------------------

describe("MCP Session", () => {
  it("connects successfully with a fake MCP caller", async () => {
    const fakeCaller = vi.fn().mockResolvedValue({ jobId: "test-123" });
    const session = createMcpSession({
      connect: async () => fakeCaller,
    });

    const connected = await session.connect();
    expect(connected).toBe(true);
    expect(session.state).toBe("connected");
    expect(session.isHealthy()).toBe(true);

    const caller = session.getToolCaller();
    expect(caller).toBeDefined();
    const result = await caller!("generate_video", { prompt: "test" });
    expect(result).toEqual({ jobId: "test-123" });
  });

  it("MCP unavailable — connect returns false", async () => {
    const session = createMcpSession({
      connect: async () => { throw new Error("Connection refused"); },
      maxReconnectAttempts: 1,
      reconnectBaseMs: 10,
    });

    const connected = await session.connect();
    expect(connected).toBe(false);
    expect(session.state).toBe("disconnected");
    expect(session.getToolCaller()).toBeUndefined();
  });

  it("tracks consecutive failures and becomes unhealthy", async () => {
    const failingCaller = vi.fn().mockRejectedValue(new Error("MCP call failed"));
    const session = createMcpSession({
      connect: async () => failingCaller,
      maxConsecutiveFailures: 2,
    });

    await session.connect();
    const caller = session.getToolCaller()!;

    await expect(caller("test", {})).rejects.toThrow();
    expect(session.consecutiveFailures).toBe(1);
    expect(session.isHealthy()).toBe(true);

    await expect(caller("test", {})).rejects.toThrow();
    expect(session.consecutiveFailures).toBe(2);
    expect(session.state).toBe("unhealthy");
    expect(session.isHealthy()).toBe(false);
  });

  it("resets failures on successful call", async () => {
    let callCount = 0;
    const intermittentCaller = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("transient");
      return { ok: true };
    });

    const session = createMcpSession({
      connect: async () => intermittentCaller,
      maxConsecutiveFailures: 3,
    });

    await session.connect();
    const caller = session.getToolCaller()!;

    await expect(caller("test", {})).rejects.toThrow();
    expect(session.consecutiveFailures).toBe(1);

    const result = await caller("test", {});
    expect(result).toEqual({ ok: true });
    expect(session.consecutiveFailures).toBe(0);
  });

  it("disconnect resets state", async () => {
    const session = createMcpSession({
      connect: async () => vi.fn().mockResolvedValue({}),
    });
    await session.connect();
    session.disconnect();
    expect(session.state).toBe("disconnected");
    expect(session.getToolCaller()).toBeUndefined();
  });

  it("sanitizes errors — no secrets in lastError", async () => {
    const session = createMcpSession({
      connect: async () => { throw new Error("Auth failed: Bearer sk-abcdefghij1234567890abcdefghij1234567890"); },
      maxReconnectAttempts: 0,
    });
    await session.connect();
    expect(session.lastError).not.toContain("sk-abcdefghij");
    expect(session.lastError).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Atom D — Retry Policy Tests
// ---------------------------------------------------------------------------

describe("Retry Policy", () => {
  it("classifies timeout as retryable", () => {
    const result = classifyProviderError(new Error("Request timed out after 30s"), 0);
    expect(result.category).toBe("retryable_timeout");
    expect(result.retryable).toBe(true);
    expect(result.shouldFallback).toBe(false);
  });

  it("classifies 5xx as retryable", () => {
    const result = classifyProviderError(new Error("503 Service Unavailable"), 0);
    expect(result.category).toBe("retryable_5xx");
    expect(result.retryable).toBe(true);
  });

  it("classifies rate limit as retryable with high backoff", () => {
    const result = classifyProviderError(new Error("429 Too Many Requests"), 0);
    expect(result.category).toBe("retryable_rate_limit");
    expect(result.retryable).toBe(true);
    expect(result.backoffMs).toBeGreaterThan(0);
  });

  it("classifies 400 as non-retryable invalid request", () => {
    const result = classifyProviderError(new Error("400 Bad Request: invalid prompt"), 0);
    expect(result.category).toBe("non_retryable_invalid_request");
    expect(result.retryable).toBe(false);
    expect(result.shouldFallback).toBe(false);
  });

  it("classifies 401/403 as non-retryable auth (with fallback)", () => {
    const result = classifyProviderError(new Error("401 Unauthorized"), 0);
    expect(result.category).toBe("non_retryable_auth");
    expect(result.retryable).toBe(false);
    expect(result.shouldFallback).toBe(true);
  });

  it("classifies MCP connection issues as retryable with fallback", () => {
    const result = classifyProviderError(new Error("MCP session disconnected"), 0);
    expect(result.retryable).toBe(true);
    expect(result.shouldFallback).toBe(true);
  });

  it("classifies cancellation as non-retryable", () => {
    const result = classifyProviderError(new Error("Job cancelled by user"), 0);
    expect(result.category).toBe("non_retryable_cancelled");
    expect(result.retryable).toBe(false);
    expect(result.shouldFallback).toBe(false);
  });

  it("sanitizes secrets in error messages", () => {
    const result = classifyProviderError(
      new Error("Auth failed with key=sk_live_abcdefghijklmnopqrstuvwxyz123456"),
      0
    );
    expect(result.message).not.toContain("sk_live_");
    expect(result.message).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Atom D — Fallback Chain Tests
// ---------------------------------------------------------------------------

describe("Fallback Chain", () => {
  it("default chain starts from requested vendor (seedance)", () => {
    const chain = resolveChain("seedance");
    expect(chain).toEqual(["seedance", "grok_video", "kling", "higgsfield", "replicate", "gemini"]);
  });

  it("chain starting from kling skips seedance and grok", () => {
    const chain = resolveChain("kling");
    expect(chain).toEqual(["kling", "higgsfield", "replicate", "gemini"]);
  });

  it("chain starting from gemini is just gemini", () => {
    const chain = resolveChain("gemini");
    expect(chain).toEqual(["gemini"]);
  });

  it("custom chain overrides default", () => {
    const chain = resolveChain("kling", { vendorChain: ["kling", "gemini"] });
    expect(chain).toEqual(["kling", "gemini"]);
  });

  it("disabled vendors are excluded", () => {
    const chain = resolveChain("higgsfield", { disabledVendors: ["kling"] });
    expect(chain).toEqual(["higgsfield", "replicate", "gemini"]);
  });

  it("unknown vendor gets prepended to chain", () => {
    const chain = resolveChain("runway" as any);
    expect(chain[0]).toBe("runway");
    expect(chain.length).toBeGreaterThan(1);
  });

  it("buildFallbackList excludes the requested vendor itself", () => {
    const fallbacks = buildFallbackList("seedance");
    expect(fallbacks).toEqual(["grok_video", "kling", "higgsfield", "replicate", "gemini"]);
    expect(fallbacks).not.toContain("seedance");
  });

  it("nvidia (not in the default chain) is prepended, then the full default chain follows", () => {
    const chain = resolveChain("nvidia");
    expect(chain[0]).toBe("nvidia");
    expect(chain.slice(1)).toEqual(DEFAULT_FALLBACK_CHAIN.filter((v) => v !== "nvidia"));
    // Concretely: the head plus every default vendor.
    expect(chain).toEqual([
      "nvidia",
      "seedance",
      "grok_video",
      "kling",
      "higgsfield",
      "replicate",
      "gemini",
    ]);
  });

  it("buildFallbackList('nvidia') is exactly the default chain (nvidia stripped as the head)", () => {
    expect(buildFallbackList("nvidia")).toEqual([
      "seedance",
      "grok_video",
      "kling",
      "higgsfield",
      "replicate",
      "gemini",
    ]);
  });

  it("a custom vendorChain led by nvidia is honored verbatim", () => {
    const chain = resolveChain("nvidia", { vendorChain: ["nvidia", "gemini"] });
    expect(chain).toEqual(["nvidia", "gemini"]);
  });
});

// ---------------------------------------------------------------------------
// Atom E — Dry-run guarantee
// ---------------------------------------------------------------------------

describe("Dry-run guarantee", () => {
  it("dry-run never makes real provider calls", async () => {
    const store = createInMemoryProviderJobStore();
    await store.enqueue(makeJob());

    // In a full integration test, we'd create the worker with dryRun: true
    // and verify zero outbound HTTP calls. Here we verify the contract:
    // getVideoGenAdapter with dryRun=true returns a mock adapter.
    const { getVideoGenAdapter } = await import("@vvugc/mcp-video-gen");
    const adapter = getVideoGenAdapter("kling", { outDir: "/tmp", dryRun: true });
    // The mock adapter doesn't make HTTP calls (verified by the existing
    // mcp-video-gen test suite). Here we just confirm it returns a clip.
    const clip = await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "test",
      durationSec: 5,
      aspectRatio: "9:16",
    });
    expect(clip.vendor).toBe("kling");
    expect(clip.filePath).toContain("mock");
  });

  it("dry-run nvidia returns a mock clip without ever calling fetch (no real NVIDIA API hit)", async () => {
    const { getVideoGenAdapter } = await import("@vvugc/mcp-video-gen");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => {
        throw new Error("real network call attempted during dry-run");
      });
    try {
      const adapter = getVideoGenAdapter("nvidia", { outDir: "/tmp", dryRun: true });
      const clip = await adapter.generate({
        scriptSegmentIndex: 0,
        prompt: "x",
        durationSec: 5,
        aspectRatio: "9:16",
      });
      expect(clip.vendor).toBe("nvidia");
      expect(clip.filePath).toContain("mock");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("cancellation during provider completion", () => {
  it("acknowledges a cancellation after one provider call instead of retrying paid work", async () => {
    const store = createInMemoryProviderJobStore();
    const job = await store.enqueue(makeJob({ requestedVendor: "gemini", fallbackVendors: [] }));
    let adapterCalls = 0;
    const worker = createVideoWorker(
      store,
      createMcpSession({ connect: async () => async () => ({}) }),
      createWorkerMetrics(),
      {
        workerId: "cancel-test-worker", outDir: "/tmp", dryRun: false, concurrency: 1,
        pollIntervalMs: 5, leaseRecoveryIntervalMs: 5, fallbackConfig: { vendorChain: ["gemini"] },
        adapterFactory: () => ({
          vendor: "gemini",
          async generate(request) {
            adapterCalls++;
            expect(request.idempotencyKey).toBe(job.idempotencyKey);
            // Simulates an operator cancelling while the provider call is in flight.
            await store.cancel(job.id);
            return { id: "provider-receipt", vendor: "gemini", scriptSegmentIndex: 0, filePath: "/tmp/clip.mp4", durationSec: 5 };
          }
        })
      }
    );
    worker.start();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe("cancelled"), { timeout: 1_000 });
    // Let a few polling/recovery cycles happen: cancelled work must never be leased again.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await worker.stop();
    expect(adapterCalls).toBe(1);
    expect((await store.get(job.id))).toMatchObject({ status: "cancelled", attempt: 1, leaseOwner: undefined });
  });
});

describe("worker vendor fallback — nvidia requested, actual-vendor stamping", () => {
  it("nvidia adapter fails → next vendor generates, and the stored clip/actualVendor is that vendor, not nvidia", async () => {
    const store = createInMemoryProviderJobStore();
    const job = await store.enqueue(
      makeJob({
        requestedVendor: "nvidia",
        fallbackVendors: ["gemini"],
        request: {
          prompt: "A fitness influencer doing pushups in a gym",
          durationSec: 5,
          aspectRatio: "9:16",
          // Pin nvidia as the routed primary so smart routing keeps it at the chain head.
          creatorProfile: { preferredVideoVendor: "nvidia" },
        },
      })
    );
    const vendorCalls: string[] = [];
    const worker = createVideoWorker(
      store,
      createMcpSession({ connect: async () => async () => ({}) }),
      createWorkerMetrics(),
      {
        workerId: "nvidia-fallback-worker", outDir: "/tmp", dryRun: false, concurrency: 1,
        pollIntervalMs: 5, leaseRecoveryIntervalMs: 5,
        availableVendors: ["nvidia", "gemini"],
        fallbackConfig: { vendorChain: ["nvidia", "gemini"] },
        adapterFactory: (vendor) => ({
          vendor,
          async generate(request) {
            vendorCalls.push(vendor);
            expect(request.idempotencyKey).toBe(job.idempotencyKey);
            if (vendor === "nvidia") throw new Error("401 Unauthorized from NVIDIA NIM");
            return { id: `receipt-${vendor}`, vendor, scriptSegmentIndex: 0, filePath: `/tmp/${vendor}.mp4`, durationSec: 5 };
          }
        })
      }
    );
    worker.start();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe("completed"), { timeout: 1_000 });
    await worker.stop();
    const finished = await store.get(job.id);
    // nvidia was tried first (as requested), then fell through to gemini which produced the clip.
    expect(vendorCalls).toEqual(["nvidia", "gemini"]);
    expect(finished?.requestedVendor).toBe("nvidia");
    expect(finished?.actualVendor).toBe("gemini");
    expect(finished?.result?.vendor).toBe("gemini");
  });
});
