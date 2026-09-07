import { describe, expect, it } from "vitest";
import { PRESET_CATEGORY_IDS } from "@vvugc/shared-schema";
import { BUILTIN_PRESETS, getPreset, listPresetsByCategory } from "./presets.js";
import { BUILTIN_UGC_TEMPLATES } from "./templates.js";

// Mirrors apps/control-panel/src/pages/BatchStudio.tsx's VISUAL_TREATMENTS list —
// every preset's visualTreatments must be selectable in that form, not just
// descriptive text a UI has no control for. Kept in sync manually; if that list
// changes, this test is the tripwire.
const KNOWN_VISUAL_TREATMENTS = new Set([
  "cinematic", "raw-handheld", "split-screen", "talking-head",
  "b-roll-overlay", "text-heavy", "product-closeup", "lifestyle"
]);

describe("BUILTIN_PRESETS", () => {
  it("loads without throwing — every entry parses against PresetSchema at module load", () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThan(0);
  });

  it("has exactly 4 categories with 4 presets each (16 total)", () => {
    expect(BUILTIN_PRESETS).toHaveLength(16);
    expect(PRESET_CATEGORY_IDS).toHaveLength(4);
    for (const category of PRESET_CATEGORY_IDS) {
      expect(listPresetsByCategory(category)).toHaveLength(4);
    }
  });

  it("every preset id is unique", () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset's templateId references a real, active BUILTIN_UGC_TEMPLATES entry", () => {
    const realTemplateIds = new Set<string>(BUILTIN_UGC_TEMPLATES.filter((t) => t.active).map((t) => t.id));
    for (const preset of BUILTIN_PRESETS) {
      expect(realTemplateIds.has(preset.templateId), `preset "${preset.id}" references unknown template "${preset.templateId}"`).toBe(true);
    }
  });

  it("every preset's visualTreatments are selectable in Batch Studio's fixed picker list", () => {
    for (const preset of BUILTIN_PRESETS) {
      for (const treatment of preset.visualTreatments) {
        expect(KNOWN_VISUAL_TREATMENTS.has(treatment), `preset "${preset.id}" uses unknown visual treatment "${treatment}"`).toBe(true);
      }
    }
  });

  it("every preset stays within BatchRequestSchema's platform/duration/hook bounds", () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(preset.platforms.length).toBeGreaterThanOrEqual(1);
      expect(preset.platforms.length).toBeLessThanOrEqual(4);
      expect(preset.targetDurationSec).toBeGreaterThanOrEqual(15);
      expect(preset.targetDurationSec).toBeLessThanOrEqual(60);
      expect(preset.exampleHooks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("getPreset resolves a known id and returns undefined for an unknown one", () => {
    expect(getPreset("ecom_unboxing_reveal")?.name).toBe("Unboxing Reveal");
    expect(getPreset("does-not-exist")).toBeUndefined();
  });

  it("listPresetsByCategory returns only presets in that category", () => {
    for (const preset of listPresetsByCategory("saas_apps")) {
      expect(preset.category).toBe("saas_apps");
    }
  });
});
