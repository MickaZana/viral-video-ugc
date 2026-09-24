import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgencyClient } from "@vvugc/shared-auth";
import type { PipelineJob, PipelineJobStore } from "@vvugc/review-queue";
import type { BillingRepository } from "./billing-postgres.js";
import type { TenantProfileRepository } from "./tenant-profile-postgres.js";

// Every real dependency mocked except runDueClientSchedules/startClientScheduler
// themselves — this file's own job is the scheduling decision (which clients
// fire, what config they get enqueued with, how billing reservation/release is
// sequenced), not the job store or billing implementations, which have their
// own test coverage.
const enqueueMock = vi.fn<(...args: unknown[]) => Promise<PipelineJob>>();
vi.mock("./jobs.js", () => ({
  createPipelineJobStore: () => ({ enqueue: (...args: unknown[]) => enqueueMock(...args) } as Partial<PipelineJobStore>)
}));

const isLLMLiveMock = vi.fn<() => boolean>();
vi.mock("./llm-gate.js", () => ({
  isLLMLive: () => isLLMLiveMock()
}));

const { runDueClientSchedules, startClientScheduler } = await import("./scheduler.js");

function fakeProfiles(due: AgencyClient[]): TenantProfileRepository {
  return {
    clientClaimDue: vi.fn(async () => due)
  } as unknown as TenantProfileRepository;
}

function fakeBilling(overrides: Partial<BillingRepository> = {}): BillingRepository {
  return {
    reserveRun: vi.fn(async () => ({ orgId: "org-1", runId: "r", reservedAt: new Date().toISOString() })),
    releaseReservation: vi.fn(async () => true),
    ...overrides
  } as unknown as BillingRepository;
}

function dueClient(overrides: Partial<AgencyClient> = {}): AgencyClient {
  return {
    id: "client-1",
    orgId: "org-1",
    name: "Test Client",
    niche: "fitness",
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    platforms: ["youtube_shorts"],
    targetDurationSec: 25,
    videoVendor: "kling",
    cadence: "weekly",
    active: true,
    nextRunAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  enqueueMock.mockReset();
  isLLMLiveMock.mockReset();
  isLLMLiveMock.mockReturnValue(false);
  delete process.env.SCHEDULED_RUNS_LIVE;
  process.env.VVUGC_RUNS_DIR = "/tmp/vvugc-scheduler-test"; // never actually written to — jobs.js is mocked
});

afterEach(() => {
  delete process.env.VVUGC_RUNS_DIR;
  delete process.env.SCHEDULED_RUNS_LIVE;
});

