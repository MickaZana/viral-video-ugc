# Surface Audit — routes, pages, and where they actually live

A map of every user-facing route/page across the three apps in this repo, done as
the "one coherent surface" catch-up item from this session's Higgsfield gap
analysis. Scope is deliberately the *page/route* surface (what a browser can
navigate to) — not the JSON API surface underneath it, which is large and
mostly implementation detail.

Audited 2026-09-01. Re-run this audit (or at least a route diff) whenever a
route is added/removed in any of the three apps — this file goes stale
silently otherwise.

## The three apps, and how they actually relate

**They are one product with two build artifacts sharing one origin, plus one
genuinely separate deployment:**

- `apps/review-dashboard` is the Express backend — owns auth, data, and every
  JSON API route. In production it also **mounts `apps/control-panel`'s built
  SPA at `/app`** (`server.ts:359-377`, `app.use("/app", ...)`, SPA-fallback to
  `index.html`) specifically so the SPA's session cookie and CSRF protection
  work same-origin. control-panel has no server of its own — `vite build` →
  static `dist/`, hosted by review-dashboard.
- `apps/control-panel` is the actual product UI (React SPA, `react-router-dom`,
  mounted at basename `/app`). Every real feature — discovery, script rewrite,
  batch studio, review queue, brand/creator management, billing, settings —
  lives here.
- `apps/marketing-site` is a **fully separate Express app and deployment** (own
  port, own `public/`, zero runtime dependency on the other two). It's the
  public pre-signup pitch page, waitlist-gated.

## Route inventory

### apps/marketing-site (`src/server.ts`)

| Route | Method | For | Purpose |
|---|---|---|---|
| `/` | GET | Anonymous | The public pitch/waitlist page — hero, "How it works," pricing comparison, demo gallery, `#cta` → waitlist form. |
| `/privacy`, `/terms` | GET | Anonymous | **Fixed this pass** — see "Fixed" below. |
| `/tokens.css` | GET | Anonymous | Shared design-tokens stylesheet. |
| `/api/manifest` | GET | Anonymous (JSON) | Demo-video manifest for the page's gallery. |
| `/api/waitlist` | POST | Anonymous (JSON) | Rate-limited waitlist email capture. |
| `/healthz`, `/metrics` | GET | Ops | Liveness probe / Prometheus scrape target. |

### apps/control-panel (`src/App.tsx`, mounted at `/app`)

| Route | Component | For | Purpose |
|---|---|---|---|
| `/` | `Landing.tsx` (guest) / `ThisWeek.tsx` (authed) | Anonymous → org member | Guest: in-app landing page with its own pitch, $39/$99/$249 pricing, live `#preview` data, Get Started/Sign In. Authed: cadence home. |
| `/` `?mode=signin\|signup\|forgot\|reset\|invite` | `SignIn.tsx` | Anonymous | All auth flows in one component keyed off the query string. |
| `/intel`, `/intel/remix`, `/intel/:sourceId` | `Spy.tsx`, `Remix.tsx`, `IntelSource.tsx` | Org member | Discovery inbox, URL-to-remix, source detail. |
| `/studio`, `/studio/script/:id` | `VideoGenerator.tsx`, `Rewriter.tsx` | Org member | Single-run generation, hook/point/CTA rewrite step. |
| `/studio/batch`, `/studio/batch/:batchId` | `BatchStudio.tsx`, `BatchProgress.tsx` | Org member | Batch plan/enqueue, live batch progress. |
| `/studio/runs/:runId` | `StudioRun.tsx` | Org member | Live 9-stage pipeline progress (SSE). |
| `/review`, `/review/:id` | `ReviewPage.tsx`, `ReviewDetail.tsx` | Org member | Review queue, single-item approve/reject/publish. |
| `/library`, `/library/:id` | `History.tsx`, `LibraryItem.tsx` | Org member | Past productions, export tools. |
| `/brand`, `/brand/clients/:id` | `Brand.tsx` | Org member | Brand kit, agency clients, product/creator profiles. |
| `/billing` | `Billing.tsx` | Org member | Plan/usage. |
| `/settings` | `Settings.tsx` | Org member (guest sees a static note) | Password, MFA, theme, team. |
| `*` | redirect to `/` | anyone | Catch-all. |

