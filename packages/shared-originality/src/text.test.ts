import { describe, expect, it } from "vitest";
import { tokenize } from "./text.js";

describe("tokenize", () => {
  it("tokenizes plain English text", () => {
    expect(tokenize("Hello, world! This is a test.")).toEqual(["hello", "world", "this", "is", "a", "test"]);
  });

  it("does not silently strip non-Latin-script text to nothing (Unicode-aware, not ASCII-only)", () => {
    // A naive [^a-z0-9] filter reduces all of these to an empty token list —
    // that's the real bug this test guards against, not just "scores less precisely".
    expect(tokenize("こんにちは世界")).not.toEqual([]);
    expect(tokenize("مرحبا بالعالم")).not.toEqual([]);
    expect(tokenize("안녕하세요 세계")).not.toEqual([]);
  });

  it("preserves accented Latin characters instead of stripping them", () => {
    expect(tokenize("¿Cómo estás? Muy bién, gracias.")).toEqual(["cómo", "estás", "muy", "bién", "gracias"]);
  });
});
