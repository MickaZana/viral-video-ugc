export interface FetchWithRetryOptions extends RequestInit {
  /** Aborts the request after this many ms. Default 30s. */
  timeoutMs?: number;
  /** Additional attempts after the first, on a thrown error (network failure, timeout). Default 2 (3 attempts total). */
  retries?: number;
  /** Base delay before the first retry; doubles each subsequent attempt. Default 250ms. */
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fetch` with a hard timeout and retry-on-failure — none of this repo's vendor
 * adapters (Kling/Runway/Pika/Higgsfield video download, Whisper ASR, YouTube
 * Data API) had either, so a single hung connection or transient network blip
 * could block a pipeline run indefinitely or fail a whole candidate for no
 * reason worth failing over.
 *
 * Deliberately does NOT retry on a non-ok HTTP response (4xx/5xx) — every
 * call site already has its own status-code handling (envelope error codes,
 * vendor-specific messages), and retrying there would duplicate/override that
 * logic in ways specific to each vendor's API shape. This only retries
 * transport-level failures: the request never got a response at all (network
 * error, DNS failure, or our own timeout aborting it).
 */
export async function fetchWithRetry(url: string | URL, options: FetchWithRetryOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, retries = 2, retryDelayMs = 250, ...init } = options;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
          : err;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
}