`LegalModals.tsx` (privacy/terms/about/sitemap/DSR-GDPR) opens as an in-app
modal from both `Landing.tsx` and `WorkspaceLayout.tsx`'s footer — this is the
product's real, live legal surface, separate from marketing-site's.

### apps/review-dashboard (`src/server.ts`, `src/accounts.ts`) — HTML/redirect routes only

| Route | Method | For | Purpose |
|---|---|---|---|
| `/` | GET | Org member with a session → 302 to `/app/review`; else falls through | Session-aware entry point. |
| `/` (Basic Auth) | GET | Operator/admin | Legacy cross-tenant operator queue dashboard (`renderDashboardPage()`, self-contained HTML, no React). |
| `/account`, `/dashboard` | GET | Anyone (legacy link) | 302 to `/app`. |
| `/account/join` | GET | Invite-link recipient | 302 to `/app?mode=invite&token=...`. |
| `/oauth/google/callback` | GET | Org member, mid-OAuth | Completes Google OAuth for a client's YouTube channel, redirects to `/app/brand/clients/:id?oauth=google-connected`. |
| `/app`, `/app/*` | GET (static mount) | Anonymous → org member | Serves control-panel's built SPA. |
| `/tokens.css`, `/favicon.png`, `/favicon.ico`, `/logo.png` | GET | Anonymous | Public static assets (needed by the unauthenticated `/account`/`/app` pages). |
| `/healthz`, `/readyz`, `/metrics` | GET | Ops | Probes / scrape target. |

Also unauthenticated-by-design but not "pages": `/public/assets/:token`
(signed, single-use, time-limited video URL for vendor fetches) and
`/preview/stats`, `/preview/creators`, `/preview/runs`, `/preview/queue`
(static synthetic data feeding control-panel `Landing.tsx`'s `#preview`
section for guests).

## Findings

### Fixed this pass

**marketing-site's `/privacy` and `/terms` were dead — never routed at all.**
`src/legal.ts` had fully built, unit-tested `renderPrivacyPolicy()`/
`renderTerms()` functions (added in `ff37ebb`, explicitly labeled
"OAuth-facing" — i.e. meant to satisfy Google's public-privacy-policy-URL
requirement on the OAuth consent screen) but `server.ts` never called
`app.get("/privacy", ...)` / `app.get("/terms", ...)`. Since review-dashboard's
Google OAuth flow (`/accounts/clients/:clientId/oauth/google/start` →
`/oauth/google/callback`) needs a working public privacy-policy URL, this was
a functional gap, not cosmetic — fixed by wiring both routes, reading
`LEGAL_ENTITY_NAME`/`LEGAL_PRIVACY_EMAIL`/`LEGAL_ADDRESS` from the
environment. Since this is real legal/compliance content this codebase has no
authority to invent, the app now **refuses to boot in production** if the
first two aren't set (same "fail at boot" contract as `DATABASE_URL` in
review-dashboard), and falls back to an obviously-not-real placeholder outside
production so it can never be mistaken for genuine configuration. **Action for
a human**: set `LEGAL_ENTITY_NAME` and `LEGAL_PRIVACY_EMAIL` (and optionally
`LEGAL_ADDRESS`) in the production environment before the next marketing-site
deploy, or it will refuse to start.

### Confirmed broken, not fixed this pass — Soul ID "Train Identity"

`registerSoulIdRoutes` is still commented out in `server.ts:280`, unlike
`registerBatchRoutes` (fixed earlier this session, see the `c494218` commit) —
and unlike that fix, this one isn't a one-line uncomment:

- `apps/control-panel/src/pages/Brand.tsx` renders a live "Train Identity"
  button calling `api.trainCreatorIdentity(id)` → `POST
  /accounts/creators/:id/train`, which only exists in
  `apps/review-dashboard/src/soul-id-routes.ts`. **This button 404s in
  production today.**
