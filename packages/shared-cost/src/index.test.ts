import { describe, expect, it, vi } from "vitest";
import { CostLedger, estimateCostUsd } from "./index.js";

describe("estimateCostUsd", () => {
  it("computes rate * quantity for a known vendor/unit", () => {
    expect(estimateCostUsd("higgsfield", "clip", 3)).toBeCloseTo(1.2, 6);
  });

  it("returns 0 for an unknown unit rather than throwing", () => {
    expect(estimateCostUsd("higgsfield", "unknown_unit", 5)).toBe(0);
  });

  it("prices voiceover vendors per character (elevenlabs, grok)", () => {
    expect(estimateCostUsd("elevenlabs", "character", 1000)).toBeCloseTo(0.24, 6);
    expect(estimateCostUsd("grok", "character", 1_000_000)).toBeCloseTo(4.2, 6);
  });

  it("prices gemini image generation per image", () => {
    expect(estimateCostUsd("gemini", "image", 10)).toBeCloseTo(0.39, 6);
  });

  it("prices gemini text per-model per-token (LLM failover) — dead models kept for historical ledger JSON", () => {
    expect(estimateCostUsd("gemini", "input_tokens", 1_000_000, "gemini-2.5-pro")).toBeCloseTo(1.25, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-2.5-pro")).toBeCloseTo(10, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-2.5-flash")).toBeCloseTo(2.5, 6);
  });

  it("prices gemini text for the current live model defaults (llm-failover.ts's GEMINI_TEXT_MODEL / caption-agent)", () => {
    expect(estimateCostUsd("gemini", "input_tokens", 1_000_000, "gemini-3.1-pro-preview")).toBeCloseTo(2.0, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-3.1-pro-preview")).toBeCloseTo(12.0, 6);
    expect(estimateCostUsd("gemini", "input_tokens", 1_000_000, "gemini-3.6-flash")).toBeCloseTo(0.75, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-3.6-flash")).toBeCloseTo(3.75, 6);
  });

  it("prices grok text per-model per-token (LLM failover) — dead models kept for historical ledger JSON", () => {
    expect(estimateCostUsd("grok", "input_tokens", 1_000_000, "grok-2-latest")).toBeCloseTo(2.0, 6);
    expect(estimateCostUsd("grok", "output_tokens", 1_000_000, "grok-2-latest")).toBeCloseTo(10.0, 6);
    expect(estimateCostUsd("grok", "output_tokens", 1_000_000, "grok-2-mini")).toBeCloseTo(1.0, 6);
  });

  it("prices grok text for the current live model default (llm-failover.ts's GROK_TEXT_MODEL, grok-4.3)", () => {
    expect(estimateCostUsd("grok", "input_tokens", 1_000_000, "grok-4.3")).toBeCloseTo(1.25, 6);
    expect(estimateCostUsd("grok", "output_tokens", 1_000_000, "grok-4.3")).toBeCloseTo(2.5, 6);
  });

  it("returns 0 for an unknown gemini/grok text model rather than throwing", () => {
    expect(estimateCostUsd("gemini", "input_tokens", 1000, "gemini-nonexistent")).toBe(0);
    expect(estimateCostUsd("grok", "input_tokens", 1000, "grok-nonexistent")).toBe(0);
  });
});

describe("CostLedger", () => {
  it("accumulates events and totals them", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "higgsfield", "clip", 4);
    ledger.record("video_gen", "kling", "clip", 2);
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.totalUsd()).toBeCloseTo(4 * 0.4 + 2 * 0.35, 6);
  });

  it("groups totals by vendor", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "higgsfield", "clip", 1);
    ledger.record("video_gen", "higgsfield", "clip", 1);
    ledger.record("video_gen", "kling", "clip", 1);
    const totals = ledger.totalsByVendor();
    expect(totals.higgsfield).toBeCloseTo(0.8, 6);
    expect(totals.kling).toBeCloseTo(0.35, 6);
  });

  it("recordAnthropicUsage records input/output tokens as separate events priced by model", () => {
    const ledger = new CostLedger();
    ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 }, "claude-sonnet-5");
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.totalUsd()).toBeCloseTo(1000 * (3 / 1_000_000) + 500 * (15 / 1_000_000), 6);
  });

  it("records OpenAI failover usage at the model-specific rate", () => {
    const ledger = new CostLedger();
    ledger.recordOpenAIUsage("script_rewrite", { input_tokens: 1_000_000, output_tokens: 500_000 }, "gpt-4.1-mini");
    expect(ledger.totalUsd()).toBe(1.2);
    expect(ledger.totalsByVendor().openai).toBe(1.2);
  });

  it("recordGeminiUsage attributes text tokens to the gemini vendor, priced per model", () => {
    const ledger = new CostLedger();
    ledger.recordGeminiUsage("script_rewrite", { input_tokens: 1_000_000, output_tokens: 500_000 }, "gemini-2.5-pro");
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.getEvents().every((e) => e.vendor === "gemini" && e.stage === "script_rewrite")).toBe(true);
    expect(ledger.totalUsd()).toBeCloseTo(1.25 + 5.0, 6);
    expect(ledger.totalsByModel()["gemini-2.5-pro"]).toBeCloseTo(6.25, 6);
  });

  it("recordGrokUsage attributes text tokens to the grok vendor, priced per model", () => {
    const ledger = new CostLedger();
    ledger.recordGrokUsage("script_rewrite", { input_tokens: 1_000_000, output_tokens: 500_000 }, "grok-2-latest");
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.getEvents().every((e) => e.vendor === "grok" && e.stage === "script_rewrite")).toBe(true);
    expect(ledger.totalUsd()).toBeCloseTo(2.0 + 5.0, 6);
    expect(ledger.totalsByModel()["grok-2-latest"]).toBeCloseTo(7.0, 6);
  });

  it("prices different models independently and splits totals by model", () => {
    const ledger = new CostLedger();
    ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 }, "claude-sonnet-5");
    ledger.recordAnthropicUsage("caption_timing", { input_tokens: 1000, output_tokens: 500 }, "claude-haiku-4-5");
    const totals = ledger.totalsByModel();
    expect(totals["claude-sonnet-5"]).toBeCloseTo(1000 * (3 / 1_000_000) + 500 * (15 / 1_000_000), 6);
    expect(totals["claude-haiku-4-5"]).toBeCloseTo(1000 * (1 / 1_000_000) + 500 * (5 / 1_000_000), 6);
    expect(ledger.totalUsd()).toBeCloseTo(
      (totals["claude-sonnet-5"] ?? 0) + (totals["claude-haiku-4-5"] ?? 0),
      6
    );
  });

  it("estimateCostUsd returns 0 for an unrecognized model", () => {
    expect(estimateCostUsd("anthropic", "input_tokens", 1000, "claude-nonexistent")).toBe(0);
  });

  it("records usage at $0 and warns once (not per call) for an unknown anthropic model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ledger = new CostLedger();
      ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 }, "claude-unknown-warning");
      ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 }, "claude-unknown-warning");
      const events = ledger.getEvents();
      expect(events).toHaveLength(4);
      expect(events.every((e) => e.quantity > 0)).toBe(true);
      expect(events.every((e) => e.estimatedCostUsd === 0)).toBe(true);
      expect(ledger.totalUsd()).toBe(0);
      expect(ledger.totalsByModel()["claude-unknown-warning"]).toBe(0);
      const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("claude-unknown-warning"));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain("$0");
      expect(String(warnings[0][0])).toContain("ANTHROPIC_RATE_TABLE");
      expect(String(warnings[0][0])).toContain("docs/cost-table.md");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a known anthropic model (known-model pricing path unchanged)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ledger = new CostLedger();
      ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 }, "claude-sonnet-5");
      expect(warn).not.toHaveBeenCalled();
      expect(ledger.totalUsd()).toBeCloseTo(1000 * (3 / 1_000_000) + 500 * (15 / 1_000_000), 6);
    } finally {
      warn.mockRestore();
    }
  });

  it("toJSON returns a serializable summary", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "runway", "clip", 2);
    const json = ledger.toJSON();
    expect(json.totalUsd).toBeCloseTo(1.0, 6);
    expect(json.totalsByVendor).toEqual({ runway: 1.0 });
    expect(json.events).toHaveLength(1);
  });

  it("recordKimiUsage attributes text tokens to the kimi vendor, priced per model", () => {
    const ledger = new CostLedger();
    ledger.recordKimiUsage("storyboard", { input_tokens: 1_000_000, output_tokens: 500_000 }, "kimi-k3");
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.getEvents().every((e) => e.vendor === "kimi" && e.stage === "storyboard")).toBe(true);
    expect(ledger.totalUsd()).toBeCloseTo(0.95 + 2.0, 6);
    expect(ledger.totalsByVendor().kimi).toBeCloseTo(2.95, 6);
    expect(ledger.totalsByModel()["kimi-k3"]).toBeCloseTo(2.95, 6);
  });

  it("totalsByModel skips events recorded without a model (flat per-unit vendors)", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "higgsfield", "clip", 4);
    ledger.record("voiceover", "elevenlabs", "character", 1000);
    expect(ledger.totalsByModel()).toEqual({});
    expect(Object.keys(ledger.totalsByVendor()).sort()).toEqual(["elevenlabs", "higgsfield"]);
  });

  it("getEvents returns a defensive copy — mutating it does not corrupt the ledger", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "kling", "clip", 1);
    const snapshot = ledger.getEvents();
    snapshot.push({ stage: "fake", vendor: "kling", unit: "clip", quantity: 999, estimatedCostUsd: 999 });
    expect(ledger.getEvents()).toHaveLength(1);
    expect(ledger.totalUsd()).toBeCloseTo(0.35, 6);
  });

  it("record preserves meta and model on the stored event", () => {
    const ledger = new CostLedger();
    ledger.record("script_rewrite", "anthropic", "input_tokens", 1000, { traceId: "t-1" }, "claude-sonnet-5");
    const [event] = ledger.getEvents();
    expect(event.meta).toEqual({ traceId: "t-1" });
    expect(event.model).toBe("claude-sonnet-5");
    expect(event.estimatedCostUsd).toBeCloseTo(0.003, 6);
  });
});

