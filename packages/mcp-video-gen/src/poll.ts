export interface PollOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
}

/**
 * Polls `check()` until it returns a defined result, backing off exponentially
 * between attempts (capped at maxDelayMs) instead of a fixed interval — every
 * vendor adapter previously polled every 5s regardless of how long the job had
 * been running, which wastes calls early on (most jobs aren't done in 5s) and
 * doesn't adapt when a job is running unusually slow. `check()` should return
 * `undefined` while still pending and throw on a definitive failure — this
 * only handles the "still waiting" backoff, not error classification.
 */
export async function pollWithBackoff<T>(
  check: () => Promise<T | undefined>,
  opts: PollOptions = {}
): Promise<T | undefined> {
  const { maxAttempts = 20, initialDelayMs = 2000, maxDelayMs = 15000, factor = 1.5 } = opts;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await check();
    if (result !== undefined) return result;
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * factor, maxDelayMs);
    }
  }
  return undefined;
}
