/**
 * Per-run cost/usage tracking. Nothing in the pipeline previously recorded
 * spend anywhere — docs/cost-table.md was a manual template you'd fill in
 * by hand after the fact. This ledger records real usage as each stage
 * runs (Claude's actual token counts from the API response; one unit per
 * video-gen clip actually requested) and estimates a USD cost from the
 * rate table below. Rates are estimates you should keep current — this is
 * cost *visibility*, not a billing-grade metering system.
 */
export type CostVendor = "anthropic" | "higgsfield" | "kling" | "runway" | "pika" | "youtube";

export interface CostEvent {
  stage: string;
  vendor: CostVendor;
  unit: string;
  quantity: number;
  estimatedCostUsd: number;
  meta?: Record<string, unknown>;
}

/**
 * Rough per-unit USD rates, used only to turn recorded usage into an estimate.
 * Update these as real vendor pricing/plans change — see docs/cost-table.md.
 */
const RATE_TABLE: Record<CostVendor, Record<string, number>> = {
  anthropic: {
    // claude-sonnet-4-5 list pricing, per token (i.e. $3/$15 per million tokens).
    input_tokens: 3 / 1_000_000,
    output_tokens: 15 / 1_000_000
  },
  higgsfield: { clip: 0.4 },
  kling: { clip: 0.35 },
  runway: { clip: 0.5 },
  pika: { clip: 0.3 },
  youtube: { quota_unit: 0 }
};

export function estimateCostUsd(vendor: CostVendor, unit: string, quantity: number): number {
  const rate = RATE_TABLE[vendor]?.[unit] ?? 0;
  return Number((rate * quantity).toFixed(6));
}

export class CostLedger {
  private events: CostEvent[] = [];

  record(stage: string, vendor: CostVendor, unit: string, quantity: number, meta?: Record<string, unknown>): void {
    this.events.push({ stage, vendor, unit, quantity, estimatedCostUsd: estimateCostUsd(vendor, unit, quantity), meta });
  }

  /** Convenience for Anthropic SDK responses, which report usage as { input_tokens, output_tokens }. */
  recordAnthropicUsage(stage: string, usage: { input_tokens: number; output_tokens: number }): void {
    this.record(stage, "anthropic", "input_tokens", usage.input_tokens);
    this.record(stage, "anthropic", "output_tokens", usage.output_tokens);
  }

  getEvents(): CostEvent[] {
    return [...this.events];
  }

  totalUsd(): number {
    return Number(this.events.reduce((sum, e) => sum + e.estimatedCostUsd, 0).toFixed(6));
  }

  totalsByVendor(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const e of this.events) {
      totals[e.vendor] = Number(((totals[e.vendor] ?? 0) + e.estimatedCostUsd).toFixed(6));
    }
    return totals;
  }

  toJSON(): { events: CostEvent[]; totalUsd: number; totalsByVendor: Record<string, number> } {
    return { events: this.getEvents(), totalUsd: this.totalUsd(), totalsByVendor: this.totalsByVendor() };
  }
}
