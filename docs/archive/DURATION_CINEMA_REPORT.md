# Extended Duration & Cinema Studio 4.0 — Implementation Report

**Date**: 2026-08-23 **Status**: ✅ Complete (frozen)

---

## Summary

Two features implemented as a single cohesive evolution:

1. **Extended video duration** — default raised from 25s → 35s, system supports up to 60s max
2. **Cinema Studio 4.0 parameter passthrough** — genre, emotion, and cameraType added to visual direction
3. **Duration-based pricing** — longer videos cost progressively more (multiplier on overage)
4. **Higgsfield reference cap** — raised from 9 → 50 (Cinema Studio 4.0 native capability)
5. **Vendor list** — `seedance` and `grok_video` added to AccountSettings type

---

## Duration Pricing Model

| Duration Tier | Max Seconds | Label | Cost Multiplier |
| --- | --- | --- | --- |
| Short | ≤15s | `short` | 1.0× |
| Standard | ≤30s | `standard` | 1.5× |
| Extended | ≤45s | `extended` | 2.5× |
| Premium | ≤60s | `premium` | 4.0× |

**Hard cap**: 60s — `checkRunQuota()` returns `allowed: false` if exceeded.

**Where the multiplier applies**:

- Overage billing only (runs above monthly allowance)
- Included runs in a subscription are NOT multiplied
- Recorded in the overage ledger for audit

**Example**: Agency plan ($4/run base overage) × a 45s video (2.5×) = $10 effective overage cost.

---

## Cinema Studio 4.0 — New `visualDirection` Fields

| Field | Values | Effect |
| --- | --- | --- |
| `genre` | general, action, epic, drama, comedy, horror, noir, sci_fi, documentary | Biases overall aesthetic direction |
| `emotion` | joy, anger, fear, sadness, surprise, trust, hope, tension, nostalgia | Guides expression/atmosphere |
| `cameraType` | modern, 35mm_film, 8mm_film, dv_camcorder, iphone, dslr | Camera hardware emulation (texture/grain) |

These are enriched into the generation prompt via `mapToPromptEnrichment()` for all vendors. For Higgsfield specifically, they travel through the `generate_video` prompt field.

---

## Files Modified

| File | Change |
| --- | --- |
| `packages/mcp-video-gen/src/adapters/VideoGenAdapter.ts` | Added `genre`, `emotion`, `cameraType` to `visualDirection` type |
| `packages/mcp-video-gen/src/visual-mapping.ts` | Added `genre`, `emotion`, `cameraType` to `VisualDirection` interface + label maps + enrichment |
| `packages/mcp-video-gen/src/adapters/higgsfield.ts` | Raised reference cap 9 → 50 |
| `packages/shared-auth/src/settings.ts` | Default duration 25 → 35s; added `seedance` & `grok_video` to videoVendor union |
| `packages/shared-billing/src/tiers.ts` | Added `DurationTier`, `DURATION_TIERS`, `MAX_DURATION_SEC`, `getDurationTier()`, `computeOverageCost()` |
| `packages/shared-billing/src/index.ts` | Exported new duration primitives |
| `apps/review-dashboard/src/quota.ts` | `checkRunQuota()` accepts optional `durationSec`, validates cap, applies multiplier |
| `apps/review-dashboard/src/overage.ts` | `OverageCharge` records `durationSec` and `durationMultiplier` |

---

## Backward Compatibility

- All existing callers of `checkRunQuota(plan, usage)` continue to work — `durationSec` is optional
- Existing overage records (without `durationSec`/`durationMultiplier`) remain valid — fields are optional
- `targetDurationSec: 35` is the new default but existing accounts keep whatever they last saved
- Cinema controls are optional — pipelines not passing `visualDirection` are unaffected

---

## What This Does NOT Do (out of scope for this freeze)

- **Clip stitching for >30s** — the orchestrator would need to chain 2× generation calls + assembly; documented as future work
- **"Forward Extend" integration** — Higgsfield's extend-from-last-frame API; requires paid plan testing
- **UI for Cinema Studio controls** — control-panel form needs genre/emotion/cameraType dropdowns
- **Stripe metered billing integration** — the duration multiplier is computed and recorded, but not yet wired to Stripe's metered usage reporting API

---

## Build Verification

Cannot run build from sandbox — **run **`pnpm turbo run build --force && pnpm test`** manually to verify**.

All changes are purely additive:

- New optional fields on existing interfaces
- New exported functions/constants
- Optional parameter added to existing function (backward compatible)
- No breaking signature changes

