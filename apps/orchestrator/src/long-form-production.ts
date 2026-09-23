import {
  LongFormProductionRequestSchema,
  LongFormScenePlanSchema,
  type LongFormProductionRequest,
  type LongFormScenePlan
} from "@vvugc/shared-schema";
import type { Transcript } from "@vvugc/shared-schema";
import type { CostLedger } from "@vvugc/shared-cost";
import { generateWithFailover } from "./agents/llm-failover.js";
import { fetchRemixTranscript, parseSourceUrl } from "./remix-source.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

export interface LongFormPlanTextRequest {
  system: string;
  userPrompt: string;
  maxTokens: number;
  stage: string;
}

export type LongFormPlanTextGenerator = (request: LongFormPlanTextRequest) => Promise<string>;

export type LongFormSourceResolver = (sourcePointer: string) => Promise<Transcript>;

export interface LongFormProductionPlanOptions {
  dryRun?: boolean;
  costLedger?: CostLedger;
  /** Injected by deterministic tests and callers that already own an LLM client. */
  generateText?: LongFormPlanTextGenerator;
  /** Injectable transcript resolver for tests; the default accepts supported social URLs only. */
  resolveSource?: LongFormSourceResolver;
  sourceOutDir?: string;
}

const SYSTEM_PROMPT = `You are the planning stage of an original long-form video producer.
Create a complete, original narration and visual plan from the user's idea. The application may
resolve a supported social source pointer to captions/transcript for abstract pattern analysis.
You must not independently fetch the source, quote it, copy its transcript, closely paraphrase
it, recreate its script, or make factual claims from it. Derive a new sequence in your own words.

Return ONLY one JSON object with this exact shape:
{"title":string,"durationSec":number,"aspectRatio":"16:9","scenes":[{
"id":string,"narration":string,"visualPrompt":string,"durationSec":number,
"visualMode":"generated_video"|"slide"|"animated_image"|"user_recording",
"provider":"wan"|"replicate"|"higgsfield" (only for generated_video),
"proofStatus":"verified"|"illustrative"|"required_before_release",
"illustrativeFallback":{"substitutedFor":"screen_recording","reason":string,"proofStatus":"illustrative"}
}]}

The scene durations must be positive integers and sum exactly to durationSec. Use the requested
duration and 16:9 ratio exactly. Since no uploaded recording is supplied, never choose
user_recording. Use generated_video for footage, slide for explanatory graphics, and use
animated_image with illustrativeFallback when a screen recording would otherwise be needed.
Generated, slide, and animated visuals are never verified proof: label them illustrative or
required_before_release. Only a supplied user_recording with an asset path may be verified.
Only include provider when visualMode is generated_video, and select it from the requested chain.`;

const SOURCE_ANALYSIS_SYSTEM_PROMPT = `Analyze a supplied viral-video transcript only for high-level structure.
Return ONLY JSON: {"summary":string}. Describe hook shape, beat order, pacing, emotional arc,
visual rhythm, and CTA pattern in at most 800 characters. Do not quote, reproduce, or closely
paraphrase any line. Do not make factual claims from the transcript. This summary will guide a
new original production and must explicitly preserve originality.`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Long-form planner returned no JSON object");
  return text.slice(start, end + 1);
}

function dryRunPlan(request: LongFormProductionRequest): LongFormScenePlan {
  const first = Math.floor(request.durationSec / 2);
  const second = request.durationSec - first;
  const provider = request.videoProviderChain[0];
  return LongFormScenePlanSchema.parse({
    title: request.idea.slice(0, 160),
    durationSec: request.durationSec,
    aspectRatio: "16:9",
    scenes: [
      {
        id: "scene-1",
        narration: `Opening: ${request.idea}`,
        visualPrompt: "A polished cinematic opening that introduces the central idea.",
        durationSec: first,
        visualMode: "generated_video",
        provider,
        proofStatus: "illustrative"
      },
      {
        id: "scene-2",
        narration: "Develop the idea with a clear original explanation and a practical conclusion.",
        visualPrompt: "Clean explanatory slide with animated illustrative imagery and readable labels.",
        durationSec: second,
        visualMode: "slide",
        proofStatus: "illustrative"
      }
    ]
  });
}

