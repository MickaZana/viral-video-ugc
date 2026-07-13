import Anthropic from "@anthropic-ai/sdk";
import { requireEnvVar } from "@vvugc/shared-config";
import type { AssembledVideo, RewrittenScript } from "@vvugc/shared-schema";

export interface QaResult {
  score: number;
  flags: string[];
}

const SYSTEM_PROMPT = `You are a virality QA analyst for short-form vertical video. You do not see the
rendered pixels — you score based on the script and assembly metadata, the same signals a human
editor would check before publishing: hook strength, pacing, trending-phrase usage, CTA clarity,
duration fit, and platform fit.

Score 0-100. Flag concrete, specific issues as short slugs (e.g. "hook_too_long",
"weak_cta", "duration_mismatch") — omit flags that don't apply, don't pad the list.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"score": number, "flags": string[]}`;

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
  opts: { dryRun?: boolean } = {}
): Promise<QaResult> {
  if (opts.dryRun) return heuristicScore(assembled, script);

  const apiKey = requireEnvVar("ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey });

  const userPrompt = `Platform: ${assembled.platform}
Aspect ratio: ${assembled.aspectRatio}
Duration: ${assembled.durationSec}s (target ${script.durationSec}s)
Captions burned in: ${assembled.captionsBurned}
Hashtags: ${assembled.hashtags.join(", ") || "none"}

Hook: ${script.hook}
Points:
${script.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}
CTA: ${script.cta}
Trending phrases used: ${script.trendingPhrases.join(", ") || "none"}`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }]
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude QA response contained no text block");
  }

  const parsed = JSON.parse(extractJson(textBlock.text));
  return { score: Math.max(0, Math.min(100, parsed.score)), flags: parsed.flags ?? [] };
}

/** Offline fallback for --dry-run — no API call, deterministic score so dry runs stay reproducible. */
function heuristicScore(assembled: AssembledVideo, script: RewrittenScript): QaResult {
  const flags: string[] = [];
  let score = 50;

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

  return { score: Math.min(score, 100), flags };
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
