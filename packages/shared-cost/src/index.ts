/**
 * Per-run cost/usage tracking. Nothing in the pipeline previously recorded
 * spend anywhere — docs/cost-table.md was a manual template you'd fill in
 * by hand after the fact. This ledger records real usage as each stage
 * runs (Claude's actual token counts from the API response; one unit per
 * video-gen clip actually requested) and estimates a USD cost from the
 * rate table below. Rates are estimates you should keep current — this is
 * cost *visibility*, not a billing-grade metering system.
 */
export type CostVendor =
  | "anthropic"
  | "higgsfield"
  | "kling"
  | "runway"
  | "pika"
  | "youtube"
  | "elevenlabs"
  | "grok"
  | "gemini";

export interface CostEvent {
  stage: string;
  vendor: CostVendor;
  unit: string;
  quantity: number;
  estimatedCostUsd: number;
  model?: string;
  meta?: Record<string, unknown>;
}

/**
 * Rough per-unit USD rates, used only to turn recorded usage into an estimate.
 * Update these as real vendor pricing/plans change — see docs/cost-table.md.
 */
const ANTHROPIC_RATE_TABLE: Record<string, Record<string, number>> = {
  // Per-token list pricing (USD per million tokens, converted to per-token).
  "claude-sonnet-5": { input_tokens: 3 / 1_000_000, output_tokens: 15 / 1_000_000 },
  // Kept for any historical cost-ledger JSON still on disk from before the orchestrator
  // agents switched to the model mix below; same $3/$15 pricing tier as claude-sonnet-5.
  "claude-sonnet-4-5": { input_tokens: 3 / 1_000_000, output_tokens: 15 / 1_000_000 },
  "claude-haiku-4-5": { input_tokens: 1 / 1_000_000, output_tokens: 5 / 1_000_000 },
  // Estimate — confirm against current Anthropic pricing before relying on it.
  "claude-fable-5": { input_tokens: 10 / 1_000_000, output_tokens: 50 / 1_000_000 }
};

const RATE_TABLE: Record<Exclude<CostVendor, "anthropic">, Record<string, number>> = {
  higgsfield: { clip: 0.4 },
  kling: { clip: 0.35 },
  runway: { clip: 0.5 },
  pika: { clip: 0.3 },
  youtube: { quota_unit: 0 },
  // Estimate (Creator-tier list pricing) — ElevenLabs bills per-plan, not a single
  // universal rate; confirm against your actual plan before relying on it.
  elevenlabs: { character: 0.24 / 1000 },
  // Sourced: xAI's published Grok TTS pricing, $4.20 per 1,000,000 characters
  // (announced with the standalone Grok Speech/TTS API launch).
  grok: { character: 4.2 / 1_000_000 },
  // Sourced: Gemini API pricing for gemini-2.5-flash-image ("Nano Banana"), $0.039/image
  // at up to 1024x1024. Newer/higher-resolution Gemini image models are priced per
  // resolution tier instead of flat-per-image — if GEMINI_IMAGE_MODEL is overridden to
  // one of those, this rate will under/overestimate; confirm against current pricing.
  gemini: { image: 0.039 }
};

export function estimateCostUsd(vendor: CostVendor, unit: string, quantity: number, model?: string): number {
  const rate =
    vendor === "anthropic"
      ? (model ? ANTHROPIC_RATE_TABLE[model]?.[unit] : undefined) ?? 0
      : RATE_TABLE[vendor]?.[unit] ?? 0;
  return Number((rate * quantity).toFixed(6));
}

export class CostLedger {
  private events: CostEvent[] = [];

  record(
    stage: string,
    vendor: CostVendor,
    unit: string,
    quantity: number,
    meta?: Record<string, unknown>,
    model?: string
  ): void {
    this.events.push({
      stage,
      vendor,
      unit,
      quantity,
      estimatedCostUsd: estimateCostUsd(vendor, unit, quantity, model),
      model,
      meta
    });
  }

  /** Convenience for Anthropic SDK responses, which report usage as { input_tokens, output_tokens }. */
  recordAnthropicUsage(stage: string, usage: { input_tokens: number; output_tokens: number }, model: string): void {
    this.record(stage, "anthropic", "input_tokens", usage.input_tokens, undefined, model);
    this.record(stage, "anthropic", "output_tokens", usage.output_tokens, undefined, model);
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

  totalsByModel(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const e of this.events) {
      if (!e.model) continue;
      totals[e.model] = Number(((totals[e.model] ?? 0) + e.estimatedCostUsd).toFixed(6));
    }
    return totals;
  }

  toJSON(): {
    events: CostEvent[];
    totalUsd: number;
    totalsByVendor: Record<string, number>;
    totalsByModel: Record<string, number>;
  } {
    return {
      events: this.getEvents(),
      totalUsd: this.totalUsd(),
      totalsByVendor: this.totalsByVendor(),
      totalsByModel: this.totalsByModel()
    };
  }
}
