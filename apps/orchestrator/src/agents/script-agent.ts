import type { CostLedger } from "@vvugc/shared-cost";
import { RewrittenScriptSchema, type BrandKit, type Platform, type ProductProfile, type CreatorProfile, type UGCTemplate, type RewrittenScript, type Transcript } from "@vvugc/shared-schema";
import { generateWithFailover } from "./llm-failover.js";
import { validateTemplateScript } from "../templates.js";

const SYSTEM_PROMPT = `You are a viral short-form video script strategist. Given a transcript of an
already-viral video, rewrite it into a NEW original script for a different creator that keeps the
proven structural elements that made the source work, without copying its wording verbatim:

- Hook (first 1-3 seconds): a scroll-stopping opening line
- Point structure: 2-4 concise beats building toward a payoff, following an emotional arc
  (curiosity -> tension -> payoff, or similar)
- Trending phrases: current platform slang/phrasing patterns woven in naturally, not forced
- CTA: a short, platform-native call to action (follow/comment/share hook, not generic "like and subscribe")
- Platform-specific pacing notes for how delivery should differ across target platforms

Emotional arc requirements (non-negotiable):
- Hook MUST trigger ONE of: fear, curiosity, social proof, or controversy — established in the first 3 words
- Use the "open loop" technique: the hook raises a question or creates tension that only the points resolve
- Point 1 must escalate tension, not resolve it — resolution belongs in the final point or CTA
- CTA must feel like a natural payoff to the emotional journey, not a generic bolted-on request

Platform-specific fields you MUST include in platformNotes for every target platform:
- tiktok: a trending audio cue suggestion (describe the mood/energy of the sound, not a song title)
- youtube_shorts: optimal thumbnail text (3 words max, high-contrast, front-loaded benefit)
- instagram_reels: best cover frame timestamp suggestion (e.g. "0:04 — subject leans in")
- facebook: caption opening line (different from the hook — the caption is read before the video plays)

Respond with ONLY a JSON object matching this shape, no prose, no markdown fences:
{
  "hook": string,
  "points": string[],
  "cta": string,
  "trendingPhrases": string[],
  "platformNotes": { [platform: string]: string }
}`;


