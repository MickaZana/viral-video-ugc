import type { CostLedger } from "@vvugc/shared-cost";
import { RewrittenScriptSchema, type BrandKit, type Platform, type RewrittenScript, type Transcript } from "@vvugc/shared-schema";
import { generateWithFailover } from "./llm-failover.js";

const SYSTEM_PROMPT = `You are a viral short-form video script strategist. Given a transcript of an
already-viral video, rewrite it into a NEW original script for a different creator that keeps the
proven structural elements that made the source work, without copying its wording verbatim:

- Hook (first 1-3 seconds): a scroll-stopping opening line
- Point structure: 2-4 concise beats building toward a payoff, following an emotional arc
  (curiosity -> tension -> payoff, or similar)
- Trending phrases: current platform slang/phrasing patterns woven in naturally, not forced
- CTA: a short, platform-native call to action (follow/comment/share hook, not generic "like and subscribe")
- Platform-specific pacing notes for how delivery should differ across target platforms

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
    durationSec: number;
    platforms: Platform[];
    /** BCP-47-ish tag (e.g. "en", "es", "pt-BR") — defaults to English. The source
     *  transcript can be in any language; this only controls the OUTPUT script's
     *  language, so a non-English source can still be rewritten into English (or
     *  vice versa) rather than assumed to match. */
    locale?: string;
    dryRun?: boolean;
    costLedger?: CostLedger;
  }
): Promise<RewrittenScript> {
  const locale = opts.locale ?? "en";
  if (opts.dryRun) return mockRewrittenScript(transcript, { ...opts, locale });

  const userPrompt = `Niche: ${opts.niche}
Brand voice: ${opts.brandVoice}
Brand kit rules: ${opts.brandKit ? JSON.stringify(opts.brandKit) : "none configured"}
Target duration: ${opts.durationSec} seconds
Target platforms: ${opts.platforms.join(", ")}
Write the script in this language (BCP-47 tag): ${locale}. Trending phrases should be
native to that language/platform culture, not translated English slang.

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
    geminiModel: "gemini-2.5-pro",
    stage: "script_rewrite",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJson(text));
  return RewrittenScriptSchema.parse({
    videoId: transcript.videoId,
    hook: parsed.hook,
    points: parsed.points,
    cta: parsed.cta,
    durationSec: opts.durationSec,
    brandVoice: opts.brandVoice,
    locale,
    trendingPhrases: parsed.trendingPhrases ?? [],
    platformNotes: parsed.platformNotes
  });
}

function mockRewrittenScript(
  transcript: Transcript,
  opts: { niche: string; brandVoice: string; durationSec: number; locale: string }
): RewrittenScript {
  return RewrittenScriptSchema.parse({
    videoId: transcript.videoId,
    hook: `[mock] Wait, nobody told you this about ${opts.niche}?`,
    points: [
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
