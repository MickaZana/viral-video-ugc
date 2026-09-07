/**
 * Smart Vendor Routing — Atom D: Tests
 */
import { describe, expect, it } from "vitest";
import { smartRoute, detectAvailableVendors, type SmartRoutingInput } from "./smart-router.js";
import type { VideoVendor } from "./fallback-chain.js";

const ALL_VENDORS: VideoVendor[] = [
  "seedance", "grok_video", "kling", "higgsfield", "replicate", "gemini",
];

function baseInput(overrides: Partial<SmartRoutingInput> = {}): SmartRoutingInput {
  return {
    availableVendors: ALL_VENDORS,
    ...overrides,
  };
}

describe("smartRoute", () => {
  // -------------------------------------------------------------------------
  // Segment type routing
  // -------------------------------------------------------------------------

  it("talking_head segment + creator with Kling preference → routes to Kling", () => {
    const result = smartRoute(baseInput({
      segmentType: "talking_head",
      creatorPreferredVendor: "kling",
    }));
    expect(result.primaryVendor).toBe("kling");
    expect(result.chain[0]).toBe("kling");
    expect(result.routingReason).toContain("creator prefers kling");
  });

  it("b_roll segment + cheapest policy → routes to Seedance", () => {
    const result = smartRoute(baseInput({
      segmentType: "b_roll",
      vendorPolicy: { policy: "cheapest" },
    }));
    expect(result.primaryVendor).toBe("seedance");
    expect(result.routingReason).toContain("b_roll");
    expect(result.routingReason).toContain("cheapest");
  });

  it("product_closeup + quality policy → routes to Kling", () => {
    const result = smartRoute(baseInput({
      segmentType: "product_closeup",
      vendorPolicy: { policy: "quality" },
    }));
    expect(result.primaryVendor).toBe("kling");
    expect(result.routingReason).toContain("product_closeup");
    expect(result.routingReason).toContain("quality");
  });

  it("text_overlay segment → prefers Gemini (still-image + Ken Burns)", () => {
    const result = smartRoute(baseInput({
      segmentType: "text_overlay",
    }));
    expect(result.primaryVendor).toBe("gemini");
  });

  it("lifestyle segment → prefers cheapest (Seedance by default)", () => {
    const result = smartRoute(baseInput({
      segmentType: "lifestyle",
      vendorPolicy: { policy: "cheapest" },
    }));
    expect(result.primaryVendor).toBe("seedance");
  });

  it("action segment + quality → routes to Kling", () => {
    const result = smartRoute(baseInput({
      segmentType: "action",
      vendorPolicy: { policy: "quality" },
    }));
    expect(result.primaryVendor).toBe("kling");
  });

  // -------------------------------------------------------------------------
  // Credential filtering
  // -------------------------------------------------------------------------

  it("missing credentials for primary → skips to next compatible vendor", () => {
    const result = smartRoute(baseInput({
      segmentType: "talking_head",
      vendorPolicy: { policy: "quality" },
      // Only grok_video and replicate available (no kling/seedance)
      availableVendors: ["grok_video", "replicate", "gemini"],
    }));
    // Kling would be #1 for talking_head quality, but it's not available
    expect(result.primaryVendor).not.toBe("kling");
    expect(result.primaryVendor).not.toBe("seedance");
    expect(["grok_video", "replicate", "gemini"]).toContain(result.primaryVendor);
  });

  // -------------------------------------------------------------------------
  // Creator constraints
  // -------------------------------------------------------------------------

  it("creator with compatibleVendors: ['kling', 'seedance'] → never routes to Grok/Replicate", () => {
    const result = smartRoute(baseInput({
      segmentType: "b_roll",
      creatorCompatibleVendors: ["kling", "seedance"],
    }));
    expect(result.chain.filter((v) => v === "grok_video" || v === "replicate")).toHaveLength(0);
    // Primary must be one of the compatible vendors
    expect(["kling", "seedance"]).toContain(result.primaryVendor);
  });

  it("creator preferred vendor is respected even if not cheapest", () => {
    const result = smartRoute(baseInput({
      segmentType: "b_roll",
      vendorPolicy: { policy: "cheapest" },
      creatorPreferredVendor: "kling", // Not the cheapest
    }));
    expect(result.primaryVendor).toBe("kling");
    expect(result.routingReason).toContain("creator prefers kling");
  });

  // -------------------------------------------------------------------------
  // Vendor policy overrides
  // -------------------------------------------------------------------------

  it("vendorPolicy 'specific' overrides all other logic", () => {
    const result = smartRoute(baseInput({
      segmentType: "talking_head",
      creatorPreferredVendor: "kling",
      vendorPolicy: { policy: "specific", specificVendor: "replicate" },
    }));
    expect(result.primaryVendor).toBe("replicate");
    expect(result.chain[0]).toBe("replicate");
    expect(result.routingReason).toContain("vendorPolicy=specific");
  });

  // -------------------------------------------------------------------------
  // Identity reference filtering
  // -------------------------------------------------------------------------

  it("segment with identity ref → prefers identity-capable vendors", () => {
    const result = smartRoute(baseInput({
      segmentType: "b_roll",
      hasIdentityRef: true,
      vendorPolicy: { policy: "cheapest" },
    }));
    // Should not pick gemini or grok_video (not identity-capable)
    const identityCapable = ["kling", "seedance", "higgsfield", "replicate"];
    expect(identityCapable).toContain(result.primaryVendor);
  });

  // -------------------------------------------------------------------------
  // Routing reason is always a non-empty string
  // -------------------------------------------------------------------------

  it("routing reason is recorded as a human-readable string", () => {
    const result = smartRoute(baseInput({
      segmentType: "talking_head",
      vendorPolicy: { policy: "quality" },
    }));
    expect(result.routingReason).toBeTruthy();
    expect(typeof result.routingReason).toBe("string");
    expect(result.routingReason.length).toBeGreaterThan(5);
  });

  // -------------------------------------------------------------------------
  // Fallback chain remains intact
  // -------------------------------------------------------------------------

  it("fallback chain includes multiple vendors after the primary", () => {
    const result = smartRoute(baseInput({
      segmentType: "b_roll",
      vendorPolicy: { policy: "cheapest" },
    }));
    expect(result.chain.length).toBeGreaterThan(1);
    // All vendors in chain should be available
    for (const v of result.chain) {
      expect(ALL_VENDORS).toContain(v);
    }
  });

  it("no duplicate vendors in chain", () => {
    const result = smartRoute(baseInput({
      segmentType: "action",
      creatorPreferredVendor: "seedance",
      creatorCompatibleVendors: ["seedance", "kling", "grok_video"],
    }));
    const unique = new Set(result.chain);
    expect(unique.size).toBe(result.chain.length);
  });

  // -------------------------------------------------------------------------
  // Default behavior (no segment type, no special config)
  // -------------------------------------------------------------------------

  it("no segment type + no config → uses default cheapest-first behavior", () => {
    const result = smartRoute(baseInput({}));
    // Should return a chain starting from the cheapest default
    expect(result.primaryVendor).toBe("seedance");
    expect(result.routingReason).toContain("default chain");
  });
});

