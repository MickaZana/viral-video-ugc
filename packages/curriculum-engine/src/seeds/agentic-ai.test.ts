import { describe, expect, it } from "vitest";
import { CurriculumSeedSchema } from "../schema.js";
import { SEED_AGENTIC_AI } from "./agentic-ai.js";

describe("SEED_AGENTIC_AI", () => {
  it("is a valid CurriculumSeed", () => {
    expect(() => CurriculumSeedSchema.parse(SEED_AGENTIC_AI)).not.toThrow();
  });

  it("has exactly 20 modules", () => {
    expect(SEED_AGENTIC_AI.modules).toHaveLength(20);
  });

  it("keeps the module titles verbatim and in order", () => {
    expect(SEED_AGENTIC_AI.modules[3].title).toBe("Tools and Function Calling");
    expect(SEED_AGENTIC_AI.modules[19].title).toBe("Capstone Autonomous Application");
  });

  it("gives every module a one-line goal", () => {
    for (const m of SEED_AGENTIC_AI.modules) {
      expect(m.goal.length).toBeGreaterThan(0);
    }
  });

  it("carries the course meta the plan request needs", () => {
    expect(SEED_AGENTIC_AI.course.title).toBe("Agentic AI Simplified");
    expect(SEED_AGENTIC_AI.course.moduleCount).toBe(20);
    expect(SEED_AGENTIC_AI.course.lessonsPerModule).toBe(10);
    expect(SEED_AGENTIC_AI.course.longFormTargetMin).toBe(15);
  });
});
