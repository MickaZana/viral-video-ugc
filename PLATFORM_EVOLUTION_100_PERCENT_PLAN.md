# VUGC PLATFORM EVOLUTION — 100% COMPLETION PLAN

## Current Status: 100% Complete ✅ (verified 2026-08-31)

All 7 steps below are done and independently re-verified against real execution
(not assumed from this doc, which had drifted stale in several places — see the
✅/⚠️ notes inline). Full monorepo regression: **1,067 tests passed, 0 failed**
(37 correctly skipped — Postgres-gated, no `DATABASE_URL` in this environment),
clean build across all 26 workspace packages. See `PLATFORM_EVOLUTION_REPORT.md`
for the final numbers and what's still deliberately deferred (real `/v1` handler
implementations, rate-limit middleware wiring, webhook delivery engine — all
scaffolded and ready, none activated, exactly as designed).

## Original Status (superseded): ~75% Complete

### What's Done ✅
- Organization model (branded OrgId, types, resolution)
- Workspace abstraction (store, lazy defaults, org-scoped)
- Central authorization layer (5 functions, 3 actor types)
- Feature flags (4 flags, server-side, env-driven, middleware)
- Extended roles (agency_manager, client_manager, client_viewer)
- Dormant agency/client extension model
- API credential model (hashed secrets, scopes, revocation)
- API response envelope + request IDs
- Idempotency store
- Webhook endpoint model
- Invite model extension
- Config env vars documented
- Security test suite (40+ assertions)
- vitest config for new package

### What's Missing 🔴

---

## STEP 1: Build Verification (Critical — blocks everything else) — ✅ DONE

**Result (re-verified live, not assumed):** `pnpm install` → up to date. `pnpm --filter @vvugc/shared-platform build` → clean (`tsc`, zero errors). `pnpm --filter @vvugc/shared-platform test` → **44/44 passing** before this pass, **47/47** after adding the 3 audit-event tests Step 4 was missing (see below).

**None of the "expected issues" below actually occurred** — this doc predicted problems from reading the code, not from running it; the real run had none of them:
- ~~Missing `@types/node`~~ — not needed, compiled clean.
- ~~`authorization.ts` duplicate imports~~ — not an issue in practice.
- ~~Test file needs `afterEach` env cleanup~~ — already had it (`beforeEach(() => { testDir = mkdtempSync(...) })`, per-test isolated store files).

---

## STEP 2: Mount /v1 API Router (Section 18, 39) — ✅ DONE (already live)

**Result:** `apps/review-dashboard/src/api-v1-routes.ts` exists and is mounted at `server.ts:268` (`app.use("/v1", v1Router)`) — this was already committed and pushed earlier in the same working session, discovered via direct dependency-graph verification before this doc was even read. The actual implementation gates on `VVUGC_API_ENABLED` with an **inline** check (not importing `@vvugc/shared-platform`'s `requireFeature`), by deliberate design — see the file's own comment: review-dashboard doesn't take a dependency on shared-platform at the Express layer. Added the test coverage this step called for but that didn't exist yet: `server.test.ts`'s new `/v1 API gate` block (3 tests) asserts 404 when disabled/unset and 501 on every stub route once enabled.

**Correction:** this doc's own priority-order section says these routes should be "403 when disabled" — the actual (and correct, per `PLATFORM_EVOLUTION_REPORT.md` section 10's own design note) behavior is **404**, indistinguishable from a nonexistent route, specifically so a disabled feature's existence isn't leaked. The tests assert the real, correct behavior, not this doc's earlier assumption.

<details><summary>Original spec (superseded by the real implementation above)</summary>

**What:** Create `apps/review-dashboard/src/api-v1-routes.ts` with stub routes, gated by feature flag. Mount in `server.ts`.

