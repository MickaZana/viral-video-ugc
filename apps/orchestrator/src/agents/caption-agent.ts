import Anthropic from "@anthropic-ai/sdk";
import { requireEnvVar } from "@vvugc/shared-config";
import type { CostLedger } from "@vvugc/shared-cost";
import { CaptionCueSchema, type CaptionCue, type RewrittenScript } from "@vvugc/shared-schema";
import { z } from "zod";

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
  opts: { dryRun?: boolean; costLedger?: CostLedger } = {}
): Promise<CaptionCue[]> {
  if (opts.dryRun) return mockCaptions(script);

  const apiKey = requireEnvVar("ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey });

  const userPrompt = `Total duration: ${script.durationSec} seconds

Hook: ${script.hook}
Points:
${script.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}
CTA: ${script.cta}`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }]
  });

  opts.costLedger?.recordAnthropicUsage("caption_timing", message.usage);

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude caption-timing response contained no text block");
  }

  const parsed = JSON.parse(extractJsonArray(textBlock.text));
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
