import type { CostLedger } from "@vvugc/shared-cost";
import { CaptionCueSchema, type CaptionCue, type RewrittenScript, type UGCTemplate } from "@vvugc/shared-schema";
import { z } from "zod";
import { generateWithFailover } from "./llm-failover.js";

const SYSTEM_PROMPT = `You are a caption-timing editor for short-form vertical video (TikTok/Reels/Shorts).
Given a script (hook, points, cta) and a fixed total duration, split it into on-screen caption
cards with natural pacing:
- Allocate time proportional to each line's reading length, not evenly.
- Keep each card short (aim for under ~8 words) — split a long point into two cards if needed.
- The hook should land almost immediately (within the first second).
- Cues must be contiguous and cover the full duration exactly, with no gaps or overlaps.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{"text": string, "startSec": number, "endSec": number}, ...]`;

export async function generateCaptions(
  script: RewrittenScript,
  opts: { dryRun?: boolean; costLedger?: CostLedger; template?: UGCTemplate } = {}
): Promise<CaptionCue[]> {
  if (opts.dryRun) return mockCaptions(script);

  const userPrompt = `Total duration: ${script.durationSec} seconds

Hook: ${script.hook}
Points:
${script.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}
CTA: ${script.cta}`;
  const templateBlock = opts.template ? `\nTemplate caption style: ${opts.template.captionStyle}. Keep cards aligned to beats: ${opts.template.scriptStructure.join(" → ")}` : "";

  // Haiku 4.5: this stage only splits an already-written script into timed cards by reading
  // length — mechanical, bounded, high-volume (once per candidate every run), not a creative
  // judgment call, so it doesn't need the premium models. See CLAUDE.md's "Model selection".
  const model = "claude-haiku-4-5";
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt: userPrompt + templateBlock,
    maxTokens: 1024,
    anthropicModel: model,
    geminiModel: "gemini-2.5-flash",
    grokModel: process.env.GROK_MODEL || "grok-2",
    stage: "caption_timing",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJsonArray(text));
  return z.array(CaptionCueSchema).parse(parsed);
}

/** Even-split fallback for --dry-run — no API call, just enough structure to exercise assembly. */
function mockCaptions(script: RewrittenScript): CaptionCue[] {
  const lines = [script.hook, ...script.points, script.cta];
  const perLineSec = script.durationSec / lines.length;
  return lines.map((text, i) => ({
    startSec: i * perLineSec,
    endSec: (i + 1) * perLineSec,
    text
  }));
}

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`No JSON array found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