export async function rewriteScript(
  transcript: Transcript,
  opts: {
    niche: string;
    brandVoice: string;
    brandKit?: BrandKit;
    productProfile?: ProductProfile;
    creatorProfile?: CreatorProfile;
    template?: UGCTemplate;
    durationSec: number;
    platforms: Platform[];
    /** BCP-47-ish tag (e.g. "en", "es", "pt-BR") — defaults to English. The source
     *  transcript can be in any language; this only controls the OUTPUT script's
     *  language, so a non-English source can still be rewritten into English (or
     *  vice versa) rather than assumed to match. */
    locale?: string;
    dryRun?: boolean;
    costLedger?: CostLedger;
    /** Adaptive intelligence injection — learned from pipeline performance history */
    adaptivePromptInjection?: string;
    /** Optional riffed discovery brief (angle / hook template / structure / patterns /
     *  dos / donts) the operator edited in the control panel. When present, it is
     *  folded into the user prompt so the generated script leads with those creative
     *  directions — this is what makes "discover → riff brief → run" actually shape
     *  the output rather than being cosmetic. Typed loosely (unknown) on purpose: the
     *  brief shape lives in the discovery analyzer, not in shared-schema. */
    discoveryBrief?: unknown;
  }
): Promise<RewrittenScript> {
  const locale = opts.locale ?? "en";
  if (opts.dryRun) return mockRewrittenScript(transcript, { ...opts, locale });

  const discoveryBriefBlock = opts.discoveryBrief ? buildBriefBlock(opts.discoveryBrief) : "";

  // Adaptive intelligence — learned from pipeline performance history
  const adaptiveBlock = opts.adaptivePromptInjection ? `\n\n${opts.adaptivePromptInjection}` : "";

  let templateInstructions = "";
  if (opts.template) {
    const expectedPointsCount = Math.max(0, opts.template.scriptStructure.length - 2);
    templateInstructions = `\n\nCRITICAL TEMPLATE CONSTRAINT: You MUST follow the selected UGC template "${opts.template.name}".
1. The hook MUST correspond to the "${opts.template.scriptStructure[0]}" beat and utilize/adapt one of the following hook patterns: ${JSON.stringify(opts.template.hookPatterns)}.
2. The points array MUST have EXACTLY ${expectedPointsCount} items, each corresponding 1-to-1 to the following beats in order:
${opts.template.scriptStructure.slice(1, -1).map((beat, i) => `   Point ${i + 1}: "${beat}"`).join("\n")}
3. The cta MUST correspond to the "${opts.template.scriptStructure[opts.template.scriptStructure.length - 1]}" beat and utilize/adapt one of the following CTA patterns: ${JSON.stringify(opts.template.ctaPatterns)}.
4. You MUST NOT include any of the following forbidden patterns/claims in the script: ${JSON.stringify(opts.template.forbiddenPatterns)}.`;
  }

  const userPrompt = `Niche: ${opts.niche}
Brand voice: ${opts.brandVoice}
Brand kit rules: ${opts.brandKit ? JSON.stringify(opts.brandKit) : "none configured"}
Product profile: ${opts.productProfile ? JSON.stringify({ name: opts.productProfile.name, description: opts.productProfile.shortDescription || opts.productProfile.description, targetCustomer: opts.productProfile.targetCustomer, benefits: opts.productProfile.primaryBenefits, claims: opts.productProfile.claims, forbiddenClaims: opts.productProfile.forbiddenClaims, callToAction: opts.productProfile.callToAction }) : "none configured"}
Selected UGC template: ${opts.template ? JSON.stringify({ id: opts.template.id, structure: opts.template.scriptStructure, hooks: opts.template.hookPatterns, CTA: opts.template.ctaPatterns, forbidden: opts.template.forbiddenPatterns }) : "freeform"}
Creator direction: ${opts.creatorProfile ? JSON.stringify({ tone: opts.creatorProfile.tone, speechStyle: opts.creatorProfile.speechStyle, visualStyle: opts.creatorProfile.visualStyle }) : "none configured"}
Target duration: ${opts.durationSec} seconds
Target platforms: ${opts.platforms.join(", ")}
Write the script in this language (BCP-47 tag): ${locale}. Trending phrases should be
native to that language/platform culture, not translated English slang.${templateInstructions}
${discoveryBriefBlock}${adaptiveBlock}
Source transcript:
"""
${transcript.text}
"""`;

  // Fable 5: this is the hook/point/CTA creative-writing bottleneck — the single stage where
  // output quality has the most leverage over whether a finished video is worth generating at
  // all — so it gets the premium model. See CLAUDE.md's "Model selection" section.
  const model = "claude-fable-5";
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1024,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "script_rewrite",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJson(text));
  let hook = parsed.hook;
  let points = parsed.points ?? [];
  let cta = parsed.cta;

  if (opts.template) {
    const repaired = repairScriptStructure(opts.template, { hook, points, cta });
    hook = repaired.hook;
    points = repaired.points;
    cta = repaired.cta;
  }

  const result = RewrittenScriptSchema.parse({
    videoId: transcript.videoId,
    hook,
    points,
    cta,
    durationSec: opts.durationSec,
    brandVoice: opts.brandVoice,
    locale,
    trendingPhrases: parsed.trendingPhrases ?? [],
    platformNotes: parsed.platformNotes
  });
  const templateErrors = validateTemplateScript(opts.template, result);
  if (templateErrors.length) throw new Error(`template script validation failed: ${templateErrors.join(", ")}`);
  const forbiddenClaimErrors = validateProductForbiddenClaims(opts.productProfile, result);
  if (forbiddenClaimErrors.length) throw new Error(`product claim validation failed: ${forbiddenClaimErrors.join(", ")}`);
  return result;
}

