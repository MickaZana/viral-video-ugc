import { describe, expect, it } from "vitest";
import { createImprovementProposals, ImprovementProposalSetSchema } from "./improvement-proposals.js";

describe("run-local improvement proposals", () => {
  it("returns explicit none when there is no recognized QA evidence", () => {
    expect(createImprovementProposals([{ candidateId: "c1", platform: "tiktok", score: 90, flags: ["unknown"] }]))
      .toEqual({ version: 1, status: "none", advisoryOnly: true, requiresHumanApproval: true, proposals: [] });
  });

  it("maps QA flags to capped, bounded, human-reviewable suggestions", () => {
    const result = createImprovementProposals([{ candidateId: "c1", platform: "tiktok", score: 42, flags: [
      "weak_hook", "missing_cta", "unsupported_claims", "few_hashtags", "unknown",
    ] }]);
    expect(result.status).toBe("proposals");
    expect(result.advisoryOnly).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.every((proposal) => proposal.suggestion.length <= 120 && proposal.evidence.length <= 180)).toBe(true);
    expect(ImprovementProposalSetSchema.safeParse(result).success).toBe(true);
  });

  it("rejects output that exceeds the fixed proposal cap", () => {
    const tooMany = { version: 1, status: "proposals", advisoryOnly: true, requiresHumanApproval: true,
      proposals: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, suggestion: "Review this.", evidence: "QA flag observed." })) };
    expect(ImprovementProposalSetSchema.safeParse(tooMany).success).toBe(false);
  });

  it("uses fixed suggestions and does not mutate the source QA observation", () => {
    const observation = { candidateId: "c1", platform: "tiktok", score: 55, flags: ["weak_hook"] };
    const before = structuredClone(observation);
    const output = createImprovementProposals([observation]);
    expect(observation).toEqual(before);
    expect(output.proposals[0]?.suggestion).not.toContain("c1");
    expect(output.proposals[0]?.evidence).toContain("weak_hook");
  });

  it("maps every flag emitted by the QA prompt and deterministic QA heuristic", () => {
    const actualQaFlags = [
      "hook_too_long", "weak_hook", "missing_cta", "weak_cta", "duration_mismatch",
      "unsupported_claims", "template_mismatch", "template_forbidden_pattern",
      "forbidden_product_claim", "prohibited_creator_depiction", "low_trending_phrase_density",
      "no_captions", "few_hashtags",
    ];
    for (const flag of actualQaFlags) {
      const result = createImprovementProposals([{ candidateId: "qa-fixture", platform: "tiktok", score: 40, flags: [flag] }]);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.id).toBe(`qa-${flag}`);
    }
    expect(createImprovementProposals([{ candidateId: "qa-fixture", platform: "tiktok", score: 40,
      flags: ["forbidden_product_claim"] }]).proposals[0]?.suggestion).toContain("forbidden claims");
    expect(createImprovementProposals([{ candidateId: "qa-fixture", platform: "tiktok", score: 40,
      flags: ["prohibited_creator_depiction"] }]).proposals[0]?.suggestion).toContain("safety profile");
    expect(createImprovementProposals([{ candidateId: "qa-fixture", platform: "tiktok", score: 40,
      flags: ["low_trending_phrase_density"] }]).proposals[0]?.suggestion).toContain("trending phrases");
  });
});
