/**
 * Governance gate for real LLM / vendor / external calls.
 *
 * This project has exactly ONE behavioral mock: the `dryRun` subsystem. When
 * `dryRun` is true, every pipeline stage (discovery candidates, transcript,
 * script, captions, QA, video, voiceover, assembly) emits deterministic output
 * and contacts NO third-party API. `dryRun` defaults to TRUE on every request
 * path, so the system is safe-by-default.
 *
 * Real execution is a two-key lock: a per-request intent (`live: true` or
 * `dryRun: false`) is necessary but NOT sufficient — the operator must ALSO set
 * `VVUGC_LLM_LIVE=true` in the environment. This makes accidental API spend
 * impossible even if a client sends `live: true`.
 */

/** True only when the operator has explicitly enabled real LLM/vendor spend. */
export function isLLMLive(): boolean {
  return process.env.VVUGC_LLM_LIVE === "true";
}

/** Per-request intent to run for real (independent of the env kill-switch). */
export function wantsLive(req: { body?: Record<string, unknown> }): boolean {
  return req.body?.live === true || req.body?.dryRun === false;
}

/** The authoritative "is this a real (paid) run?" decision. */
export function isRealRun(req: { body?: Record<string, unknown> }): boolean {
  return wantsLive(req) && isLLMLive();
}

/**
 * External discovery (platform scraping) is gated separately so the system
 * stays fully offline unless the operator enables it. When false, discovery
 * returns an empty candidate list and the editor falls back to a seeded brief.
 */
export function isDiscoveryLive(): boolean {
  return process.env.VVUGC_DISCOVERY_LIVE === "true";
}