describe("runDueClientSchedules", () => {
  it("enqueues exactly the clients profiles.clientClaimDue returns as due", async () => {
    const client = dueClient();
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);
    const billing = fakeBilling();

    const result = await runDueClientSchedules(fakeProfiles([client]), undefined, new Date(), billing);

    expect(result.claimed).toBe(1);
    expect(result.enqueued).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [orgId, clientId] = enqueueMock.mock.calls[0] as [string, string, unknown, string];
    expect(orgId).toBe(client.orgId);
    expect(clientId).toBe(client.id);
  });

  it("enqueues nothing when no client is due", async () => {
    const billing = fakeBilling();

    const result = await runDueClientSchedules(fakeProfiles([]), undefined, new Date(), billing);

    expect(result.claimed).toBe(0);
    expect(result.enqueued).toEqual([]);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("passes orgId through to clientClaimDue for org-scoped scheduling", async () => {
    const profiles = fakeProfiles([]);

    await runDueClientSchedules(profiles, "org-42", new Date(), fakeBilling());

    expect(profiles.clientClaimDue).toHaveBeenCalledWith(expect.any(Date), "org-42");
  });

  it("builds a dry-run config by default — SCHEDULED_RUNS_LIVE unset", async () => {
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);

    await runDueClientSchedules(fakeProfiles([dueClient()]), undefined, new Date(), fakeBilling());

    const config = enqueueMock.mock.calls[0]?.[2] as { dryRun: boolean };
    expect(config.dryRun).toBe(true);
  });

  it("stays dry-run when SCHEDULED_RUNS_LIVE=true but the LLM governance gate is still off", async () => {
    process.env.SCHEDULED_RUNS_LIVE = "true";
    isLLMLiveMock.mockReturnValue(false);
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);

    await runDueClientSchedules(fakeProfiles([dueClient()]), undefined, new Date(), fakeBilling());

    const config = enqueueMock.mock.calls[0]?.[2] as { dryRun: boolean };
    expect(config.dryRun).toBe(true);
  });

  it("goes live only when both SCHEDULED_RUNS_LIVE=true AND isLLMLive() are true", async () => {
    process.env.SCHEDULED_RUNS_LIVE = "true";
    isLLMLiveMock.mockReturnValue(true);
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);

    await runDueClientSchedules(fakeProfiles([dueClient()]), undefined, new Date(), fakeBilling());

    const config = enqueueMock.mock.calls[0]?.[2] as { dryRun: boolean };
    expect(config.dryRun).toBe(false);
  });

  it("produces the same idempotency-derived runId for the same client + nextRunAt, twice", async () => {
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);
    const client = dueClient({ nextRunAt: "2026-01-01T00:00:00.000Z" });

    await runDueClientSchedules(fakeProfiles([client]), undefined, new Date(), fakeBilling());
    await runDueClientSchedules(fakeProfiles([client]), undefined, new Date(), fakeBilling());

    const runId1 = (enqueueMock.mock.calls[0]?.[2] as { runId: string }).runId;
    const runId2 = (enqueueMock.mock.calls[1]?.[2] as { runId: string }).runId;
    expect(runId1).toBe(runId2);
  });

  it("reserves billing before enqueue and releases the reservation if enqueue throws", async () => {
    enqueueMock.mockRejectedValue(new Error("store unavailable"));
    const billing = fakeBilling();

    const result = await runDueClientSchedules(fakeProfiles([dueClient()]), undefined, new Date(), billing);

    expect(billing.reserveRun).toHaveBeenCalledTimes(1);
    expect(billing.releaseReservation).toHaveBeenCalledTimes(1);
    expect(result.enqueued).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.clientId).toBe("client-1");
    expect(result.failed[0]?.error).toContain("store unavailable");
  });

  it("does not release a reservation that was never taken when reserveRun itself throws", async () => {
    const billing = fakeBilling({ reserveRun: vi.fn(async () => { throw new Error("quota exceeded"); }) });

    const result = await runDueClientSchedules(fakeProfiles([dueClient()]), undefined, new Date(), billing);

    expect(billing.releaseReservation).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(result.failed[0]?.error).toContain("quota exceeded");
  });

  it("continues to the next client after one client's enqueue fails", async () => {
    const good = dueClient({ id: "client-good" });
    const bad = dueClient({ id: "client-bad" });
    enqueueMock.mockImplementation(async (_orgId, clientId) =>
      clientId === "client-bad"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ id: "job-good" } as PipelineJob)
    );

    const result = await runDueClientSchedules(fakeProfiles([bad, good]), undefined, new Date(), fakeBilling());

    expect(result.claimed).toBe(2);
    expect(result.enqueued).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.clientId).toBe("client-bad");
  });

  it("carries the client's niche/brandVoice/platforms/videoVendor/voiceVendor through to the enqueued config", async () => {
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);
    const client = dueClient({
      niche: "skincare",
      brandVoice: "playful, punchy",
      platforms: ["youtube_shorts"],
      videoVendor: "replicate",
      voiceVendor: "elevenlabs"
    });

    await runDueClientSchedules(fakeProfiles([client]), undefined, new Date(), fakeBilling());

    const config = enqueueMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(config.niche).toBe("skincare");
    expect(config.brandVoice).toBe("playful, punchy");
    expect(config.platforms).toEqual(["youtube_shorts"]);
    expect(config.videoVendor).toBe("replicate");
    expect(config.voiceVendor).toBe("elevenlabs");
  });
});

describe("startClientScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks runDueClientSchedules on the given interval and unrefs the timer", async () => {
    enqueueMock.mockResolvedValue({ id: "job-1" } as PipelineJob);
    const profiles = fakeProfiles([dueClient()]);
    const billing = fakeBilling();

    const timer = startClientScheduler(profiles, 1000, billing);

    expect(profiles.clientClaimDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(profiles.clientClaimDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(profiles.clientClaimDue).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  it("does not throw the process down when a tick's promise rejects", async () => {
    const profiles = {
      clientClaimDue: vi.fn(async () => { throw new Error("db unavailable"); })
    } as unknown as TenantProfileRepository;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const timer = startClientScheduler(profiles, 1000, fakeBilling());
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorSpy).toHaveBeenCalledWith("client scheduler tick failed", expect.any(Error));
    clearInterval(timer);
    errorSpy.mockRestore();
  });
});
