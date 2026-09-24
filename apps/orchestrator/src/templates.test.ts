import { describe, expect, it } from "vitest";
import { BUILTIN_UGC_TEMPLATES, getUgcTemplate, templateCompatibility, validateTemplateScript } from "./templates.js";
import { rewriteScript } from "./agents/script-agent.js";
import { mockTranscript } from "@vvugc/mcp-transcript";
import { mockCandidates } from "@vvugc/mcp-discovery";

describe("built-in UGC templates", () => {
  it("validates all seven versioned templates", () => {
    expect(BUILTIN_UGC_TEMPLATES).toHaveLength(7);
    for (const template of BUILTIN_UGC_TEMPLATES) {
      expect(template.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(template.scriptStructure.length).toBeGreaterThanOrEqual(5);
      expect(template.active).toBe(true);
    }
  });

  it("dry-run generates every declared structural beat", async () => {
    const transcript = mockTranscript(mockCandidates("tiktok", "fitness", 1)[0]);
    for (const template of BUILTIN_UGC_TEMPLATES) {
      const script = await rewriteScript(transcript, { niche: "fitness", brandVoice: "direct", durationSec: 30, platforms: ["tiktok"], template, dryRun: true });
      expect(script.points.length).toBe(template.scriptStructure.length - 2);
      expect(validateTemplateScript(template, script)).toEqual([]);
    }
  });

  it("rejects missing beats and forbidden patterns deterministically", () => {
    const template = getUgcTemplate("testimonial")!;
    expect(validateTemplateScript(template, { hook: "hook", points: [], cta: "cta" })).toContain("template_missing_beats");
    expect(validateTemplateScript(template, { hook: "unsupported claims", points: ["a", "b", "c", "d"], cta: "cta" })).toContain("template_forbidden_pattern");
  });

  it("surfaces platform and duration compatibility warnings", () => {
    const template = getUgcTemplate("tutorial")!;
    expect(templateCompatibility(template, ["tiktok"], 30)).toEqual([]);
    expect(templateCompatibility(template, ["facebook"], 60).length).toBeGreaterThan(0);
  });

  it("keeps freeform runs backwards compatible", async () => {
    const transcript = mockTranscript(mockCandidates("tiktok", "fitness", 1)[0]);
    const script = await rewriteScript(transcript, { niche: "fitness", brandVoice: "direct", durationSec: 30, platforms: ["tiktok"], dryRun: true });
    expect(script.points.length).toBe(2);
  });
});
