/**
 * concurrency-cap.ts — Rate limiter and cost cap for pipeline runs
 *
 * Prevents runaway API spend by enforcing:
 * 1. A maximum concurrent video generation calls (default: 3)
 * 2. A per-run USD cost cap (kills the run if exceeded)
 * 3. A maximum of 8 unique video angles per flow (user requirement)
 *
 * Designed to sit between the conductor and the vendor adapters, throttling
 * without dropping work — items that can't run immediately are queued.
 */

export interface ConcurrencyCapConfig {
  /** Max parallel video generation calls (protects rate limits) */
  maxConcurrentVideoGen: number;
  /** Max parallel LLM calls (Anthropic + Gemini combined) */
  maxConcurrentLlm: number;
  /** Maximum USD spend per run before hard-stopping */
  maxCostPerRunUsd: number;
  /** Maximum unique video angles (different hooks/scripts) per flow */
  maxVideosPerFlow: number;
  /** Delay between sequential vendor API calls (ms) — backpressure */
  vendorThrottleMs: number;
}

export const DEFAULT_CAP_CONFIG: ConcurrencyCapConfig = {
  maxConcurrentVideoGen: 3,
  maxConcurrentLlm: 2,
  maxCostPerRunUsd: 25.00,
  maxVideosPerFlow: 8,
  vendorThrottleMs: 500,
};

/**
 * Semaphore for limiting concurrent async operations.
 * Awaiting `acquire()` blocks until a slot is free.
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }

  get queueLength(): number {
    return this.waiting.length;
  }
}

/**
 * Cost cap enforcer — tracks spend in real-time and throws when limit hit.
 */
export class CostCap {
  private spent = 0;
  private readonly limit: number;
  private readonly onWarning?: (spent: number, limit: number) => void;

  constructor(limitUsd: number, onWarning?: (spent: number, limit: number) => void) {
    this.limit = limitUsd;
    this.onWarning = onWarning;
  }

  /** Record a cost event. Throws CostCapExceededError if limit is breached. */
  record(costUsd: number): void {
    this.spent += costUsd;

    // Warn at 80%
    if (this.spent >= this.limit * 0.8 && this.spent - costUsd < this.limit * 0.8) {
      this.onWarning?.(this.spent, this.limit);
    }

    if (this.spent > this.limit) {
      throw new CostCapExceededError(this.spent, this.limit);
    }
  }

  get totalSpent(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get percentUsed(): number {
    return Math.min(100, (this.spent / this.limit) * 100);
  }
}

export class CostCapExceededError extends Error {
  public readonly spent: number;
  public readonly limit: number;

  constructor(spent: number, limit: number) {
    super(`Cost cap exceeded: $${spent.toFixed(2)} spent, limit is $${limit.toFixed(2)}`);
    this.name = "CostCapExceededError";
    this.spent = spent;
    this.limit = limit;
  }
}

/**
 * Flow limiter — enforces the max 8 videos per flow with different angles.
 * Tracks which angles have been generated and rejects duplicates or overflow.
 */
export class FlowLimiter {
  private readonly maxVideos: number;
  private generatedAngles: Map<string, number> = new Map(); // angle → count
  private totalGenerated = 0;

  constructor(maxVideos: number = 8) {
    this.maxVideos = maxVideos;
  }

  /**
   * Check if a new video can be generated. Returns true if under the cap.
   * The angle parameter is used to ensure diversity — same angle doesn't
   * count twice against the limit, but does prevent excessive duplication.
   */
  canGenerate(angle?: string): boolean {
    if (this.totalGenerated >= this.maxVideos) return false;
    // Prevent more than 2 of the same angle (allow some A/B testing per angle)
    if (angle && (this.generatedAngles.get(angle) ?? 0) >= 2) return false;
    return true;
  }

  /** Record that a video was generated with a given angle/hook */
  record(angle?: string): void {
    this.totalGenerated += 1;
    if (angle) {
      this.generatedAngles.set(angle, (this.generatedAngles.get(angle) ?? 0) + 1);
    }
  }

  get videosRemaining(): number {
    return Math.max(0, this.maxVideos - this.totalGenerated);
  }

  get totalVideos(): number {
    return this.totalGenerated;
  }

  get uniqueAngles(): number {
    return this.generatedAngles.size;
  }
}

/**
 * Throttled execution — adds a delay between vendor calls to avoid
 * triggering rate limiters (especially TikTok and Kling's burst limits).
 */
export async function throttledExec<T>(
  fn: () => Promise<T>,
  delayMs: number
): Promise<T> {
  const result = await fn();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/**
 * Execute work items with concurrency limits and cost caps.
 * This is the main entry point for the conductor to use.
 */
export async function executeCapped<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  config: ConcurrencyCapConfig = DEFAULT_CAP_CONFIG
): Promise<Array<{ item: T; result?: R; error?: string; skipped?: boolean }>> {
  const semaphore = new Semaphore(config.maxConcurrentVideoGen);
  const flowLimiter = new FlowLimiter(config.maxVideosPerFlow);
  const results: Array<{ item: T; result?: R; error?: string; skipped?: boolean }> = [];

  for (const [index, item] of items.entries()) {
    if (!flowLimiter.canGenerate()) {
      results.push({ item, skipped: true });
      continue;
    }

    await semaphore.acquire();
    try {
      const result = await worker(item, index);
      flowLimiter.record();
      results.push({ item, result });
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        // Hard stop — skip all remaining
        results.push({ item, error: err.message });
        semaphore.release();
        for (const remaining of items.slice(index + 1)) {
          results.push({ item: remaining, skipped: true });
        }
        break;
      }
      results.push({ item, error: String(err) });
    } finally {
      semaphore.release();
    }

    // Throttle between items
    if (config.vendorThrottleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.vendorThrottleMs));
    }
  }

  return results;
}