**File: `apps/review-dashboard/src/api-v1-routes.ts`**
```typescript
import { Router } from "express";
import { requireFeature } from "@vvugc/shared-platform";

const v1Router = Router();

// All /v1 routes are disabled unless VVUGC_API_ENABLED=true
v1Router.use(requireFeature("API_PLATFORM"));

// Stub routes — return feature-disabled response when flag is enabled
// but implementation is not yet complete
v1Router.post("/scripts", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.post("/videos", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.post("/runs", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.get("/runs/:id", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.get("/runs/:id/status", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.post("/voiceovers", (_req, res) => res.status(501).json({ error: "not implemented" }));
v1Router.post("/publish", (_req, res) => res.status(501).json({ error: "not implemented" }));

export { v1Router };
```

**In `server.ts`, add:**
```typescript
import { v1Router } from "./api-v1-routes.js";
app.use("/v1", v1Router);
```

**Time estimate:** 10 min

</details>

---

## STEP 3: API Rate Limiting Middleware (Section 21) — ✅ DONE

**Result:** `packages/shared-platform/src/rate-limit.ts` already existed, fully matching (and exceeding) this spec — `API_RATE_LIMITS` covers `default`/`runs_create`/`publish`/`scripts_create` (the plan only asked for 3 of these 4), plus `resolveRateLimitKey()` for deriving the limiter key from request context, plus a `description` field on each config for error messages. Exported from `index.ts`. Covered by the existing 47-test suite.

<details><summary>Original spec (already satisfied)</summary>

**What:** Create a reusable rate-limit factory in shared-platform that API routes can use.

**File: `packages/shared-platform/src/rate-limit.ts`**
```typescript
// Rate limit configuration for API routes
// Wraps express-rate-limit with org/credential/IP awareness

export interface ApiRateLimitConfig {
  windowMs: number;
  limit: number;
  keyBy: "ip" | "credential" | "org";
}

export const API_RATE_LIMITS: Record<string, ApiRateLimitConfig> = {
  default: { windowMs: 60_000, limit: 60, keyBy: "credential" },
  runs_create: { windowMs: 60_000, limit: 10, keyBy: "org" },
  publish: { windowMs: 60_000, limit: 5, keyBy: "org" },
};
```

This is a configuration layer — the actual `express-rate-limit` middleware stays in `review-dashboard` (where Express lives).

**Time estimate:** 10 min

</details>

---

## STEP 4: Audit Event Integration (Section 28) — ✅ DONE (code was there, tests weren't)

**Result:** `api-credentials.ts`'s `onEvent` hook was already fully implemented exactly as specified — fires `api_key.created` on `create()` and `api_key.revoked` on `revoke()`, opt-in (`ApiCredentialStoreOptions.onEvent`), documented as "wire this to `writeSecurityEvent` in the calling app." The one real gap: **no test asserted any of this fired** — added 3 tests to `platform.test.ts` (creation payload shape + no secret material leaked into the event, revocation firing exactly once and not double-firing on a repeat revoke of an already-revoked credential, and that omitting `onEvent` entirely doesn't throw). 47/47 passing.

<details><summary>Original spec (code already matched this)</summary>

**What:** Emit security events from the API credential store when keys are created/revoked.

**Approach:** Add an optional `onEvent` callback to `createApiCredentialStore` that callers can wire to `writeSecurityEvent`.

```typescript
// In api-credentials.ts create():
opts.onEvent?.({ type: "api_key.created", orgId, credentialId: credential.id });

// In revoke():
opts.onEvent?.({ type: "api_key.revoked", orgId, credentialId });
```

**Time estimate:** 15 min

</details>

---

## STEP 5: Billing Enforcement Wiring (Section 36, Phase E) — ✅ DONE

**Result:** `packages/shared-platform/src/billing-gate.ts` already existed, matching the spec and going further: `BillingGateResult`, `RunBillingGate` contract type, `assertBillingGateConsulted()` (a test-time guard against accidentally bypassing the gate), and `BILLING_ENFORCED_PATHS` documenting every path (dashboard run, job queue run, scheduled run — all "existing, already enforced" — and the future `/v1/runs`, marked "MUST enforce when implemented"). Exported from `index.ts`, covered by the existing suite.

<details><summary>Original spec (already satisfied)</summary>

**What:** Ensure the future `/v1/runs` stub (when implemented) calls `checkRunQuota()` before executing.

**Approach:** Document the shared billing entry point and create a helper:

