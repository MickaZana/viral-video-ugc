# Go-Live Plan — the complete, current picture

**Written 2026-09-14.** This supersedes the scattered state across
`docs/archive/audit.md`, `docs/archive/audit-2026-07-20.md`, `docs/archive/race-to-100-execution-plan.md`,
`docs/archive/plan-to-100.md`, `docs/archive/remaining-p0-execution-plan.md`,
`docs/archive/engineering-100-handoff.md`, and `docs/archive/external-setup-checklist.md` — those
are archived under `docs/archive/` for history, but several of them contradict each other (e.g. the P0
plan lists CSRF/MFA/audit-trail as open; the later handoff doc and the code
itself confirm they're actually done). Everything below was checked against
the real code today, not copied from an older doc.

## Verdict

**Not ready for public general availability today — and no amount of funding
skips the one step that matters most: a real, live, funded pipeline run has
never happened, even once, in this project's history.** Everything else is
either already done (more than the older docs give it credit for) or is a
calendar/approval process money can start but not finish early.

---

## Part A — Already done (verified today, not just claimed)

Don't redo this work. Confirmed by directly reading/running the code, not by
trusting the docs that claimed it:

- **Security surface**: CSRF protection, MFA (`mfa.ts` + tests), session
  revocation, `__Host-` prefixed cookies in production, security-event audit
  records, rate limiting, security headers on both web apps, `express.json`
  body-size limits — all real, all with dedicated test files.
- **CI hardening**: `timeout-minutes: 30` on both main jobs, `sbom: true` +
  `provenance: mode=max` on every image build, `.dockerignore`/`.gitignore`
  `*.sqlite` parity, Node 20+22 matrix, Fly.io deploy workflow
  (`deploy-fly.yml`, dormant on `FLY_API_TOKEN`), rollback workflow.
- **GHAS/CodeQL**: not blocked at all engineeringly — `codeql.yml` self-probes
  whether GHAS is enabled and no-ops cleanly until it is, auto-activating the
  moment it's switched on. Purely a business decision now (enable GHAS, or
  make the repo public, or accept the current OSV-only posture), zero code
  work left.
- **zod 3→4, express 4→5**: migrated, not deferred.
- **Marketing content**: the "fabricated creator testimonials with realistic
  handles/cost claims" flagged 2026-07-20 as high legal risk — checked the
  current manifest, it's gone; the 4 remaining `status: "placeholder"` entries
  are honest demo-video placeholders (null score, null video path), not fake
  quotes.
- **Soul ID / "Train Identity"**: flagged 2026-09-01 as 404ing in production
  (route commented out). Now genuinely wired — async, correct
  `req.accountId → identity.findById → orgId` pattern, not just re-enabled
  broken.
- **Test coverage**: `shared-auth/clients.ts` (the one flagged file) already
  covered.

## Part B — Fixed in this pass (today, this session)

All verified green (build, targeted test suites, lint), committed as 4
surgical commits on `reform/10x-first-run`:

1. **`acceptance.test.ts`** (new, 9 tests) — the orchestrator's acceptance
   runner had zero coverage. Real temp-dir files, mocked `runCycle`/
   `listReviewItems`, every check exercised independently (missing manifest,
   wrong tenant, empty video file, zero review items, `dryRun`/`live` mode).
2. **`ffprobe.test.ts`** (new, 4 tests) — real ffprobe-static binary against
   real WAV bytes, no mocking. Confirmed ffprobe genuinely runs on this
   machine (an earlier doc's "blocked in this sandbox" note was stale).
3. **`scheduler.test.ts`** (new, 13 tests) — `runDueClientSchedules`/
   `startClientScheduler` had zero coverage. Writing it found a real bug:
   `scheduler.ts` marked a billing reservation as "taken" *before* the
   `reserveRun()` call that was supposed to create it succeeded, so a
   client's own `reserveRun` failure still triggered a release of a
   reservation that never existed. Harmless on both billing backends today
   (release is a no-op miss either way) but wrong and wasteful — fixed.
4. **Backup/restore**: `backup-runs.ts` existed with **no restore
   counterpart at all** — an unrestorable backup is unverified by definition.
   Added `scripts/restore-runs.ts` (safe-by-default: restores into a fresh
   directory, refuses to overwrite a non-empty live `VVUGC_RUNS_DIR` without
   `--into-runs-dir`; verifies the restored contents parse afterward). Running
   the actual drill live surfaced two more real bugs: GNU tar misreads a
   Windows `C:\...` path's colon as remote-host syntax (fixed with a
   self-detecting retry, since Windows' *other* tar, bsdtar, has no such bug
   and rejects the naive fix outright); and tar's `-C <destination>` argument
   hit a related path-mangling issue on extraction specifically, worked
   around by using the child process's own `cwd` instead. Verified end-to-end
   (backup → restore → verify) through both the tar path and the JSON
   fallback path, on this machine, for real.
