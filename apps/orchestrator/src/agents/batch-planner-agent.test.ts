import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const { planBatchFromDescription, AiBatchPlanInputSchema } = await import("./batch-planner-agent.js");

function textMessage(json: unknown, usage = { input_tokens: 200, output_tokens: 100 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

function context(overrides: Partial<Parameters<typeof planBatchFromDescription>[1]> = {}) {
  return {
    products: [{ id: "prod-1", name: "Protein Powder" }],
    templates: [{ id: "tmpl-1", name: "Testimonial" }],
    creators: [{ id: "creator-1", name: "Alex" }],
    ...overrides
  };
}

function validPlanJson(overrides: Record<string, unknown> = {}) {
  return {
    productProfileId: "prod-1",
    templateId: "tmpl-1",
    creatorProfileIds: ["creator-1"],
    hookCount: 5,
    scriptCount: 2,
    captionStyleIds: ["bold"],
    platforms: ["tiktok", "youtube_shorts"],
    vendorPolicy: { policy: "cheapest" },
    targetDurationSec: 30,
    maxVariations: 20,
    maxEstimatedCostUsd: 100,
    locale: "en",
    rationale: "Inferred a week of energetic protein-brand content across TikTok and Shorts.",
    ...overrides
  };
}

describe("AiBatchPlanInputSchema", () => {
  it("rejects a missing required field (platforms)", () => {
    const { platforms: _omit, ...rest } = validPlanJson();
    expect(() => AiBatchPlanInputSchema.parse(rest)).toThrow();
  });

  it("rejects hookCount above HARD_LIMITS.MAX_HOOKS", () => {
    expect(() => AiBatchPlanInputSchema.parse(validPlanJson({ hookCount: 999 }))).toThrow();
  });

  it("rejects an unrecognized platform", () => {
    expect(() => AiBatchPlanInputSchema.parse(validPlanJson({ platforms: ["not_a_real_platform"] }))).toThrow();
  });

  it("rejects rationale being empty", () => {
    expect(() => AiBatchPlanInputSchema.parse(validPlanJson({ rationale: "" }))).toThrow();
  });

  it("accepts a minimal valid plan, applying defaults for optional fields", () => {
    const parsed = AiBatchPlanInputSchema.parse({
      productProfileId: "prod-1",
      platforms: ["tiktok"],
      rationale: "Minimal description, defaulting everything else."
    });
    expect(parsed.hookCount).toBe(3);
    expect(parsed.scriptCount).toBe(1);
    expect(parsed.creatorProfileIds).toEqual([]);
    expect(parsed.vendorPolicy).toEqual({ policy: "cheapest" });
  });
});

describe("planBatchFromDescription — dry-run", () => {
  it("returns a deterministic mock draft without calling any provider", async () => {
    mockCreate.mockReset();
    const draft = await planBatchFromDescription("a week of fitness content", context(), { dryRun: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(draft.plan.productProfileId).toBe("prod-1");
    expect(draft.droppedInvalidIds).toEqual([]);
    expect(draft.plan.rationale).toContain("a week of fitness content");
  });

  it("dry-run with no products still returns a draft (empty productProfileId) rather than throwing", async () => {
    const draft = await planBatchFromDescription("test", context({ products: [] }), { dryRun: true });
    expect(draft.plan.productProfileId).toBe("");
  });
});

describe("planBatchFromDescription — live (mocked provider)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Hermeticity — same guardrail every other agent's test suite in this repo
    // enforces: clear every fallback provider key and hard-fail any unmocked
    // fetch, so an ambient key left in the shell can never leak this suite
    // onto a real network call.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it("throws before calling the provider when the org has no products at all", async () => {
    await expect(planBatchFromDescription("anything", context({ products: [] }))).rejects.toThrow(/no product profiles/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("parses a valid model response into a draft plan", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson()));
    const draft = await planBatchFromDescription("a week of protein content, TikTok and Shorts", context());

    expect(draft.plan.productProfileId).toBe("prod-1");
    expect(draft.plan.templateId).toBe("tmpl-1");
    expect(draft.plan.creatorProfileIds).toEqual(["creator-1"]);
    expect(draft.plan.platforms).toEqual(["tiktok", "youtube_shorts"]);
    expect(draft.droppedInvalidIds).toEqual([]);
  });

  it("records Anthropic usage on the cost ledger under the batch_plan_draft stage", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson()));
    const ledger = new CostLedger();
    await planBatchFromDescription("desc", context(), { costLedger: ledger });

    const events = ledger.getEvents();
    expect(events.some((e) => e.stage === "batch_plan_draft" && e.vendor === "anthropic")).toBe(true);
  });

  it("drops a product id the model invented (not in the provided context) rather than trusting it", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson({ productProfileId: "prod-does-not-exist" })));
    const draft = await planBatchFromDescription("desc", context());

    expect(draft.plan.productProfileId).toBe("");
    expect(draft.droppedInvalidIds).toContain("prod-does-not-exist");
  });

  it("drops an invented template id but keeps the rest of the plan intact", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson({ templateId: "tmpl-fake" })));
    const draft = await planBatchFromDescription("desc", context());

    expect(draft.plan.templateId).toBeUndefined();
    expect(draft.droppedInvalidIds).toContain("tmpl-fake");
    expect(draft.plan.productProfileId).toBe("prod-1"); // unaffected
  });

  it("filters out invented creator ids while keeping the valid ones", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson({ creatorProfileIds: ["creator-1", "creator-fake"] })));
    const draft = await planBatchFromDescription(
      "desc",
      context({ creators: [{ id: "creator-1", name: "Alex" }, { id: "creator-2", name: "Sam" }] })
    );

    expect(draft.plan.creatorProfileIds).toEqual(["creator-1"]);
    expect(draft.droppedInvalidIds).toContain("creator-fake");
  });

  it("throws a schema error (not a silent pass-through) when the model returns an out-of-bounds value", async () => {
    mockCreate.mockResolvedValue(textMessage(validPlanJson({ hookCount: 500 })));
    await expect(planBatchFromDescription("desc", context())).rejects.toThrow();
  });

  it("throws when the response contains no parseable JSON object", async () => {
    mockCreate.mockResolvedValue(textMessage("not json"));
    // JSON.stringify("not json") -> `"not json"`, which DOES contain no {}
    await expect(planBatchFromDescription("desc", context())).rejects.toThrow(/No JSON object found/);
  });

  it("never leaks a live network call even with an ambient GROK_API_KEY present (hermetic guardrail)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GROK_API_KEY = "ambient-leaked-key";
    mockCreate.mockRejectedValue(new Error("should not be called"));

    // fetch is stubbed to throw in beforeEach — if the failover chain ever
    // reaches it (because ANTHROPIC_API_KEY is gone and GROK_API_KEY looks
    // configured), this call must fail loudly with that stub's error, not
    // silently succeed against a real endpoint.
    await expect(planBatchFromDescription("desc", context())).rejects.toThrow(/unexpected live fetch/);
    delete process.env.GROK_API_KEY;
  });
});
