/**
 * Smart Vendor Routing — Atom A: Segment Classification
 *
 * Defines segment types that influence routing decisions.
 * Each segment of a script has a content type that maps to
 * specific vendor strengths.
 */
import { z } from "zod";

export const SegmentTypeSchema = z.enum([
  "talking_head",    // Needs face consistency → prefer vendors with reference image support
  "b_roll",          // Generic visual → cheapest vendor
  "product_closeup", // Needs detail/quality → high-res vendors
  "action",          // Needs motion dynamics → vendors with dynamic camera support
  "text_overlay",    // Mostly static with text → still-image + Ken Burns
  "lifestyle",       // Ambient/mood → general purpose
]);
export type SegmentType = z.infer<typeof SegmentTypeSchema>;

export const RoutingDecisionSchema = z.object({
  /** The vendor selected by smart routing as primary. */
  routedVendor: z.string(),
  /** Human-readable explanation of why this vendor was chosen. */
  routingReason: z.string(),
  /** The segment type that influenced the decision. */
  segmentType: SegmentTypeSchema.optional(),
  /** The full ordered chain (primary + fallbacks) after routing. */
  resolvedChain: z.array(z.string()),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