- `soul-id-routes.ts`'s `CreatorProfileStore` interface is **synchronous**
  (`get(orgId, id): CreatorProfileRecord | undefined`, `update(...): ... |
  undefined`), but the real store it would need to bind to —
  `TenantProfileRepository.creatorGet`/`creatorUpdate` — is **async**
  (`Promise<CreatorProfile | undefined>`). A sync interface can't wrap an
  async implementation; the route handlers need to be rewritten to `await`
  the real store instead.
- `creatorUpdate(orgId, id, input: CreatorProfileInput)` takes a **full**
  profile input, not the `Partial<CreatorProfileRecord>` patch
  `soul-id-routes.ts` currently passes (`{ faceEmbeddingStatus: "ready",
  primaryReferenceImageUrl: primaryUrl }`) — needs a fetch-then-merge step,
  or a small helper.
- The org-id resolution (`(req as any).session?.orgId ?? (req as
  any).orgId ?? ""`) doesn't match this codebase's real `AuthedRequest`
  shape at all — every other route resolves org id via `req.accountId` →
  `deps.identity.findById(accountId)` → `account.orgId` (see
  `batch-routes.ts`'s `createEntityLookup` for the pattern to copy).

**Recommended fix** (not done here — this is a real, separate unit of work,
not a surface-audit line item): rewrite `soul-id-routes.ts`'s three handlers
to be properly async against `TenantProfileRepository` directly (drop the
bespoke `CreatorProfileStore` abstraction — it doesn't match anything real),
fix org-id resolution to the `req.accountId` → `identity.findById` pattern,
and add a small `mergeCreatorPatch()` helper for the partial-update case.
Then register it in `server.ts` the same way `registerBatchRoutes` was
re-enabled.

### Two independent landing pages pitching the same product — real drift risk, not fixed

marketing-site's `/` and control-panel's guest `Landing.tsx` are two
separately-maintained pages restating the same pitch with **different**
positioning and **different** pricing:

- marketing-site: "Turn a client niche into review-ready, trend-informed
  Shorts...", pricing shown only as "Usage-based" vs. named competitors —
  **no dollar figures**, gated behind a waitlist (`POST /api/waitlist`), and
  **no link anywhere to `/app`** — a visitor who joins the waitlist has no
  way to reach the actual product from this page.
- control-panel: "Spy The Format. Make It Yours.", explicit **$39/$99/$249**
  tiers, a live data preview, and an immediate Get Started/Sign In flow — no
  waitlist gate.

Two copies of legal content exist too (marketing-site's now-live `/privacy`/
`/terms`, and control-panel's separate `LegalModals.tsx`), with nothing
shared between them. This wasn't fixed in this pass — it's a real content/
positioning-ownership question (is the waitlist gate still wanted at all
once `/app` is a working self-serve signup?) that's a product decision, not
an engineering one. Flagging it here is the audit's job; resolving it needs a
call from whoever owns pricing/positioning.

### Not a problem

- No orphaned control-panel routes were found — every route in `App.tsx` is
  reachable from `WorkspaceLayout.tsx`'s nav or as a linked sub-page of a
  parent route.
- `/preview/*` being anonymously reachable is deliberate (it's the guest
  `Landing.tsx` preview data, never anything sensitive) — noted, not a bug.

## How to re-audit

1. `grep -n "app\.\(get\|post\|put\|delete\|use\)" apps/*/src/server.ts` per
   app for the raw route list, cross-referenced against each app's router
   (`apps/control-panel/src/App.tsx`'s `<Route>` list; marketing-site and
   review-dashboard are plain Express, so `server.ts`/`accounts.ts` are the
   whole story).
2. For each control-panel route, confirm it's linked from
   `WorkspaceLayout.tsx`'s nav array or a parent page — an unlinked route is
   either dead or intentionally deep-link-only (say which, in a comment).
2. For each frontend call site (`apps/control-panel/src/lib/api.ts`), confirm
   the backend route it targets is actually registered in a running
   `server.ts` — not just defined in a route-module file that might not be
   `registerXRoutes(...)`-called anywhere. This is exactly the class of bug
   this audit found twice (`registerBatchRoutes`, `registerSoulIdRoutes`).
