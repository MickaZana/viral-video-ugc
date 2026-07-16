import { join } from "node:path";
import type { RawClip, ReviewItem } from "@vvugc/shared-schema";
import { getVideoGenAdapter, type McpToolCaller } from "@vvugc/mcp-video-gen";
import { assembleVideo, ASPECT_RATIO_BY_PLATFORM } from "@vvugc/mcp-assembly";
import { scoreOriginality } from "@vvugc/shared-originality";
import { scoreVideo } from "./agents/qa-agent.js";
import { generateCaptions } from "./agents/caption-agent.js";

export interface RegenerateOptions {
  videoVendor: RawClip["vendor"];
  dryRun?: boolean;
  /** Work directory for the new clip(s)/assembly output — same shape as conductor.ts's runDir. */
  outDir: string;
  callMcpTool?: McpToolCaller;
}

function scriptSegments(script: ReviewItem["script"]): string[] {
  return [script.hook, ...script.points, script.cta];
}

/**
 * Re-renders a single script segment (hook, one point, or the CTA) and re-assembles
 * the video with that one clip swapped in — everything else (other clips, captions,
 * narration) stays exactly as it was. Requires `item.clips`/`item.captions` to have
 * been captured at generation time (see conductor.ts) — older review items created
 * before that existed have nothing to regenerate from and this throws a clear error
 * rather than guessing.
 */
export async function regenerateScene(item: ReviewItem, sceneIndex: number, opts: RegenerateOptions): Promise<ReviewItem> {
  if (!item.clips || !item.captions) {
    throw new Error(
      `Review item "${item.id}" has no stored clips/captions to regenerate a scene from ` +
        "(it was created before scene regeneration was added) — not possible to regenerate in place."
    );
  }

  const segments = scriptSegments(item.script);
  if (sceneIndex < 0 || sceneIndex >= segments.length) {
    throw new Error(`sceneIndex ${sceneIndex} is out of range — this script has ${segments.length} segments (0-${segments.length - 1}).`);
  }

  const adapter = getVideoGenAdapter(opts.videoVendor, {
    outDir: opts.outDir,
    dryRun: opts.dryRun ?? false,
    callMcpTool: opts.callMcpTool
  });

  const newClip = await adapter.generate({
    scriptSegmentIndex: sceneIndex,
    prompt: segments[sceneIndex],
    durationSec: Math.round(item.script.durationSec / segments.length),
    aspectRatio: ASPECT_RATIO_BY_PLATFORM[item.platform]
  });

  // Replace by segment index, not array position — clips aren't guaranteed to already
  // be sorted (assembleVideo itself re-sorts by scriptSegmentIndex before use).
  const updatedClips = item.clips.map((clip) => (clip.scriptSegmentIndex === sceneIndex ? newClip : clip));

  return finishRegeneration(item, item.script, updatedClips, item.captions, opts);
}

/**
 * Re-renders every clip against an edited script (hook/points/cta text changed by a
 * reviewer) and re-assembles. Unlike regenerateScene, this re-runs caption timing too
 * (the text changed, so the old timing no longer applies) — narration, if the item had
 * any, is deliberately left untouched: re-synthesizing it against new caption timing is
 * a real (paid) TTS call this function doesn't make on the caller's behalf implicitly;
 * callers that want re-narrated audio should regenerate voiceover separately.
 */
export async function regenerateScript(
  item: ReviewItem,
  newScript: { hook: string; points: string[]; cta: string },
  opts: RegenerateOptions
): Promise<ReviewItem> {
  const updatedScript = { ...item.script, ...newScript };
  const segments = scriptSegments(updatedScript);

  const captions = await generateCaptions(updatedScript, { dryRun: opts.dryRun });

  const adapter = getVideoGenAdapter(opts.videoVendor, {
    outDir: opts.outDir,
    dryRun: opts.dryRun ?? false,
    callMcpTool: opts.callMcpTool
  });

  const clips: RawClip[] = [];
  for (let i = 0; i < segments.length; i++) {
    clips.push(
      await adapter.generate({
        scriptSegmentIndex: i,
        prompt: segments[i],
        durationSec: Math.round(updatedScript.durationSec / segments.length),
        aspectRatio: ASPECT_RATIO_BY_PLATFORM[item.platform]
      })
    );
  }

  return finishRegeneration(item, updatedScript, clips, captions, opts);
}

async function finishRegeneration(
  item: ReviewItem,
  script: ReviewItem["script"],
  clips: RawClip[],
  captions: NonNullable<ReviewItem["captions"]>,
  opts: RegenerateOptions
): Promise<ReviewItem> {
  const assembled = await assembleVideo({
    clips,
    script,
    captions,
    platform: item.platform,
    outDir: join(opts.outDir, "assembled"),
    dryRun: opts.dryRun,
    voiceoverPath: item.voiceoverPath
  });

  const qa = await scoreVideo(assembled, script, { dryRun: opts.dryRun });
  const scriptText = scriptSegments(script).join(" ");
  const originality = item.sourceTranscriptText ? scoreOriginality(item.sourceTranscriptText, scriptText) : undefined;

  return {
    ...item,
    script,
    videoPath: assembled.filePath,
    clips,
    captions,
    score: qa.score,
    flags: originality ? [...qa.flags, ...originality.flags] : qa.flags,
    originalityScore: originality?.originalityScore ?? item.originalityScore,
    // A regenerated render needs a fresh look — an approve/reject decision made against
    // the previous render shouldn't silently carry over to a different video.
    status: "pending"
  };
}
