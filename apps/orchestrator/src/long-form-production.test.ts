import { describe, expect, it } from "vitest";
import { planLongFormProduction } from "./long-form-production.js";

const request = {
  idea: "Explain how a small team can build a repeatable creative workflow.",
  sourcePointer: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  durationSec: 300,
  aspectRatio: "16:9" as const,
  videoProviderChain: ["wan", "replicate"] as const,
  useHiggsfield: false
};

describe("planLongFormProduction", () => {
  it("uses injected transcript resolution while passing only an abstract pattern into the final plan", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const plan = await planLongFormProduction(request, {
      resolveSource: async () => ({ videoId: "source", source: "platform_captions", text: "A transcript that must not be copied.", segments: [] }),
      generateText: async ({ userPrompt }) => {
        prompts.push(userPrompt);
        calls += 1;
        if (calls === 1) return JSON.stringify({ summary: "Fast hook, three escalating beats, visual reset before a direct CTA." });
        return `Here is the plan:\n${JSON.stringify({
          title: "A Repeatable Creative Workflow",
          durationSec: 300,
          aspectRatio: "16:9",
          scenes: [
            { id: "intro", narration: "Start with a focused promise.", visualPrompt: "Original team planning footage.", durationSec: 120, visualMode: "generated_video", provider: "wan", proofStatus: "illustrative" },
            { id: "method", narration: "Show the repeatable method.", visualPrompt: "Animated diagram of a workflow.", durationSec: 100, visualMode: "animated_image", proofStatus: "illustrative", illustrativeFallback: { substitutedFor: "screen_recording", reason: "No screen recording was supplied.", proofStatus: "illustrative" } },
            { id: "close", narration: "Close with a practical next step.", visualPrompt: "Clean closing slide.", durationSec: 80, visualMode: "slide", proofStatus: "illustrative" }
          ]
        })}`;
      }
    });
    expect(plan.durationSec).toBe(300);
    expect(plan.scenes.reduce((sum, scene) => sum + scene.durationSec, 0)).toBe(300);
    expect(plan.scenes[1].illustrativeFallback?.substitutedFor).toBe("screen_recording");
    expect(prompts[0]).toContain("must not be copied");
    expect(prompts[1]).toContain("wholly original sequence");
    expect(prompts[1]).not.toContain(request.sourcePointer);
  });

  it("allows exactly one repair attempt and then returns the repaired plan", async () => {
    let calls = 0;
    const plan = await planLongFormProduction({ ...request, sourcePointer: undefined }, {
      generateText: async () => {
        calls += 1;
        if (calls === 1) return "not json";
        return JSON.stringify({
          title: "Repair",
          durationSec: 300,
          aspectRatio: "16:9",
          scenes: [
            { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "slide", proofStatus: "illustrative" },
            { id: "b", narration: "B", visualPrompt: "B", durationSec: 150, visualMode: "slide", proofStatus: "illustrative" }
          ]
        });
      }
    });
    expect(calls).toBe(2);
    expect(plan.title).toBe("Repair");
  });

  it.each([
    ["out-of-chain provider", { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "generated_video", provider: "higgsfield", proofStatus: "illustrative" }],
    ["provider on slide", { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "slide", provider: "wan", proofStatus: "illustrative" }],
    ["verified generated image", { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "animated_image", proofStatus: "verified" }],
    ["model-selected user recording", { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "user_recording", proofStatus: "verified" }]
  ])("rejects %s", async (_label, badScene) => {
    await expect(planLongFormProduction({ ...request, sourcePointer: undefined }, {
      generateText: async () => JSON.stringify({
        title: "Invalid", durationSec: 300, aspectRatio: "16:9",
        scenes: [badScene, { id: "b", narration: "B", visualPrompt: "B", durationSec: 150, visualMode: "slide", proofStatus: "illustrative" }]
      })
    })).rejects.toThrow();
  });

  it("rejects an unsupported source before invoking the resolver", async () => {
    let resolved = false;
    await expect(planLongFormProduction({ ...request, sourcePointer: "https://example.invalid/video" }, {
      resolveSource: async () => {
        resolved = true;
        throw new Error("must not resolve");
      },
      generateText: async () => "{}"
    })).rejects.toThrow(/unsupported source URL/i);
    expect(resolved).toBe(false);
  });

  it("caps transcript text sent to source analysis", async () => {
    const prompts: string[] = [];
    let call = 0;
    const plan = await planLongFormProduction(request, {
      resolveSource: async () => ({
        videoId: "source", source: "platform_captions", text: "x".repeat(25_000), segments: []
      }),
      generateText: async ({ userPrompt }) => {
        prompts.push(userPrompt);
        call += 1;
        if (call === 1) return JSON.stringify({ summary: "A bounded hook and beat pattern." });
        return JSON.stringify({
          title: "Bounded", durationSec: 300, aspectRatio: "16:9",
          scenes: [
            { id: "a", narration: "A", visualPrompt: "A", durationSec: 150, visualMode: "slide", proofStatus: "illustrative" },
            { id: "b", narration: "B", visualPrompt: "B", durationSec: 150, visualMode: "slide", proofStatus: "illustrative" }
          ]
        });
      }
    });
    expect(plan.title).toBe("Bounded");
    expect(prompts[0]).toContain("[transcript truncated]");
    expect(prompts[0].length).toBeLessThan(20_500);
  });

  it("provides a deterministic offline plan", async () => {
    const plan = await planLongFormProduction(request, { dryRun: true });
    expect(plan.aspectRatio).toBe("16:9");
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes.reduce((sum, scene) => sum + scene.durationSec, 0)).toBe(300);
  });
});
