/**
 * Smart Vendor Routing — Atom B: Routing Engine
 *
 * Intelligently selects the optimal vendor chain per segment based on:
 * - Segment content type (talking_head, b_roll, product_closeup, etc.)
 * - Creator's preferredVideoVendor and compatibleVendors
 * - Vendor policy (cheapest / quality / specific)
 * - Available credentials
 * - Visual direction preferences
 *
 * Returns an ordered vendor chain (primary + fallbacks) with a human-readable
 * reason for the routing decision. Does NOT replace the fallback chain — smart
 * routing selects the PRIMARY vendor; fallback still catches failures.
 */

import type { SegmentType } from "@vvugc/shared-schema";
import type { VideoVendor } from "./fallback-chain.js";
import { DEFAULT_FALLBACK_CHAIN } from "./fallback-chain.js";

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

export interface SmartRoutingInput {
  /** Content type of this segment (if classified). */
  segmentType?: SegmentType;
  /** Creator's preferred vendor (strongest signal). */
  creatorPreferredVendor?: VideoVendor;
  /** Creator's compatible vendors (hard constraint — only route to these if set). */
  creatorCompatibleVendors?: VideoVendor[];
  /** Batch/run vendor policy override. */
  vendorPolicy?: { policy: "cheapest" | "quality" | "specific"; specificVendor?: VideoVendor };
  /** Which vendor credentials are actually configured. */
  availableVendors: VideoVendor[];
  /** Whether the segment has a face identity reference (Soul ID). */
  hasIdentityRef?: boolean;
}

export interface SmartRoutingResult {
  /** Ordered vendor chain — primary first, then fallbacks. */
  chain: VideoVendor[];
  /** The primary vendor (chain[0]). */
  primaryVendor: VideoVendor;
  /** Human-readable reason for the routing decision. */
  routingReason: string;
}

// ---------------------------------------------------------------------------
// Vendor Suitability Tables
// ---------------------------------------------------------------------------

/** Per-segment-type vendor rankings: ordered best → worst for that content type. */
const SEGMENT_VENDOR_RANKINGS: Record<SegmentType, { quality: VideoVendor[]; cheapest: VideoVendor[] }> = {
  talking_head: {
    quality: ["kling", "seedance", "higgsfield", "replicate", "grok_video", "gemini"],
    cheapest: ["seedance", "kling", "grok_video", "replicate", "higgsfield", "gemini"],
  },
  b_roll: {
    quality: ["kling", "seedance", "grok_video", "replicate", "higgsfield", "gemini"],
    cheapest: ["seedance", "grok_video", "gemini", "kling", "replicate", "higgsfield"],
  },
  product_closeup: {
    quality: ["kling", "seedance", "replicate", "higgsfield", "grok_video", "gemini"],
    cheapest: ["seedance", "kling", "grok_video", "replicate", "higgsfield", "gemini"],
  },
  action: {
    quality: ["kling", "seedance", "grok_video", "replicate", "higgsfield", "gemini"],
    cheapest: ["seedance", "grok_video", "kling", "replicate", "higgsfield", "gemini"],
  },
  text_overlay: {
    quality: ["gemini", "seedance", "grok_video", "kling", "replicate", "higgsfield"],
    cheapest: ["gemini", "seedance", "grok_video", "kling", "replicate", "higgsfield"],
  },
  lifestyle: {
    quality: ["grok_video", "seedance", "kling", "replicate", "higgsfield", "gemini"],
    cheapest: ["seedance", "grok_video", "gemini", "kling", "replicate", "higgsfield"],
  },
};

/** Vendors that support face/identity references (Soul ID). */
const IDENTITY_CAPABLE_VENDORS: Set<VideoVendor> = new Set([
  "kling", "seedance", "higgsfield", "replicate",
]);

// ---------------------------------------------------------------------------
// Smart Router
// ---------------------------------------------------------------------------

/**
 * Computes the optimal vendor chain for a single segment.
 *
 * Priority order of constraints:
 * 1. vendorPolicy "specific" → forced primary
 * 2. Creator compatibleVendors → hard filter (only these allowed)
 * 3. Creator preferredVideoVendor → becomes primary if compatible
 * 4. Segment type ranking (quality or cheapest based on policy)
 * 5. Identity requirement → filter to identity-capable vendors
 * 6. Available credentials → filter out unconfigured vendors
 *
 * Fallback chain is always appended after the primary so failures still recover.
 */
