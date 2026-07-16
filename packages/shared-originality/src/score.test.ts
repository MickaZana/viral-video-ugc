import { describe, expect, it } from "vitest";
import { scoreOriginality } from "./score.js";

const SOURCE =
  "Nobody told you this about your morning routine. The one habit stacking mistake killing your gains. " +
  "Here is what to do instead starting tomorrow. Follow for part two.";

describe("scoreOriginality", () => {
  it("scores completely different wording as highly original with no phrase overlaps", () => {
    const generated =
      "You have been sleeping wrong for years and nobody bothered to mention it. " +
      "Try this instead tonight and notice the difference immediately. Save this for later.";

    const result = scoreOriginality(SOURCE, generated);

    expect(result.phraseOverlaps).toHaveLength(0);
    expect(result.originalityScore).toBeGreaterThan(70);
    expect(result.flags).not.toContain("verbatim_phrase_reuse");
  });

  it("scores a near-verbatim copy as low-originality with phrase overlaps and warning flags", () => {
    const result = scoreOriginality(SOURCE, SOURCE);

    expect(result.phraseOverlaps.length).toBeGreaterThan(0);
    expect(result.originalityScore).toBeLessThan(20);
    expect(result.flags).toContain("verbatim_phrase_reuse");
    expect(result.flags).toContain("high_wording_similarity");
    expect(result.flags).toContain("requires_originality_review");
  });

  it("flags a script that reuses one long exact phrase, even if the rest is rewritten", () => {
    const generated =
      "Totally different opener about a completely unrelated topic here. " +
      "The one habit stacking mistake killing your gains, by the way. " +
      "Something else entirely follows after that, wrapping up differently.";

    const result = scoreOriginality(SOURCE, generated);

    expect(result.phraseOverlaps.length).toBeGreaterThan(0);
    expect(result.phraseOverlaps.some((p) => p.includes("habit stacking mistake"))).toBe(true);
    expect(result.flags).toContain("verbatim_phrase_reuse");
  });

  it("recognizes similar structure (sentence count/length) with completely different wording as structurally similar", () => {
    const generated =
      "Something surprising about your evening habits nobody mentions. The overlooked scheduling error draining your energy. " +
      "Here is the fix to apply right away. Subscribe for the sequel.";

    const result = scoreOriginality(SOURCE, generated);
    expect(result.structuralSimilarityPct).toBeGreaterThan(70);
    expect(result.wordingSimilarityPct).toBeLessThan(30);
  });

  it("handles empty strings without throwing", () => {
    expect(() => scoreOriginality("", "")).not.toThrow();
    expect(() => scoreOriginality(SOURCE, "")).not.toThrow();
    expect(() => scoreOriginality("", SOURCE)).not.toThrow();
  });

  it("originalityScore is always clamped to [0, 100]", () => {
    const longRepeat = SOURCE.repeat(20);
    const result = scoreOriginality(longRepeat, longRepeat);
    expect(result.originalityScore).toBeGreaterThanOrEqual(0);
    expect(result.originalityScore).toBeLessThanOrEqual(100);
  });
});