function validatePlanAgainstRequest(plan: LongFormScenePlan, request: LongFormProductionRequest): LongFormScenePlan {
  const allowed = new Set(request.videoProviderChain);
  for (const scene of plan.scenes) {
    if (scene.visualMode === "generated_video") {
      if (!scene.provider || !allowed.has(scene.provider)) {
        throw new Error(`Generated scene ${scene.id} must select a provider from the requested chain`);
      }
    } else if (scene.provider) {
      throw new Error(`Non-generated scene ${scene.id} cannot carry a video provider`);
    }
    if (scene.proofStatus === "verified" && !(scene.visualMode === "user_recording" && scene.assetPath)) {
      throw new Error(`Scene ${scene.id} claims verified proof without a supplied user recording`);
    }
    if (scene.visualMode === "user_recording" && !scene.assetPath) {
      throw new Error(`Scene ${scene.id} selected user_recording without an uploaded asset`);
    }
  }
  return plan;
}

function liveGenerator(costLedger?: CostLedger): LongFormPlanTextGenerator {
  return async ({ system, userPrompt, maxTokens, stage }) => {
    const result = await generateWithFailover({
      system,
      userPrompt,
      maxTokens,
      anthropicModel: process.env.ANTHROPIC_LONG_FORM_MODEL || "claude-sonnet-5",
      geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
      grokModel: process.env.GROK_MODEL || "grok-4.3",
      stage,
      costLedger
    });
    return result.text;
  };
}

/**
 * Plans an original 5–10 minute 16:9 production. Supported social pointers are
 * resolved through the existing strict transcript ingress, then reduced to a
 * bounded structural summary; arbitrary URLs are rejected before resolution.
 * Invalid structured output gets one bounded repair attempt, then fails closed.
 */
export async function planLongFormProduction(
  input: unknown,
  options: LongFormProductionPlanOptions = {}
): Promise<LongFormScenePlan> {
  const request = LongFormProductionRequestSchema.parse(input);
  if (options.dryRun) return dryRunPlan(request);

  const generateText = options.generateText ?? liveGenerator(options.costLedger);
  let sourcePattern = "No source pattern supplied. Build an original structure from the idea alone.";
  if (request.sourcePointer) {
    if (!parseSourceUrl(request.sourcePointer)) {
      throw new Error("unsupported source URL — paste a TikTok, YouTube, or Instagram (Reels) link");
    }
    let ownedSourceOutDir: string | undefined;
    const sourceOutDir = options.sourceOutDir ?? (ownedSourceOutDir = mkdtempSync(join(tmpdir(), "vvugc-long-form-source-")));
    const resolveSource = options.resolveSource ?? (async (pointer: string) => {
      const { transcript } = await fetchRemixTranscript(pointer, sourceOutDir, "long-form production");
      return transcript;
    });
    let transcript: Transcript;
    try {
      transcript = await resolveSource(request.sourcePointer);
    } finally {
      if (ownedSourceOutDir) rmSync(ownedSourceOutDir, { recursive: true, force: true });
    }
    const analysisText = await generateText({
      system: SOURCE_ANALYSIS_SYSTEM_PROMPT,
      userPrompt: `Derive a high-level pattern summary from this transcript. Never reproduce its wording.\n\n${transcript.text.slice(0, 20_000)}${transcript.text.length > 20_000 ? "\n[transcript truncated]" : ""}`,
      maxTokens: 700,
      stage: "long_form_source_analysis"
    });
    const analysis = JSON.parse(extractJson(analysisText)) as { summary?: unknown };
    if (typeof analysis.summary !== "string" || analysis.summary.trim().length === 0 || analysis.summary.length > 800) {
      throw new Error("Long-form source analysis did not return a bounded summary");
    }
    sourcePattern = analysis.summary;
  }
  const userPrompt = [
    `Idea: ${request.idea}`,
    `Requested duration in seconds: ${request.durationSec}`,
    `Requested aspect ratio: ${request.aspectRatio}`,
    `Allowed video provider chain: ${request.videoProviderChain.join(", ")}`,
    `Higgsfield explicitly selected: ${request.useHiggsfield ? "yes" : "no"}`,
    `High-level source pattern only; create a wholly original sequence and wording: ${sourcePattern}`
  ].join("\n");

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0
      ? userPrompt
      : `${userPrompt}\n\nYour previous response failed schema validation. Repair it and return ONLY valid JSON. Ensure scene durations sum exactly to ${request.durationSec}, use exactly 16:9, and do not add prose.`;
    try {
      const text = await generateText({
        system: SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: Math.min(16000, Math.max(2048, request.durationSec * 5)),
        stage: "long_form_scene_plan"
      });
      return validatePlanAgainstRequest(LongFormScenePlanSchema.parse(JSON.parse(extractJson(text))), request);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Long-form scene plan failed structured validation after one repair attempt: ${String(lastError)}`);
}

export { SYSTEM_PROMPT as LONG_FORM_PLAN_SYSTEM_PROMPT };