describe("estimateCostUsd — remaining rate-table edge cases", () => {
  it("prices claude-fable-5 (script-agent premium model) at its estimate rates", () => {
    expect(estimateCostUsd("anthropic", "input_tokens", 1_000_000, "claude-fable-5")).toBeCloseTo(10, 6);
    expect(estimateCostUsd("anthropic", "output_tokens", 1_000_000, "claude-fable-5")).toBeCloseTo(50, 6);
  });

  it("keeps the historical claude-sonnet-4-5 entry priced identically to claude-sonnet-5 (per AGENTS.md)", () => {
    const sameUsage = { input_tokens: 250_000, output_tokens: 100_000 };
    expect(estimateCostUsd("anthropic", "input_tokens", sameUsage.input_tokens, "claude-sonnet-4-5"))
      .toBeCloseTo(estimateCostUsd("anthropic", "input_tokens", sameUsage.input_tokens, "claude-sonnet-5"), 9);
    expect(estimateCostUsd("anthropic", "output_tokens", sameUsage.output_tokens, "claude-sonnet-4-5"))
      .toBeCloseTo(estimateCostUsd("anthropic", "output_tokens", sameUsage.output_tokens, "claude-sonnet-5"), 9);
  });

  it("returns 0 for anthropic/openai usage recorded without a model rather than guessing a rate", () => {
    expect(estimateCostUsd("anthropic", "input_tokens", 1000)).toBe(0);
    expect(estimateCostUsd("openai", "input_tokens", 1000)).toBe(0);
  });

  it("returns 0 for an unknown openai model", () => {
    expect(estimateCostUsd("openai", "input_tokens", 1000, "gpt-nonexistent")).toBe(0);
  });

  it("prices kimi text per-model per-token (k2.6 estimate carried onto k3)", () => {
    expect(estimateCostUsd("kimi", "input_tokens", 1_000_000, "kimi-k2.6")).toBeCloseTo(0.95, 6);
    expect(estimateCostUsd("kimi", "output_tokens", 1_000_000, "kimi-k2.6")).toBeCloseTo(4.0, 6);
    expect(estimateCostUsd("kimi", "input_tokens", 1_000_000, "kimi-k3")).toBeCloseTo(0.95, 6);
    expect(estimateCostUsd("kimi", "output_tokens", 1_000_000, "kimi-k3")).toBeCloseTo(4.0, 6);
  });

  it("returns 0 for an unknown kimi model, for kimi without a model, and never falls back to the flat unit table", () => {
    expect(estimateCostUsd("kimi", "input_tokens", 1000, "kimi-k9")).toBe(0);
    expect(estimateCostUsd("kimi", "input_tokens", 1000)).toBe(0);
    // KIMI_RATE_TABLE is token-only; RATE_TABLE.kimi is intentionally {} and never looked up.
    expect(estimateCostUsd("kimi", "clip", 100, "kimi-k3")).toBe(0);
    expect(estimateCostUsd("kimi", "clip", 100)).toBe(0);
  });

  it("model-aware gemini/grok lookups do NOT fall back to the flat unit rate when the unit is flat-priced", () => {
    // Documented current behavior: pass no model to price gemini images / grok TTS characters.
    expect(estimateCostUsd("gemini", "image", 10, "gemini-3.6-flash")).toBe(0);
    expect(estimateCostUsd("grok", "character", 1000, "grok-4.3")).toBe(0);
    expect(estimateCostUsd("gemini", "image", 10)).toBeCloseTo(0.39, 6);
    expect(estimateCostUsd("grok", "character", 1000)).toBeCloseTo(4.2 / 1_000_000 * 1000, 6);
  });

  it("prices the remaining flat per-unit video vendors from RATE_TABLE", () => {
    expect(estimateCostUsd("seedance", "clip", 10)).toBeCloseTo(1.0, 6);
    expect(estimateCostUsd("pika", "clip", 10)).toBeCloseTo(3.0, 6);
    expect(estimateCostUsd("runway", "clip", 2)).toBeCloseTo(1.0, 6);
    expect(estimateCostUsd("sync_labs", "clip", 2)).toBeCloseTo(1.0, 6);
    expect(estimateCostUsd("heygen", "clip", 2)).toBeCloseTo(1.5, 6);
    expect(estimateCostUsd("wan", "clip", 2)).toBeCloseTo(1.0, 6);
    expect(estimateCostUsd("alibaba", "clip", 2)).toBeCloseTo(1.0, 6);
    expect(estimateCostUsd("replicate", "clip", 3)).toBeCloseTo(1.2, 6);
    expect(estimateCostUsd("grok_video", "clip", 4)).toBeCloseTo(1.0, 6);
  });

  it("prices youtube quota units at 0 (quota, not dollars) and unknown units on flat vendors at 0", () => {
    expect(estimateCostUsd("youtube", "quota_unit", 1000)).toBe(0);
    expect(estimateCostUsd("seedance", "unknown_unit", 5)).toBe(0);
  });
});
