import { describe, it, expect } from "vitest";
import { mapToKlingParams, mapToSeedanceParams, mapToPromptEnrichment } from "./visual-mapping.js";

describe("Visual Mapping — Kling", () => {
  it("tracking → predefined move_forward", () => {
    const result = mapToKlingParams({ cameraMovement: "tracking" });
    expect(result.camera_control).toEqual({ type: "predefined", config: { name: "move_forward" } });
  });

  it("pan_left → predefined pan_left", () => {
    const result = mapToKlingParams({ cameraMovement: "pan_left" });
    expect(result.camera_control).toEqual({ type: "predefined", config: { name: "pan_left" } });
  });

  it("orbit → around_cw", () => {
    const result = mapToKlingParams({ cameraMovement: "orbit" });
    expect(result.camera_control).toEqual({ type: "predefined", config: { name: "around_cw" } });
  });

  it("static → no camera_control param", () => {
    const result = mapToKlingParams({ cameraMovement: "static" });
    expect(result.camera_control).toBeUndefined();
  });

  it("undefined direction → empty params", () => {
    const result = mapToKlingParams({});
    expect(result).toEqual({});
  });

  it("ignores non-camera fields (lens, lighting)", () => {
    const result = mapToKlingParams({ lens: "anamorphic", lighting: "golden_hour" });
    expect(result).toEqual({});
  });
});

describe("Visual Mapping — Seedance", () => {
  it("pan_left → camera_control: pan_left", () => {
    const result = mapToSeedanceParams({ cameraMovement: "pan_left" });
    expect(result.camera_control).toBe("pan_left");
  });

  it("dolly_in → push_in", () => {
    const result = mapToSeedanceParams({ cameraMovement: "dolly_in" });
    expect(result.camera_control).toBe("push_in");
  });

  it("tempo calm → motion_mode slow", () => {
    const result = mapToSeedanceParams({ tempo: "calm" });
    expect(result.motion_mode).toBe("slow");
  });

  it("tempo dynamic → motion_mode normal", () => {
    const result = mapToSeedanceParams({ tempo: "dynamic" });
    expect(result.motion_mode).toBe("normal");
  });

  it("tempo chaotic → motion_mode fast", () => {
    const result = mapToSeedanceParams({ tempo: "chaotic" });
    expect(result.motion_mode).toBe("fast");
  });

  it("static → no camera_control", () => {
    const result = mapToSeedanceParams({ cameraMovement: "static" });
    expect(result.camera_control).toBeUndefined();
  });

  it("empty → empty params", () => {
    const result = mapToSeedanceParams({});
    expect(result).toEqual({});
  });
});

describe("Visual Mapping — Prompt Enrichment", () => {
  it("full direction → readable comma-separated text", () => {
    const result = mapToPromptEnrichment({
      cameraMovement: "tracking",
      lens: "anamorphic",
      lighting: "golden_hour",
      colorPalette: "warm",
      filmGrain: "subtle",
      era: "80s",
      tempo: "dynamic",
    });
    expect(result).toContain("cinematic tracking shot");
    expect(result).toContain("anamorphic widescreen lens");
    expect(result).toContain("warm golden hour sunlight");
    expect(result).toContain("warm color tones");
    expect(result).toContain("subtle film grain");
    expect(result).toContain("1980s retro look");
    expect(result).toContain("dynamic energetic movement");
    // Comma separated
    expect(result.split(", ").length).toBeGreaterThanOrEqual(7);
  });

  it("empty direction → empty string", () => {
    expect(mapToPromptEnrichment({})).toBe("");
  });

  it("undefined fields → empty string", () => {
    expect(mapToPromptEnrichment({ cameraMovement: undefined, lens: undefined })).toBe("");
  });

  it("only camera → single item", () => {
    const result = mapToPromptEnrichment({ cameraMovement: "drone" });
    expect(result).toBe("aerial drone shot");
  });

  it("modern era → not included (no enrichment needed)", () => {
    const result = mapToPromptEnrichment({ era: "modern" });
    expect(result).toBe("");
  });

  it("filmGrain none → not included", () => {
    const result = mapToPromptEnrichment({ filmGrain: "none" });
    expect(result).toBe("");
  });

  it("noir color palette → black and white noir", () => {
    const result = mapToPromptEnrichment({ colorPalette: "noir" });
    expect(result).toBe("black and white noir");
  });
});
