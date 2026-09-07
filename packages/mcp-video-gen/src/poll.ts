export interface PollOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /**
   * Optional overall wall-clock budget in milliseconds, measured from entry
   * (just before the first `check()`). When set, the loop gives up as soon as
   * `Date.now() - start >= deadlineMs` OR `maxAttempts` is reached — whichever
   * comes first — and returns `undefined` on either bound (same contract as
   * running out of attempts: a defined result means success, `undefined` means
   * "gave up"). The loop never sleeps past the deadline: the final backoff sleep
   * is clamped to the time remaining, so one last `check()` runs right at the
   * boundary before giving up. When unset, bounding is by `maxAttempts` alone
   * and behaviour is byte-identical to before this option existed.
   */
  deadlineMs?: number;
}

/**
 * Polls `check()` until it returns a defined result, backing off exponentially
 * between attempts (capped at maxDelayMs) instead of a fixed interval — every
 * vendor adapter previously polled every 5s regardless of how long the job had
 * been running, which wastes calls early on (most jobs aren't done in 5s) and
 * doesn't adapt when a job is running unusually slow. `check()` should return
 * `undefined` while still pending and throw on a definitive failure — this
 * only handles the "still waiting" backoff, not error classification.
 *
 * Giving up is bounded by `maxAttempts` and, when `opts.deadlineMs` is set, by
 * an overall wall-clock budget (whichever is hit first); both bounds return
 * `undefined`. See `PollOptions.deadlineMs`.
 */
export async function pollWithBackoff<T>(
  check: () => Promise<T | undefined>,
  opts: PollOptions = {}
): Promise<T | undefined> {
  const { maxAttempts = 20, initialDelayMs = 2000, maxDelayMs = 15000, factor = 1.5, deadlineMs } = opts;
  let delay = initialDelayMs;
  const start = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await check();
    if (result !== undefined) return result;
    if (attempt >= maxAttempts - 1) break;

    if (deadlineMs !== undefined) {
      const remaining = deadlineMs - (Date.now() - start);
      if (remaining <= 0) break;
      // Clamp the final sleep so we never wait past the deadline; the next
      // iteration's check() then runs at the boundary and the `remaining <= 0`
      // guard above ends the loop.
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    } else {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    delay = Math.min(delay * factor, maxDelayMs);
  }
  return undefined;
}