```typescript
// packages/shared-platform/src/billing-gate.ts
export async function enforceRunQuota(orgId: string, getPlan: ..., getUsage: ...): Promise<QuotaCheck> {
  // Same checkRunQuota from quota.ts — this just re-exports the contract
  // so future API handlers know they MUST call it
}
```

**Time estimate:** 10 min

</details>

---

## STEP 6: Full Regression (Phase G)

## STEP 6: Full Regression (Phase G) — ✅ DONE

**Result (real command output, not assumed):** `pnpm -r run build` clean across all 26 workspace packages. `pnpm -r run test`: **1,067 tests passed, 0 failed, 37 skipped** (Postgres-gated tests with no local `DATABASE_URL` — expected). Existing tests genuinely untouched except the 2 additive test files noted above (`shared-platform/src/platform.test.ts` +3 tests, `review-dashboard/src/server.test.ts` +3 tests) — no existing assertion was modified.

**One correction to this doc's own command:** `pnpm turbo run build --force` is not what CI actually runs — `.github/workflows/ci.yml` has its own comment explaining why: turbo's downloaded native binary hits a sandbox exec restriction in this environment, so CI uses `pnpm -r run build` (plain per-package `tsc`), which is what was actually run and verified here.

**What:** Run the complete test suite and build.

```bash
# From repo root:
pnpm install
pnpm -r test
pnpm -r run build   # not `turbo run build` — see correction above
```

---

## STEP 7: Update Implementation Report — ✅ DONE

**Result:** `PLATFORM_EVOLUTION_REPORT.md` updated with the real test/build numbers above and corrected status markers throughout (Section 20's "NOT IMPLEMENTED"/"FUTURE" lists were already accurate — those genuinely remain deferred by design, only Step 1-6's own scaffolding status needed correcting).

**What:** Update PLATFORM_EVOLUTION_REPORT.md with test results and final status.

---

## TOTAL TIME TO 100% (original estimate vs. actual)

**Actual: this pass took ~1 hour** of an agent's time, matching the original estimate — but the breakdown was very different from what was planned, because most of it (Steps 1, 2, 3, 5) turned out to already be *done*, just never verified or wired end-to-end. The real work was: verifying that, closing the two genuine test-coverage gaps (Step 4's missing audit-event assertions, Step 2's missing `/v1` gate assertions), running the full regression, and correcting this doc's stale assumptions.

| Step | Time | Needs |
|------|------|-------|
| 1. Build verification | 15-30 min | Terminal or coding agent |
| 2. Mount /v1 router | 10 min | File write + server.ts edit |
| 3. Rate limit config | 10 min | File write |
| 4. Audit event integration | 15 min | File edit |
| 5. Billing gate helper | 10 min | File write |
| 6. Full regression | 5 min | Terminal or coding agent |
| 7. Update report | 5 min | File write |

**Total: ~1-1.5 hours** with a coding agent that can compile/test iteratively.

---

## PRIORITY ORDER *(historical — all steps are now done; kept for record)*

---

## HOW TO PROCEED *(historical)*

---

## WHAT'S ACTUALLY LEFT (post-100%, deliberately out of scope for this plan)

Everything above is the scaffold: types, stores, feature flags, a dormant gated
router. None of it is a real public API yet, by design (`VVUGC_API_ENABLED`
defaults `false`, `/v1/*` 404s until explicitly opted in). Turning the scaffold
into a real product surface is separate, larger work, not part of "100%
complete" per this plan's own original scope (Section 20's "NOT IMPLEMENTED"/
"FUTURE" lists, unchanged and still accurate):

- Real `/v1/*` handlers (auth via API key, quota check, idempotency, actual
  pipeline invocation) — currently 501 stubs.
- `express-rate-limit` middleware actually wired into `review-dashboard` using
  `API_RATE_LIMITS`/`resolveRateLimitKey()` — currently a config layer only.
- Webhook delivery engine (HTTP POST + retry/backoff) — currently a store only.
- API usage accounting / billing integration for `/v1` traffic.
- Platform admin dashboard UI, API developer docs, client portal UI — all
  dormant by design.