export function smartRoute(input: SmartRoutingInput): SmartRoutingResult {
  const reasons: string[] = [];
  const policy = input.vendorPolicy?.policy ?? "cheapest";

  // -------------------------------------------------------------------------
  // Case 1: "specific" policy — forced vendor, standard fallback behind it
  // -------------------------------------------------------------------------
  if (policy === "specific" && input.vendorPolicy?.specificVendor) {
    const specific = input.vendorPolicy.specificVendor;
    const chain = buildChainWithFallbacks(specific, input.availableVendors);
    return {
      chain,
      primaryVendor: chain[0],
      routingReason: `vendorPolicy=specific → ${specific}`,
    };
  }

  // -------------------------------------------------------------------------
  // Case 2+: Determine candidate pool
  // -------------------------------------------------------------------------

  // Start with all available (credentialed) vendors
  let candidates = [...input.availableVendors];

  // Hard constraint: creator's compatibleVendors (if set, ONLY use these)
  if (input.creatorCompatibleVendors && input.creatorCompatibleVendors.length > 0) {
    candidates = candidates.filter((v) => input.creatorCompatibleVendors!.includes(v));
    reasons.push(`creator compatible: [${input.creatorCompatibleVendors.join(", ")}]`);
  }

  // Soft constraint: if segment needs identity ref, prefer identity-capable vendors
  if (input.hasIdentityRef) {
    const identityCandidates = candidates.filter((v) => IDENTITY_CAPABLE_VENDORS.has(v));
    if (identityCandidates.length > 0) {
      candidates = identityCandidates;
      reasons.push("identity-capable only");
    }
  }

  // If no candidates survive the filters, fall back to whatever is available
  if (candidates.length === 0) {
    candidates = [...input.availableVendors];
    reasons.push("all filters exhausted, using full available set");
  }

  // The allowable pool for fallbacks respects creatorCompatibleVendors constraint
  const fallbackPool =
    input.creatorCompatibleVendors && input.creatorCompatibleVendors.length > 0
      ? input.availableVendors.filter((v) => input.creatorCompatibleVendors!.includes(v))
      : input.availableVendors;

  // -------------------------------------------------------------------------
  // Case 3: Creator preferred vendor → use as primary if it survived filtering
  // -------------------------------------------------------------------------
  if (input.creatorPreferredVendor && candidates.includes(input.creatorPreferredVendor)) {
    const primary = input.creatorPreferredVendor;
    const rest = candidates.filter((v) => v !== primary);
    const chain = dedupe([primary, ...rest, ...getFallbackTail(fallbackPool, candidates)]);
    reasons.push(`creator prefers ${primary}`);
    return {
      chain,
      primaryVendor: primary,
      routingReason: reasons.join(" + "),
    };
  }

  // -------------------------------------------------------------------------
  // Case 4: Rank by segment type + policy
  // -------------------------------------------------------------------------
  let ranked: VideoVendor[];

  if (input.segmentType && SEGMENT_VENDOR_RANKINGS[input.segmentType]) {
    const rankings = SEGMENT_VENDOR_RANKINGS[input.segmentType];
    ranked = policy === "quality" ? rankings.quality : rankings.cheapest;
    reasons.push(`${input.segmentType} segment, policy=${policy}`);
  } else {
    // No segment type → use default cheapest-first chain
    ranked = DEFAULT_FALLBACK_CHAIN as VideoVendor[];
    reasons.push(`no segment type, default chain, policy=${policy}`);
  }

  // Filter ranked list to only available + compatible candidates
  const orderedCandidates = ranked.filter((v) => candidates.includes(v));

  // Append any candidates not in the ranking table (shouldn't happen, but safe)
  for (const v of candidates) {
    if (!orderedCandidates.includes(v)) orderedCandidates.push(v);
  }

  const primary = orderedCandidates[0] ?? candidates[0] ?? input.availableVendors[0];
  const chain = dedupe([...orderedCandidates, ...getFallbackTail(fallbackPool, orderedCandidates)]);

  return {
    chain,
    primaryVendor: primary,
    routingReason: reasons.join(" + ") + ` → ${primary}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chain: specific primary + remaining available vendors as fallbacks. */
function buildChainWithFallbacks(primary: VideoVendor, available: VideoVendor[]): VideoVendor[] {
  const rest = available.filter((v) => v !== primary);
  return dedupe([primary, ...rest]);
}

/** Get vendors from `available` that aren't already in `used` — as a fallback tail. */
function getFallbackTail(available: VideoVendor[], used: VideoVendor[]): VideoVendor[] {
  return available.filter((v) => !used.includes(v));
}

/** Deduplicate while preserving order. */
function dedupe(arr: VideoVendor[]): VideoVendor[] {
  return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// Credential Availability Detection
// ---------------------------------------------------------------------------

/** Env var keys that indicate a vendor's credentials are configured. */
const VENDOR_CREDENTIAL_KEYS: Record<VideoVendor, string[]> = {
  seedance: ["FAL_KEY"],
  grok_video: ["XAI_API_KEY"],
  kling: ["KLING_ACCESS_KEY"],
  higgsfield: ["MCP_SERVER_URL"],
  replicate: ["REPLICATE_API_TOKEN"],
  gemini: ["GEMINI_API_KEY"],
  runway: ["RUNWAY_API_KEY"],
  pika: ["FAL_KEY"], // Pika is served through fal.ai
  wan: ["REPLICATE_API_TOKEN"], // Wan 3.0 is served through Replicate, same as the replicate vendor
  nvidia: ["NVIDIA_API_KEY"],
};

/**
 * Detect which vendors have configured credentials from the environment.
 * Call once at startup and cache the result.
 */
export function detectAvailableVendors(env: Record<string, string | undefined>): VideoVendor[] {
  const available: VideoVendor[] = [];
  for (const [vendor, keys] of Object.entries(VENDOR_CREDENTIAL_KEYS)) {
    if (keys.some((k) => env[k] && env[k]!.trim().length > 0)) {
      available.push(vendor as VideoVendor);
    }
  }
  return available;
}
