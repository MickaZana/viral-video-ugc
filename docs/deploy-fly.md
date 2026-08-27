# Deploying to Fly.io

Fly.io is one option among several (see the README's Deployment section) — nothing
about this repo requires it. `fly.review-dashboard.toml` and `fly.marketing-site.toml`
at the repo root are ready-to-use configs for it if you want a concrete, working path
rather than choosing a host from scratch.

**The control-panel SPA (the product workspace / "better yorbi" front-end) ships
with the review-dashboard app, not separately.** `server.ts` serves the built SPA at
`https://<review-dashboard-host>/app` (assets under `/assets`, and the SPA's `/api/*`
calls are rewritten to the backend's real routes same-origin so session-cookie auth
works without CORS). Because `Dockerfile.review-dashboard` runs `pnpm -r run build`
and copies the result into the runtime image, deploying the review-dashboard is
sufficient — there is no separate control-panel image to build or host.

**`video-worker` is separate from this Fly walkthrough.** It is a long-running
provider-job worker, has its own CI-published `video-worker` image, and is included
in local `docker-compose.yml`. Deploy it as an independent worker process on the
platform selected for background work; it is not replaced by the control-panel SPA
or the review-dashboard HTTP service. This document intentionally only contains Fly
configs for the two public HTTP apps.

Both configs build the image directly from source on Fly's own builders
(`[build] dockerfile = ...`), not from the images `ci.yml` pushes to GHCR. That's
deliberate: pulling a private GHCR image onto Fly needs extra registry-credential
setup, and building from source keeps this walkthrough to one tool (`flyctl`) with
nothing else to authenticate. The tradeoff is that `.github/workflows/rollback.yml`
(which retags a GHCR image) has no effect on a Fly deployment — see "Rollback" below
for what to do instead. If you'd rather have Fly deploy the exact CI-verified image,
switch `[build] dockerfile = "..."` to `[build] image = "ghcr.io/<owner>/<repo>/<app>:latest"`
in the relevant `.toml` and set up registry auth (`fly auth docker` after making the
GHCR packages public, or Fly's registry-credential secrets) — not covered here.

## Prerequisites

- [`flyctl`](https://fly.io/docs/flyctl/install/) installed and logged in (`fly auth login`).
- Run every command below from the **repo root**, not from `apps/review-dashboard` or
  `apps/marketing-site` — both Dockerfiles' `COPY` steps assume a repo-root build
  context (see either Dockerfile's own comments). Point `--config` at the right
  `.toml` explicitly; there's no default `fly.toml` at the root.
- Docker is *not* required locally — `fly deploy` builds remotely on Fly's own
  builders by default.

## One-time setup, per app

The two apps are independent Fly apps — repeat this section once for each
(`fly.review-dashboard.toml`, `fly.marketing-site.toml`).

1. **Create the app.** `app = "viral-video-ugc"` / `app = "vvugc-marketing-site"`
   in each `.toml` are placeholders — Fly app names are globally unique across *all*
   of Fly, not just your account, so one of them will likely already be taken:
   ```
   fly apps create viral-video-ugc
   ```
   If that name is taken, pick another and update `app =` in the `.toml` to match
   before continuing — every command below assumes the `.toml`'s `app` value is the
   real, created app name.

2. **Create the persistent volume.** Both apps write real state (accounts, sessions,
   billing plans, the review queue itself, or the waitlist) to `/data`, which must
   survive deploys and restarts — Fly machines otherwise wipe their local filesystem
   on every deploy. Each app gets its **own** volume (Fly volumes are per-app even
   when the name string matches):
   ```
   fly volumes create vvugc_runs --region ams --size 1 -a viral-video-ugc
   fly volumes create vvugc_runs --region ams --size 1 -a vvugc-marketing-site
   ```
   Use the same `--region` as each `.toml`'s `primary_region` (`ams` in the
   checked-in configs). Change the commands and both configs together if you
   choose a different region.

3. **Set required secrets.** Never put these in the `.toml`'s `[env]` block (which is
   committed, plaintext config) — `fly secrets set` stores them encrypted and injects
   them as env vars at runtime, same names as `.env.example`.

   **review-dashboard** — set at minimum:
   ```
   fly secrets set -a viral-video-ugc \
     DASHBOARD_USERNAME=<a real username> \
     DASHBOARD_PASSWORD=<a real, strong password>
   ```
   Skipping this isn't a hard failure — the dashboard falls back to generating a
   random one-time password and printing it to the log on every boot (see
   `apps/review-dashboard/src/auth.ts`) — but on a real deployment that means a fresh
   password (and a locked-out operator) on every restart. Set both before your first
   real deploy, not after.

   Add these when you're ready to turn the corresponding feature on (each fails
   loudly with a clear error if unset — nothing silently breaks or falls back to a
   placeholder):
   ```
   fly secrets set -a viral-video-ugc \
     STRIPE_SECRET_KEY=sk_live_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_ID_STARTER=price_... \
     STRIPE_PRICE_ID_GROWTH=price_... \
     STRIPE_PRICE_ID_AGENCY=price_... \
     ANTHROPIC_API_KEY=sk-ant-... \
     ASSET_SIGNING_SECRET=<any long random string>
   ```
   `ASSET_SIGNING_SECRET` specifically: leaving it unset generates an in-memory
   secret at boot, which is fine for a single long-running machine (this repo's
   default `min_machines_running = 1`) but invalidates any already-issued signed
   Instagram-publish URLs on every restart. Set it for a stable value across restarts.

   **marketing-site** — no secrets are strictly required to boot; set these when
   relevant:
   ```
   fly secrets set -a vvugc-marketing-site \
     WAITLIST_WEBHOOK_URL=https://... \
     GEMINI_API_KEY=...   # only needed to run generate-demo-videos.ts, not at runtime
   ```

## First deploy

```
fly deploy --config fly.review-dashboard.toml
fly deploy --config fly.marketing-site.toml
```

Each `[[http_service.checks]]` block hits `/healthz` (unauthenticated by design — see
both `server.ts` files) every 15s with a 10s grace period; `fly status -a <app>` and
the Fly dashboard will show the machine unhealthy until that check passes. Tail logs
with `fly logs -a viral-video-ugc` (or `-a vvugc-marketing-site`) while it boots.

## After the first deploy

- **`PUBLIC_BASE_URL`**: `fly.marketing-site.toml` has it commented out — uncomment and
  set it to the real `https://vvugc-marketing-site.fly.dev` URL (or a custom domain
  once attached), then `fly deploy` again. Needed for correct absolute
  `og:image`/`twitter:image` URLs, and — set on the **review-dashboard** app instead,
  same variable — required for Instagram Reels publishing, which hands Meta's Content
  Publishing API a signed URL built from this origin.
- **Stripe webhook endpoint**: in the Stripe dashboard, point a webhook endpoint at
  `https://<your-review-dashboard-app>.fly.dev/webhooks/stripe` for
  `checkout.session.completed`, `customer.subscription.updated`, and
  `customer.subscription.deleted`. Stripe gives you a signing secret at that point —
  that's the value for `STRIPE_WEBHOOK_SECRET` above, not something you choose
  yourself.
- **Custom domain (optional)**: `fly certs add yourdomain.com -a <app>`, then follow
  the DNS instructions `flyctl` prints. Update `PUBLIC_BASE_URL` to match once attached.

## Rollback

Because both apps build from source rather than deploying a pre-built GHCR image,
`.github/workflows/rollback.yml`'s "retag `:sha` as `:latest`" mechanism does **not**
apply here — there's no GHCR image these Fly apps actually run. To roll back a Fly
deployment:

```
fly releases -a <app>              # find the version you want to return to
fly deploy --image <that release's image reference> -a <app>
```

or, more simply, `git revert`/`git checkout` the bad commit and `fly deploy` again —
since the build is reproducible from source, redeploying an old commit reproduces the
same image. Either way, verify with `fly status`/`fly logs` and a manual `/healthz`
curl before considering the rollback complete, the same as any other deploy.

## Cost note

`auto_stop_machines = false` and `min_machines_running = 1` in both configs mean the
machine never scales to zero — this is a real, ongoing Fly cost from the first
deploy, not a free-tier idle app. That's intentional (both apps need to answer
requests immediately — an operator approving content, or a customer signing up —
not cold-start on first traffic), but worth knowing going in.