// ---------------------------------------------------------------------------
// detectAvailableVendors
// ---------------------------------------------------------------------------

describe("detectAvailableVendors", () => {
  it("detects vendors with configured credentials", () => {
    const env = {
      FAL_KEY: "fal-xxxx",
      XAI_API_KEY: "xai-xxxx",
      KLING_ACCESS_KEY: "kling-xxxx",
    };
    const available = detectAvailableVendors(env);
    expect(available).toContain("seedance");
    expect(available).toContain("pika"); // shares FAL_KEY
    expect(available).toContain("grok_video");
    expect(available).toContain("kling");
    expect(available).not.toContain("higgsfield");
    expect(available).not.toContain("replicate");
    expect(available).not.toContain("gemini");
  });

  it("returns empty array when no credentials configured", () => {
    const available = detectAvailableVendors({});
    expect(available).toHaveLength(0);
  });

  it("ignores empty/whitespace-only values", () => {
    const env = { FAL_KEY: "  ", XAI_API_KEY: "" };
    const available = detectAvailableVendors(env);
    expect(available).not.toContain("seedance");
    expect(available).not.toContain("grok_video");
  });

  it("detects nvidia when NVIDIA_API_KEY is configured", () => {
    const available = detectAvailableVendors({ NVIDIA_API_KEY: "nvapi-xxxx" });
    expect(available).toContain("nvidia");
  });

  it("does not detect nvidia for a whitespace-only NVIDIA_API_KEY", () => {
    const available = detectAvailableVendors({ NVIDIA_API_KEY: "  " });
    expect(available).not.toContain("nvidia");
  });

  it("does not detect nvidia when no credentials are configured", () => {
    const available = detectAvailableVendors({});
    expect(available).not.toContain("nvidia");
  });
});
