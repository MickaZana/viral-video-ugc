import Anthropic from "@anthropic-ai/sdk";
import { requireEnvVar } from "@vvugc/shared-config";
import type { CostLedger } from "@vvugc/shared-cost";
import { RewrittenScriptSchema, type Platform, type RewrittenScript, type Transcript } from "@vvugc/shared-schema";

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
    durationSec: number;
    platforms: Platform[];
    dryRun?: boolean;
    costLedger?: CostLedger;
  }
): Promise<RewrittenScript> {
  if (opts.dryRun) return mockRewrittenScript(transcript, opts);

  const apiKey = requireEnvVar("ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey });

  const userPrompt = `Niche: ${opts.niche}
Brand voice: ${opts.brandVoice}
Target duration: ${opts.durationSec} seconds
Target platforms: ${opts.platforms.join(", ")}

Source transcript:
"""
${transcript.text}
"""`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }]
  });

  opts.costLedger?.recordAnthropicUsage("script_rewrite", message.usage);

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude script-rewrite response contained no text block");
  }

  const parsed = JSON.parse(extractJson(textBlock.text));
  return RewrittenScriptSchema.parse({
    videoId: transcript.videoId,
    hook: parsed.hook,
    points: parsed.points,
    cta: parsed.cta,
    durationSec: opts.durationSec,
    brandVoice: opts.brandVoice,
    trendingPhrases: parsed.trendingPhrases ?? [],
    platformNotes: parsed.platformNotes
  });
}

function mockRewrittenScript(
  transcript: Transcript,
  opts: { niche: string; brandVoice: string; durationSec: number }
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
    trendingPhrases: ["no cap", "wait for it"]
  });
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
