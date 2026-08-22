/**
 * Library entry point (separate from cli.ts, the executable entry) — lets other
 * apps in this workspace (specifically review-dashboard's regeneration endpoints)
 * call into the same regeneration logic the CLI would use, instead of duplicating
 * it. An app depending on another app isn't the usual shape in this monorepo
 * (apps normally only depend on packages/*), but regenerateScene/regenerateScript
 * genuinely need the orchestrator's own agents (caption-agent.ts, qa-agent.ts) —
 * extracting those into a new shared package just to avoid one app->app edge
 * wasn't worth it for what's currently two functions.
 */
export { regenerateScene, regenerateScript, type RegenerateOptions } from "./regenerate.js";
export { runCycle, type RunCycleOptions } from "./conductor.js";
export { runAcceptance, type AcceptanceEvidence } from "./acceptance.js";
export { previewRemix } from "./remix.js";
export { fetchRemixTranscript, parseSourceUrl, candidateFromSource } from "./remix-source.js";
export { BUILTIN_UGC_TEMPLATES, getUgcTemplate, templateCompatibility, validateTemplateScript } from "./templates.js";
