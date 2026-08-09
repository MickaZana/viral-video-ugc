import { describe, expect, it } from "vitest";
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

  it("prices gemini text per-model per-token (LLM failover)", () => {
    expect(estimateCostUsd("gemini", "input_tokens", 1_000_000, "gemini-2.5-pro")).toBeCloseTo(1.25, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-2.5-pro")).toBeCloseTo(10, 6);
    expect(estimateCostUsd("gemini", "output_tokens", 1_000_000, "gemini-2.5-flash")).toBeCloseTo(2.5, 6);
  });

  it("returns 0 for an unknown gemini text model rather than throwing", () => {
    expect(estimateCostUsd("gemini", "input_tokens", 1000, "gemini-nonexistent")).toBe(0);
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

  it("recordGeminiUsage attributes text tokens to the gemini vendor, priced per model", () => {
    const ledger = new CostLedger();
    ledger.recordGeminiUsage("script_rewrite", { input_tokens: 1_000_000, output_tokens: 500_000 }, "gemini-2.5-pro");
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.getEvents().every((e) => e.vendor === "gemini" && e.stage === "script_rewrite")).toBe(true);
    expect(ledger.totalUsd()).toBeCloseTo(1.25 + 5.0, 6);
    expect(ledger.totalsByModel()["gemini-2.5-pro"]).toBeCloseTo(6.25, 6);
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

  it("toJSON returns a serializable summary", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "runway", "clip", 2);
    const json = ledger.toJSON();
    expect(json.totalUsd).toBeCloseTo(1.0, 6);
    expect(json.totalsByVendor).toEqual({ runway: 1.0 });
    expect(json.events).toHaveLength(1);
  });
});
