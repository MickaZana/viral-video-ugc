import type { CostLedger } from "@vvugc/shared-cost";
import type { Platform, RewrittenScript, Transcript } from "@vvugc/shared-schema";
import { fetchRemixTranscript, parseSourceUrl } from "./remix-source.js";
import { rewriteScript } from "./agents/script-agent.js";

/**
 * The cheap, high-signal half of remix-from-URL: fetch the transcript of a pasted
 * viral video and adapt it to the caller's niche — WITHOUT spending any video-gen
 * money. This is the "turn a viral video into my ad" moment a user can feel, and
 * it's just one LLM text call. Only when they confirm does the caller run the full
 * pipeline (which reuses this transcript via RunConfig.sourceTranscript).
 */
export async function previewRemix(input: {
  sourceUrl: string;
  niche: string;
  brandVoice: string;
  durationSec: number;
  platforms: Platform[];
  locale?: string;
  costLedger?: CostLedger;
  outDir: string;
}): Promise<{ transcript: Transcript; script: RewrittenScript }> {
  const parsed = parseSourceUrl(input.sourceUrl);
  if (!parsed) {
    throw new Error("unsupported source URL — paste a TikTok, YouTube, or Instagram (Reels) link");
  }
  const { transcript } = await fetchRemixTranscript(input.sourceUrl, input.outDir, input.niche);
  const script = await rewriteScript(transcript, {
    niche: input.niche,
    brandVoice: input.brandVoice,
    durationSec: input.durationSec,
    platforms: input.platforms,
    locale: input.locale ?? "en",
    dryRun: false,
    costLedger: input.costLedger
  });
  return { transcript, script };
}