export function repairScriptStructure(
  template: UGCTemplate,
  script: { hook: string; points: string[]; cta: string }
): { hook: string; points: string[]; cta: string } {
  const expected = Math.max(0, template.scriptStructure.length - 2);
  if (expected === 0) return { ...script, points: [] };

  // A clip is generated for every point, and each one needs a corresponding
  // template beat. Fold excess model output into the final expected beat rather
  // than allowing an unbounded extra clip with no shot intention.
  if (script.points.length > expected) {
    return {
      ...script,
      points: [...script.points.slice(0, expected - 1), script.points.slice(expected - 1).join(" ")]
    };
  }

  if (script.points.length === expected) return script;

  let repairedPoints: string[] = [];
  for (const pt of script.points) {
    if (repairedPoints.length >= expected) {
      repairedPoints.push(pt);
      continue;
    }
    const sentences = pt.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length > 1) {
      repairedPoints.push(...sentences);
    } else {
      repairedPoints.push(pt);
    }
  }

  while (repairedPoints.length < expected) {
    repairedPoints.push(`[repaired beat] Continued detail.`);
  }

  if (repairedPoints.length > expected) {
    const kept = repairedPoints.slice(0, expected - 1);
    const rest = repairedPoints.slice(expected - 1).join(" ");
    kept.push(rest);
    repairedPoints = kept;
  }

  return {
    ...script,
    points: repairedPoints
  };
};

/** Product-profile prohibitions are a deterministic post-model safety gate. */
function validateProductForbiddenClaims(product: ProductProfile | undefined, script: RewrittenScript): string[] {
  if (!product?.forbiddenClaims.length) return [];
  const scriptText = [script.hook, ...script.points, script.cta].join(" ").toLocaleLowerCase();
  return product.forbiddenClaims
    .filter((claim) => scriptText.includes(claim.toLocaleLowerCase()))
    .map((claim) => `forbidden_product_claim:${claim}`);
}

function mockRewrittenScript(
  transcript: Transcript,
  opts: { niche: string; brandVoice: string; durationSec: number; locale: string; template?: UGCTemplate }
): RewrittenScript {
  const beatNames = opts.template?.scriptStructure.slice(1, -1) ?? [];
  return RewrittenScriptSchema.parse({
    videoId: transcript.videoId,
    hook: `[mock] ${transcript.videoId ? `(${transcript.videoId}) ` : ""}Wait, nobody told you this about ${opts.niche}?`,
    points: beatNames.length ? beatNames.map((beat, i) => `[mock] ${beat} — the specific detail that makes this useful (${i + 1}).`) : [
      "[mock] Here's the first thing that changes everything.",
      "[mock] And here's why that actually matters."
    ],
    cta: "[mock] Follow for part 2.",
    durationSec: opts.durationSec,
    brandVoice: opts.brandVoice,
    locale: opts.locale,
    trendingPhrases: ["no cap", "wait for it"]
  });
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}

/**
 * Renders the operator's riffed discovery brief into a prompt section. Defensive by
 * design — the brief arrives as loosely-typed JSON from the control panel, so every
 * field is checked before use and ignored if missing/malformed.
 */
function buildBriefBlock(brief: unknown): string {
  if (!brief || typeof brief !== "object") return "";
  const b = brief as Record<string, unknown>;
  const pick = (key: string): string[] =>
    Array.isArray(b[key]) ? (b[key] as unknown[]).filter((x) => typeof x === "string") : [];

  const lines = ["\nDiscovery brief (riffed by the operator — lead with these creative directions):"];
  if (typeof b.angle === "string") lines.push(`Angle: ${b.angle}`);
  if (typeof b.hookTemplate === "string") lines.push(`Hook template: ${b.hookTemplate}`);
  const structure = pick("structure");
  if (structure.length) lines.push(`Structure: ${structure.join(" → ")}`);
  const patterns = pick("patterns");
  if (patterns.length) lines.push(`Patterns to lean into: ${patterns.join(", ")}`);
  const dos = pick("dos");
  if (dos.length) lines.push(`Do: ${dos.join("; ")}`);
  const donts = pick("donts");
  if (donts.length) lines.push(`Don't: ${donts.join("; ")}`);
  return lines.join("\n");
}
