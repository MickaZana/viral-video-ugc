import type { CostLedger } from "@vvugc/shared-cost";
import {
  AiBatchPlanInputSchema,
  type AiBatchPlanInput,
  type BatchPlannerContext,
  type BatchPlannerContextEntity,
  type BatchPlanDraft
} from "@vvugc/shared-schema";
import { generateWithFailover } from "./llm-failover.js";

// Re-exported for backward compat with existing callers of this module —
// the canonical definitions now live in shared-schema/src/batch.ts (see its
// own doc comment) so the browser-bundled control-panel app can import these
// types directly without pulling in this app's node-only dependencies
// (ffmpeg-static etc.), the same reason BatchRequest/BatchPlan live there.
export {
  AiBatchPlanInputSchema,
  type AiBatchPlanInput,
  type BatchPlannerContext,
  type BatchPlannerContextEntity,
  type BatchPlanDraft
};

/**
 * Batch Planner Agent: "describe a series, get a week of content" — the
 * natural-language front end to the EXISTING structured BatchRequest/BatchPlan
 * machinery in packages/shared-schema/src/batch.ts and batch-planner.ts. This
 * agent does not replace that machinery or run anything itself; it only fills
 * in a best-effort DRAFT of a BatchRequest for the user to review and edit in
 * the existing BatchStudio form before anything is planned or run.
 *
 * Safety design (why this is safe to point an LLM at, twice over):
 * 1. clientId/orgId/requestedBy are NEVER produced by the model — those come
 *    from the authenticated request context server-side, the same way every
 *    other route in this app derives them. The model only ever sees and fills
 *    AiBatchPlanInputSchema's fields.
 * 2. productProfileId/templateId/creatorProfileIds are constrained to IDs from
 *    a closed list handed to the model as context (this org's real products/
 *    templates/creators) — the model is instructed to pick from that list,
 *    never invent an id, and validateAgainstContext() below independently
 *    verifies every returned id actually exists in that same list before this
 *    draft is ever handed back to a caller. An invented id is dropped with a
 *    warning, not trusted.
 * 3. Nothing this agent returns ever runs on its own — the caller still goes
 *    through BatchStudio's existing review/edit form and the existing
 *    planBatch() -> BatchPlan -> enqueue flow, which independently re-validates
 *    referenced entities exist (see batch-planner.ts's EntityLookup). This
 *    agent's output is a draft, not an executable instruction.
 */

const SYSTEM_PROMPT = `You are a content batch-planning assistant. A user describes, in plain language, a
batch of short-form video content they want (e.g. "a week of fitness content for my protein
brand, TikTok and Reels, punchy energetic hooks"). Turn that description into a draft batch
request.

You will be given the org's REAL available products, templates, and creators as
{id, name} pairs. You MUST pick productProfileId (required) from the given products list, and
any templateId / creatorProfileIds from their given lists — NEVER invent an id that isn't in
the list you were given. If nothing in the description suggests a specific product/template/
creator and there is exactly one available, use it. If there are several and the description
doesn't disambiguate, pick the single best-fitting match and say so plainly in "rationale" —
the user reviews and can change it before anything runs.

platforms must be a subset of: tiktok, youtube_shorts, instagram_reels, facebook.
captionStyleIds (if you have a strong opinion) must be a subset of: clean, bold, minimal.
vendorPolicy is one of {"policy":"cheapest"}, {"policy":"quality"}, or
{"policy":"specific","specificVendor":"<vendor id>"} — default to cheapest unless the
description clearly asks for higher production value ("cinematic", "premium", "best quality").
hookCount/scriptCount/targetDurationSec/maxVariations/maxEstimatedCostUsd/locale: infer
reasonable values from the description (e.g. "a week of content" suggests more hooks/variations
than "one quick test"), staying within each field's stated bounds; when the description gives no
signal, use sensible defaults (hookCount 3, scriptCount 1, targetDurationSec 25, maxVariations
matched to what a "week" or "handful" plausibly implies, maxEstimatedCostUsd conservative).

Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly:
{"productProfileId": string, "templateId": string | undefined, "creatorProfileIds": string[],
 "hookCount": number, "scriptCount": number, "captionStyleIds": string[] | undefined,
 "ctaVariants": string[] | undefined, "platforms": string[], "vendorPolicy": {...},
 "targetDurationSec": number, "maxVariations": number, "maxEstimatedCostUsd": number,
 "locale": string, "rationale": string}`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object found in batch planner response: ${text}`);
  return text.slice(start, end + 1);
}

/** Independently re-verifies every id the model returned actually exists in
 *  the context it was given — see module doc point 2. Never trusts the
 *  model's own claim that an id is valid. */
function validateAgainstContext(plan: AiBatchPlanInput, context: BatchPlannerContext): BatchPlanDraft {
  const productIds = new Set(context.products.map((p) => p.id));
  const templateIds = new Set(context.templates.map((t) => t.id));
  const creatorIds = new Set(context.creators.map((c) => c.id));
  const dropped: string[] = [];

  if (!productIds.has(plan.productProfileId)) {
    dropped.push(plan.productProfileId);
    // No safe fallback for a required field with an invalid id — the caller's
    // review form will show this as unset and the user must pick one.
    plan.productProfileId = "";
  }
  if (plan.templateId && !templateIds.has(plan.templateId)) {
    dropped.push(plan.templateId);
    plan.templateId = undefined;
  }
  const validCreatorIds = plan.creatorProfileIds.filter((id) => creatorIds.has(id));
  dropped.push(...plan.creatorProfileIds.filter((id) => !creatorIds.has(id)));
  plan.creatorProfileIds = validCreatorIds;

  return { plan, droppedInvalidIds: dropped };
}

export async function planBatchFromDescription(
  description: string,
  context: BatchPlannerContext,
  opts: { dryRun?: boolean; costLedger?: CostLedger } = {}
): Promise<BatchPlanDraft> {
  if (opts.dryRun) return mockDraft(description, context);

  if (context.products.length === 0) {
    throw new Error("Cannot draft a batch plan: this org has no product profiles yet.");
  }

  const userPrompt = `User's description: "${description}"

Available products: ${JSON.stringify(context.products)}
Available templates: ${JSON.stringify(context.templates)}
Available creators: ${JSON.stringify(context.creators)}`;

  // Sonnet 5: this is a judgment/synthesis call with real downstream consequences
  // (a wrong product/creator pick shapes an entire batch's cost and content) but not
  // the creative bottleneck script-agent owns — same tier as qa-agent's gatekeeping
  // call. See CLAUDE.md's "Model selection" section.
  const model = "claude-sonnet-5";
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1024,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "batch_plan_draft",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJson(text));
  const plan = AiBatchPlanInputSchema.parse(parsed);
  return validateAgainstContext(plan, context);
}

/** Offline fallback for --dry-run — no API call, deterministic draft so dry
 *  runs stay reproducible (same convention as every other agent's dry-run path). */
function mockDraft(description: string, context: BatchPlannerContext): BatchPlanDraft {
  const plan = AiBatchPlanInputSchema.parse({
    productProfileId: context.products[0]?.id ?? "",
    creatorProfileIds: context.creators.slice(0, 1).map((c) => c.id),
    hookCount: 3,
    scriptCount: 1,
    platforms: ["tiktok"],
    vendorPolicy: { policy: "cheapest" },
    targetDurationSec: 25,
    maxVariations: 10,
    maxEstimatedCostUsd: 25,
    locale: "en",
    rationale: `[dry-run mock] Drafted from: "${description}"`
  });
  return { plan, droppedInvalidIds: [] };
}
