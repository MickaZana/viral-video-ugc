import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCharacterPrompt,
  generateCharacterPortraitBatch,
  CharacterAttributesSchema,
  CHARACTER_ATTRIBUTE_OPTIONS,
  type CharacterAttributes
} from "./character-builder.js";

const mockFetch = vi.fn();
vi.mock("@vvugc/shared-http", () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetch(...args)
}));

function baseAttrs(overrides: Partial<CharacterAttributes> = {}): CharacterAttributes {
  return CharacterAttributesSchema.parse({
    gender: "woman",
    ageRange: "late_20s",
    bodyType: "athletic",
    hairStyle: "shoulder_length",
    hairColor: "dark_brown",
    skinTone: "medium",
    eyeColor: "brown",
    style: "athletic_activewear",
    ...overrides
  });
}

describe("CharacterAttributesSchema", () => {
  it("defaults characterType, style, and renderingStyle when omitted", () => {
    const attrs = CharacterAttributesSchema.parse({ gender: "man", ageRange: "30s" });
    expect(attrs.characterType).toBe("human");
    expect(attrs.style).toBe("casual_everyday");
    expect(attrs.renderingStyle).toBe("photorealistic");
  });

  it("requires gender and ageRange", () => {
    expect(() => CharacterAttributesSchema.parse({})).toThrow();
  });

  it("rejects a value outside the closed enums", () => {
    expect(() => CharacterAttributesSchema.parse({ gender: "woman", ageRange: "30s", hairColor: "rainbow" })).toThrow();
  });

  it("caps additionalDetails length", () => {
    expect(() =>
      CharacterAttributesSchema.parse({ gender: "woman", ageRange: "30s", additionalDetails: "x".repeat(501) })
    ).toThrow();
  });
});

describe("CHARACTER_ATTRIBUTE_OPTIONS", () => {
  it("exposes every enum's real option list for a UI picker to render", () => {
    expect(CHARACTER_ATTRIBUTE_OPTIONS.gender).toContain("woman");
    expect(CHARACTER_ATTRIBUTE_OPTIONS.gender).toContain("man");
    expect(CHARACTER_ATTRIBUTE_OPTIONS.hairStyle.length).toBeGreaterThan(3);
    expect(CHARACTER_ATTRIBUTE_OPTIONS.renderingStyle).toContain("photorealistic");
  });
});

describe("buildCharacterPrompt", () => {
  it("includes every provided attribute in the generated prompt", () => {
    const prompt = buildCharacterPrompt(baseAttrs());
    expect(prompt).toContain("woman");
    expect(prompt).toContain("late 20s");
    expect(prompt).toContain("athletic build");
    expect(prompt).toContain("medium skin tone");
    expect(prompt).toContain("dark brown shoulder length hair");
    expect(prompt).toContain("brown eyes");
    expect(prompt).toContain("athletic activewear clothing");
  });

  it("omits optional fields cleanly when not provided, without leaving stray fragments", () => {
    const prompt = buildCharacterPrompt(CharacterAttributesSchema.parse({ gender: "man", ageRange: "40s" }));
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain(", ,");
  });

  it("appends the requested angle and expression when given", () => {
    const prompt = buildCharacterPrompt(baseAttrs(), { angle: "profile shot", expression: "laughing" });
    expect(prompt).toContain("profile shot");
    expect(prompt).toContain("laughing expression");
  });

  it("includes additionalDetails verbatim", () => {
    const prompt = buildCharacterPrompt(baseAttrs({ additionalDetails: "small nose stud" }));
    expect(prompt).toContain("small nose stud");
  });

  it("always appends the synthetic/no-real-person guard, regardless of attributes", () => {
    const prompt = buildCharacterPrompt(baseAttrs());
    expect(prompt).toMatch(/fictional.*AI-generated person/i);
    expect(prompt).toMatch(/do not depict any real, identifiable individual/i);
  });

  it("varies meaningfully between two different variation options for the same attributes", () => {
    const a = buildCharacterPrompt(baseAttrs(), { angle: "front-facing headshot", expression: "warm" });
    const b = buildCharacterPrompt(baseAttrs(), { angle: "three-quarter angle headshot", expression: "calm" });
    expect(a).not.toBe(b);
  });
});

describe("generateCharacterPortraitBatch", () => {
  // Shaped like a real Google AI Studio key ("AIza" + 35 url-safe chars) so it
  // passes gemini.ts's format guard; the HTTP call itself is mocked below.
  const WELL_FORMED_GEMINI_KEY = "AIza" + "b".repeat(35);
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.GEMINI_API_KEY = WELL_FORMED_GEMINI_KEY;
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  function fakeImageResponse() {
    return {
      ok: true,
      json: async () => ({
        output_image: { data: Buffer.from("fake-png-bytes").toString("base64"), mime_type: "image/png" }
      })
    };
  }

  it("generates the default batch size (4) with distinct prompts per candidate", async () => {
    mockFetch.mockImplementation(async () => fakeImageResponse());
    const portraits = await generateCharacterPortraitBatch(baseAttrs());

    expect(portraits).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const prompts = portraits.map((p) => p.prompt);
    expect(new Set(prompts).size).toBe(4); // every candidate got a distinct angle/expression
    portraits.forEach((p, i) => expect(p.index).toBe(i));
  });

  it("respects a custom count, capped at 8", async () => {
    mockFetch.mockImplementation(async () => fakeImageResponse());
    const portraits = await generateCharacterPortraitBatch(baseAttrs(), { count: 20 });
    expect(portraits).toHaveLength(8);
    expect(mockFetch).toHaveBeenCalledTimes(8);
  });

  it("never generates fewer than 1 even if count is 0 or negative", async () => {
    mockFetch.mockImplementation(async () => fakeImageResponse());
    const portraits = await generateCharacterPortraitBatch(baseAttrs(), { count: 0 });
    expect(portraits).toHaveLength(1);
  });

  it("returns real, non-empty image bytes for every candidate", async () => {
    mockFetch.mockImplementation(async () => fakeImageResponse());
    const portraits = await generateCharacterPortraitBatch(baseAttrs(), { count: 2 });
    for (const p of portraits) {
      expect(p.imageBytes.length).toBeGreaterThan(0);
      expect(p.mimeType).toBe("image/png");
    }
  });
});
