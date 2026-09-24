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

  it("deadlineMs ends the loop (undefined) before maxAttempts when the deadline is hit first", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const promise = pollWithBackoff(check, {
      initialDelayMs: 2000,
      maxDelayMs: 15000,
      factor: 1.5,
      maxAttempts: 100,
      deadlineMs: 10_000
    });

    // Backoff sleeps 2000, 3000, 4500, then the 4th is clamped 6750 -> 500 to
    // land exactly on the 10s deadline; checks fire at t = 0, 2000, 5000, 9500,
    // 10000 -> 5 total, and the 6th iteration's `remaining <= 0` ends the loop.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await promise).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(5);
  });

  it("maxAttempts still ends the loop before a generous deadline when attempts run out first", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const promise = pollWithBackoff(check, {
      maxAttempts: 3,
      initialDelayMs: 100,
      deadlineMs: 10_000_000
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);

    expect(await promise).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("returns a value that resolves before the deadline without over-waiting", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("done");
    const promise = pollWithBackoff(check, { initialDelayMs: 1000, deadlineMs: 60_000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(await promise).toBe("done");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("clamps the final sleep so it never overshoots the deadline", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const promise = pollWithBackoff(check, {
      initialDelayMs: 2000,
      maxDelayMs: 15000,
      factor: 1.5,
      maxAttempts: 100,
      deadlineMs: 10_000
    });

    // Just under the deadline: checks so far at t = 0, 2000, 5000, 9500 (4),
    // and the clamped 500ms sleep that lands on t = 10000 is still pending.
    await vi.advanceTimersByTimeAsync(9999);
    expect(check).toHaveBeenCalledTimes(4);

    // The remaining 1ms completes that clamped sleep -> one last check at the
    // boundary, then the loop gives up.
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(5);
  });
});
