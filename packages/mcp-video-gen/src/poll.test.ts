import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWithBackoff } from "./poll.js";

describe("pollWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when check() succeeds on the first attempt, no delay incurred", async () => {
    const check = vi.fn().mockResolvedValue("done");
    const result = await pollWithBackoff(check);
    expect(result).toBe("done");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("retries with increasing delay until check() returns a defined value", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("done");

    const promise = pollWithBackoff(check, { initialDelayMs: 1000, factor: 2 });

    await vi.advanceTimersByTimeAsync(1000); // after attempt 1's delay
    await vi.advanceTimersByTimeAsync(2000); // after attempt 2's delay (1000 * 2)

    expect(await promise).toBe("done");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("caps delay at maxDelayMs rather than growing unbounded", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const promise = pollWithBackoff(check, {
      initialDelayMs: 1000,
      factor: 10,
      maxDelayMs: 3000,
      maxAttempts: 4
    });

    // delays: 1000, then min(10000,3000)=3000, then min(30000,3000)=3000
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await promise).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("gives up after maxAttempts and returns undefined without an extra trailing delay", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const promise = pollWithBackoff(check, { maxAttempts: 3, initialDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);

    expect(await promise).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("propagates a thrown error from check() immediately, without retrying", async () => {
    const check = vi.fn().mockRejectedValue(new Error("job failed"));
    await expect(pollWithBackoff(check)).rejects.toThrow("job failed");
    expect(check).toHaveBeenCalledTimes(1);
  });
});
