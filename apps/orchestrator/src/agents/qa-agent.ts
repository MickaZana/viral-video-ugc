import type { CostLedger } from "@vvugc/shared-cost";
import type { AssembledVideo, ProductProfile, CreatorProfile, RewrittenScript, UGCTemplate } from "@vvugc/shared-schema";
import { generateWithFailover } from "./llm-failover.js";
import { validateTemplateScript } from "../templates.js";


export interface QaResult {
  score: number;
  flags: string[];
  structuralScore?: number;
}

const SYSTEM_PROMPT = `You are a virality QA analyst for short-form vertical video. You do not see the
rendered pixels — you score based on the script and assembly metadata, the same signals a human
editor would check before publishing: hook strength, pacing, trending-phrase usage, CTA clarity,
duration fit, and platform fit.

Score 0-100. Flag concrete, specific issues as short slugs:
- "hook_too_long": if hook is too wordy
- "weak_hook": if hook is not scroll-stopping, lacks emotion, or doesn't raise a loop
- "missing_cta": if there is no clear call to action or payoff
- "weak_cta": if CTA is generic or low-energy
- "duration_mismatch": if final duration is far from target
- "unsupported_claims": if the script makes benefits/features claims that are NOT backed by the product profile's allowed claims, features, or primary benefits
- "template_mismatch": if a template is selected but the script structure does not align with the template's required beats
- "template_forbidden_pattern": if the script contains template-specific forbidden patterns

Omit flags that don't apply, don't pad the list.
When a template is selected, also return structuralScore (0-100) based only on declared
template beats, hook, CTA, and forbidden patterns. Never omit structuralScore for a templated run.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"score": number, "flags": string[], "structuralScore"?: number}`;

/**
 * Video generation vendors (Higgsfield, Kling, etc.) are used purely for pixel generation —
 * Claude is the sole agent responsible for judging the result, so this never calls a vendor's
 * built-in scoring tool (e.g. Higgsfield's virality_predictor). Vendor scoring tools are
 * pixel-aware but brand/strategy-blind; Claude already has the full script/brand-voice context
 * from the rewrite stage, which matters more for this pipeline's scoring than seeing the frames.
 */
export async function scoreVideo(
  assembled: AssembledVideo,
  script: RewrittenScript,
  opts: { dryRun?: boolean; costLedger?: CostLedger; productProfile?: ProductProfile; creatorProfile?: CreatorProfile; template?: UGCTemplate } = {}
): Promise<QaResult> {
  if (opts.dryRun) return heuristicScore(assembled, script, opts.productProfile, opts.creatorProfile, opts.template);

  const userPrompt = `Platform: ${assembled.platform}
Aspect ratio: ${assembled.aspectRatio}
Duration: ${assembled.durationSec}s (target ${script.durationSec}s)
Captions burned in: ${assembled.captionsBurned}
Hashtags: ${assembled.hashtags.join(", ") || "none"}
Product claims policy: ${opts.productProfile ? JSON.stringify({ claims: opts.productProfile.claims, forbiddenClaims: opts.productProfile.forbiddenClaims, CTA: opts.productProfile.callToAction }) : "none configured"}
Creator safety policy: ${opts.creatorProfile ? JSON.stringify({ prohibitedDepictions: opts.creatorProfile.prohibitedDepictions, tone: opts.creatorProfile.tone, avatarMode: opts.creatorProfile.avatarMode }) : "none configured"}
Template policy: ${opts.template ? JSON.stringify({ id: opts.template.id, rubric: opts.template.qaRubric, structure: opts.template.scriptStructure, captionStyle: opts.template.captionStyle }) : "freeform"}

Hook: ${script.hook}
Points:
${script.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}
CTA: ${script.cta}
Trending phrases used: ${script.trendingPhrases.join(", ") || "none"}`;

  // Sonnet 5: this is the pipeline's gatekeeping judgment call — it decides what reaches a
  // human's review queue at all — so it keeps the balanced default model rather than the
  // cheaper or pricier ends of the mix. See CLAUDE.md's "Model selection" section.
  const model = "claude-sonnet-5";
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 512,
    anthropicModel: model,
    geminiModel: "gemini-2.5-pro",
    stage: "qa_score",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJson(text));
  const structuralScore = opts.template ? deterministicStructuralScore(opts.template, script, parsed.structuralScore) : undefined;
  return { score: Math.max(0, Math.min(100, parsed.score)), flags: parsed.flags ?? [], ...(opts.template ? { structuralScore } : {}) };
}

/** Offline fallback for --dry-run — no API call, deterministic score so dry runs stay reproducible. */
function heuristicScore(assembled: AssembledVideo, script: RewrittenScript, product?: ProductProfile, creator?: CreatorProfile, template?: UGCTemplate): QaResult {
  const flags: string[] = [];
  let score = 50;

  const scriptText = [script.hook, ...script.points, script.cta].join(" ").toLowerCase();
  if (product?.forbiddenClaims.some((claim) => scriptText.includes(claim.toLowerCase()))) {
    flags.push("forbidden_product_claim");
    score -= 20;
  }
  if (creator?.prohibitedDepictions.some((term) => scriptText.includes(term.toLowerCase()))) { flags.push("prohibited_creator_depiction"); score -= 25; }

  const hookWords = script.hook.split(/\s+/).length;
  if (hookWords <= 12) score += 15;
  else flags.push("hook_too_long");

  if (script.trendingPhrases.length >= 2) score += 10;
  else flags.push("low_trending_phrase_density");

  const durationDelta = Math.abs(assembled.durationSec - script.durationSec);
  if (durationDelta <= 2) score += 10;
  else flags.push("duration_mismatch");

  if (assembled.captionsBurned) score += 10;
  else flags.push("no_captions");

  if (assembled.hashtags.length >= 3) score += 5;
  else flags.push("few_hashtags");

  if (!script.cta.trim()) { flags.push("missing_cta"); score -= 15; }
  if (script.hook.trim().split(/\s+/).length < 3) { flags.push("weak_hook"); score -= 10; }

  if (product) {
    const approvedWords = [
      product.name,
      ...product.primaryBenefits,
      ...product.features,
      ...product.claims
    ].join(" ").toLowerCase();
    const claimKeywords = ["guarantee", "cure", "revolutionary", "proven", "100%", "permanently", "scientific"];
    let hasUnsupported = false;
    for (const word of claimKeywords) {
      if (scriptText.includes(word) && !approvedWords.includes(word)) {
        hasUnsupported = true;
        break;
      }
    }
    if (hasUnsupported) {
      flags.push("unsupported_claims");
      score -= 10;
    }
  }

  for (const issue of validateTemplateScript(template, script)) {
    if (issue === "template_missing_beats") flags.push("template_mismatch");
    else if (issue === "template_forbidden_pattern") flags.push("template_forbidden_pattern");
  }
  const structuralScore = template ? deterministicStructuralScore(template, script) : undefined;
  return { score: Math.min(score, 100), flags, ...(template ? { structuralScore } : {}) };
}

function deterministicStructuralScore(template: UGCTemplate, script: RewrittenScript, modelScore?: unknown): number {
  const issues = validateTemplateScript(template, script);
  const fallback = Math.max(0, 100 - issues.length * 25);
  const candidate = typeof modelScore === "number" && Number.isFinite(modelScore) ? modelScore : fallback;
  return Math.max(0, Math.min(100, candidate));
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