5. **CI docker-compose smoke test** — boots the just-published
   `review-dashboard`/`marketing-site` images and hits `/healthz`, supplying
   the same secret shape production's `validateProductionEnv` now requires.
   Closes this project's most recurring bug class (missing Dockerfile COPY
   manifest) before it reaches production. **Caveat**: no Docker daemon was
   available in this sandbox to run it against — written carefully against
   the real fail-closed contract, but the first real CI run on this branch is
   the actual verification.

## Part C — Fixable without you, not yet done (low priority, queued)

Nothing launch-blocking. Pick up whenever:

- **A/B testing UI** — explicitly a nice-to-have in every prior audit, never
  promised for this launch scope.
- **Deeper observability** — `packages/shared-metrics` (Prometheus, tracing)
  exists; a real error-tracking sink (Sentry-equivalent) and trend-level
  alerting (not just "zero review items this run") don't.
- **`mcp-conductor` MCP server** (added this session, see
  `docs/mcp-connectors.md`) — local-only by design; a hosted/multi-user
  variant with per-user auth is a real, separate build if you want it later.

## Part D — Blocked on you / external (money doesn't skip these)

In recommended order:

1. **Fund and run one real, live, funded pipeline cycle.** This is the single
   biggest gap, unchanged across every audit this project has ever had, and
   personally re-confirmed this session: even with a correctly-formatted
   `ANTHROPIC_API_KEY`, the account had zero credits; `GEMINI_API_KEY` was the
   wrong credential type entirely. Add credits at
   console.anthropic.com/settings/billing, fix the Gemini key at
   aistudio.google.com/apikey, then run one candidate live and keep the
   evidence (`docs/archive/external-setup-checklist.md` has the exact steps).
2. **YouTube OAuth for real publishing** (not just discovery) — engineering
   is described as done in `docs/archive/engineering-100-handoff.md`; the remaining
   steps are yours: register the deployed callback URL, add test users,
   complete Google verification if required, do one real private/unlisted
   upload.
3. **TikTok + Meta discovery/publishing approval** — external application
   processes with their own clocks (weeks to months). Start these in
   parallel with everything else; the code is done and waiting.
4. **Real Stripe Price IDs** — test-mode is wired; production needs your
   actual tier objects created in the Stripe dashboard.
5. **Production hosting decisions** — domain, `PUBLIC_BASE_URL`, Postgres
   provider, backup retention policy, `FLY_API_TOKEN` if using the existing
   Fly workflow.
6. **Legal sign-off** — the privacy policy/terms are engineering-complete
   (GDPR DSR mechanics, retention wording) but need your organization's
   actual legal/data-protection owner to approve the content, not just the
   mechanics.
7. **The 3-cycle staging soak** — 5 clients, 2 niches, 2 locales, 2
   destination accounts, measuring completion/cost/latency/retry rates. Pure
   calendar time once step 1-2 are live; can't be compressed.
8. **GHAS or public-repo decision** — zero code work either way (see Part A);
   just tell it which way to go.

## Bottom line

Parts A+B mean the *engineering* side of "ready" is in genuinely good shape —
better than the older docs gave it credit for, and with several real bugs
found and fixed today by actually running things rather than reading them.
What's left is almost entirely Part D: money, external approvals, and
calendar time, in that order. Nothing in Part D can be shortened by more
engineering work being done in the meantime — the honest next action is
funding step 1 and starting the TikTok/Meta applications (step 3) on the same
day, since their clocks run independently of everything else.
