/**
 * Atom D (continued) — Vendor Fallback Chain
 *
 * Default chain: Higgsfield → Kling → Replicate → Gemini (still-image/Ken-Burns)
 * Per-account/client configuration can override the chain.
 * For each fallback: records reason, meters actual cost, preserves metadata.
 */

import type { RawClip } from "@vvugc/shared-schema";

export type VideoVendor = RawClip["vendor"];

/** Default fallback chain — cheapest first.
 *  Seedance ~$0.02–0.07/sec (via fal.ai)
 *  Grok Video ~$0.05–0.08/sec (xAI direct API)
 *  Kling ~$0.08/sec (direct REST)
 *  Higgsfield ~$1.19/clip (MCP-only, aggregator)
 *  Replicate ~$0.12/sec (model-hosting platform)
 *  Gemini ~$0.04/image (still-image + Ken Burns fallback)
 */
export const DEFAULT_FALLBACK_CHAIN: VideoVendor[] = [
  "seedance",
  "grok_video",
  "kling",
  "higgsfield",
  "replicate",
  "gemini",
];

export interface FallbackChainConfig {
  /** Override the default chain per account/client. */
  vendorChain?: VideoVendor[];
  /** Skip specific vendors entirely (e.g., if no credentials configured). */
  disabledVendors?: VideoVendor[];
}

export interface FallbackResult {
  vendor: VideoVendor;
  fallbackIndex: number;
  reason?: string;
  isOriginalVendor: boolean;
}

/**
 * Resolve the effective fallback chain for a job.
 */
export function resolveChain(
  requestedVendor: VideoVendor,
  config?: FallbackChainConfig
): VideoVendor[] {
  const baseChain = config?.vendorChain ?? DEFAULT_FALLBACK_CHAIN;
  const disabled = new Set(config?.disabledVendors ?? []);

  // Start from the requested vendor in the chain
  const startIndex = baseChain.indexOf(requestedVendor);
  const chain: VideoVendor[] = [];

  if (startIndex >= 0) {
    // Include the requested vendor first, then everything after it
    for (let i = startIndex; i < baseChain.length; i++) {
      if (!disabled.has(baseChain[i])) {
        chain.push(baseChain[i]);
      }
    }
  } else {
    // Requested vendor not in chain — use it alone, then fallbacks
    if (!disabled.has(requestedVendor)) {
      chain.push(requestedVendor);
    }
    for (const v of baseChain) {
      if (!disabled.has(v) && v !== requestedVendor) {
        chain.push(v);
      }
    }
  }

  return chain;
}

/**
 * Get the next vendor to try after a failure.
 *
 * Rules:
 * - If the request itself is invalid (bad prompt, unsupported params),
 *   do NOT fallback — the error will reproduce on every vendor.
 * - If it's an auth/credential failure, skip to next vendor.
 * - If it's a provider failure (timeout, 5xx, MCP unavailable), try next.
 */
export function getNextFallback(
  currentVendor: VideoVendor,
  chain: VideoVendor[],
  currentIndex: number
): FallbackResult | undefined {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= chain.length) return undefined;

  return {
    vendor: chain[nextIndex],
    fallbackIndex: nextIndex,
    isOriginalVendor: false,
  };
}

/**
 * Determine which vendors from the fallback chain are actually available
 * based on configured credentials and MCP session state.
 */
export function getAvailableVendors(
  chain: VideoVendor[],
  vendorAvailability: Record<VideoVendor, boolean>
): VideoVendor[] {
  return chain.filter((v) => vendorAvailability[v] !== false);
}

/**
 * Build the fallbackVendors array to store on a provider job.
 * This is the chain AFTER the requested vendor.
 */
export function buildFallbackList(
  requestedVendor: VideoVendor,
  config?: FallbackChainConfig
): VideoVendor[] {
  const chain = resolveChain(requestedVendor, config);
  // Remove the first entry (the requested vendor itself)
  return chain.slice(1);
}
