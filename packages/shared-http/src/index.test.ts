import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./index.js";

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Simulates a real fetch that respects the AbortSignal it's given. */
function abortAwareFetch(run: (signal: AbortSignal) => Promise<Response>) {
  return vi.fn((_url: string | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(abortError()));
      run(signal!).then(resolve, reject);
    });
  });
}

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the response on first success, without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.com");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a non-ok HTTP response — returns it as-is for the caller to handle", async () => {
    const fetchMock = vi.fn(async () => new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.com", { retries: 3 });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on a thrown network error and succeeds once the connection recovers", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNRESET");
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.com", { retries: 3, retryDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws the last error once retries are exhausted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("https://example.com", { retries: 2, retryDelayMs: 1 })).rejects.toThrow(
      "ECONNRESET"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("aborts a hung request after timeoutMs and surfaces a clear timeout error", async () => {
    vi.useFakeTimers();
    const fetchMock = abortAwareFetch(() => new Promise<Response>(() => {})); // never resolves on its own
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry("https://example.com", { timeoutMs: 5000, retries: 0 });
    const assertion = expect(promise).rejects.toThrow(/timed out after 5000ms/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("defaults to 3 total attempts (1 + 2 retries) when retries is unset", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("https://example.com", { retryDelayMs: 1 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("passes through request init (method, headers, body) unchanged", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://example.com", {
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload"
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "X-Test": "1" });
    expect(init?.body).toBe("payload");
  });
});
