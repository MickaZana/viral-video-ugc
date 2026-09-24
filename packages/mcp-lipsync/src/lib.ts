/**
 * mcp-lipsync — LipSync Studio Package Entry Point
 *
 * Provides adapter creation and the top-level generate function for
 * producing talking-head videos from character image + voiceover audio.
 */

export type { LipSyncAdapter, LipSyncInput, LipSyncResult, LipSyncVendor } from "./adapters/LipSyncAdapter.js";
export { createMockLipSyncAdapter } from "./adapters/mock.js";
export { createSyncLabsAdapter } from "./adapters/sync-labs.js";
export { createHeyGenAdapter } from "./adapters/heygen.js";

import type { LipSyncAdapter, LipSyncVendor } from "./adapters/LipSyncAdapter.js";
import { createMockLipSyncAdapter } from "./adapters/mock.js";
import { createSyncLabsAdapter } from "./adapters/sync-labs.js";
import { createHeyGenAdapter } from "./adapters/heygen.js";

/**
 * Factory function for lipsync adapters.
 *
 * Returns undefined if vendor is "none" or undefined — caller should
 * fall back to B-roll + voiceover flow.
 *
 * In dry-run mode, always returns the mock adapter regardless of vendor,
 * matching the same pattern as mcp-video-gen and mcp-voiceover.
 */
export function getLipSyncAdapter(
  vendor: LipSyncVendor | "none" | undefined,
  opts: { dryRun: boolean }
): LipSyncAdapter | undefined {
  if (!vendor || vendor === "none") return undefined;
  if (opts.dryRun) return createMockLipSyncAdapter();

  switch (vendor) {
    case "sync_labs":
      return createSyncLabsAdapter();
    case "heygen":
      return createHeyGenAdapter();
    case "mock":
      return createMockLipSyncAdapter();
  }
}

/**
 * Check if lipsync credentials are available for a given vendor.
 * Used by smart routing to determine if lipsync can be used.
 */
export function isLipSyncAvailable(vendor: LipSyncVendor | "none" | undefined): boolean {
  if (!vendor || vendor === "none" || vendor === "mock") return false;
  switch (vendor) {
    case "sync_labs":
      return !!process.env.SYNC_LABS_API_KEY;
    case "heygen":
      return !!process.env.HEYGEN_API_KEY;
  }
}
