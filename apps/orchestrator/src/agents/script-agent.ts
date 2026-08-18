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
    durationSec: number;
    platforms: Platform[];
    /** BCP-47-ish tag (e.g. "en", "es", "pt-BR") — defaults to English. The source
     *  transcript can be in any language; this only controls the OUTPUT script's
     *  language, so a non-English source can still be rewritten into English (or
     *  vice versa) rather than assumed to match. */
    locale?: string;
    dryRun?: boolean;
    costLedger?: CostLedger;
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

  const userPrompt = `Niche: ${opts.niche}
Brand voice: ${opts.brandVoice}
Brand kit rules: ${opts.brandKit ? JSON.stringify(opts.brandKit) : "none configured"}
Target duration: ${opts.durationSec} seconds
Target platforms: ${opts.platforms.join(", ")}
Write the script in this language (BCP-47 tag): ${locale}. Trending phrases should be
native to that language/platform culture, not translated English slang.
${discoveryBriefBlock}
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
