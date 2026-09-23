# Engineering completion handoff

**Date:** 2026-07-23
**Launch scope:** YouTube OAuth and YouTube Shorts publishing. Meta and TikTok approval-dependent launch work is intentionally outside this release.

## Repository-controlled completion

- Google OAuth authorization-code flow, signed single-use state, refresh-token storage, proactive token refresh, disconnect/revocation, and YouTube channel discovery are implemented.
- Public application home, privacy policy, and terms pages are implemented. The privacy notice covers GDPR legal bases, retention, data-subject rights, processors, international transfers, and contact/complaint paths.
- Publishing remains behind explicit human approval and uses per-client encrypted OAuth credentials.
- Production configuration fails closed if its database, security secrets, HTTPS public URL, or operator credentials are absent.
- PostgreSQL-backed queue leasing, heartbeats, expired-lease recovery, idempotency, cancellation acknowledgement, dead-letter replay, retry jitter, and a final quota check immediately before execution are implemented.
- Both HTTP applications enforce request limits, origin/CSRF controls, rate limits, correlation IDs, metrics, structured error records, audit records, and production transport/browser headers.
- CI gates lint, compilation, unit/integration tests, browser tests, dependency scanning, and image builds. Image publication includes SBOM and provenance; jobs have hard timeouts.
- Development OAuth-token encryption no longer uses a repository-known key. Production always requires a stable secret.
- Container contexts exclude local databases, credentials, run outputs, and dependency/build artifacts.

## Environment check performed

The local `.env` was checked without printing values. These are configured:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `OAUTH_STATE_SECRET`
- `SOCIAL_TOKEN_ENCRYPTION_KEY`
- `PUBLIC_BASE_URL`

`SUPABASE_DATABASE_URL` is configured. `@vvugc/shared-config` intentionally maps
it to `DATABASE_URL` when the latter is absent, so the production PostgreSQL
requirement is satisfied without duplicating the connection string.

## External owner actions — the only launch work left

1. Confirm the existing Supabase project is active, its pooled TLS connection works from the deployment region, and its network restrictions permit the production host.
2. Deploy the immutable images to the chosen host, attach persistent secrets, set `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, and `TRUST_PROXY_HOPS` for that host, and point the production domain/DNS to it.
3. In Google Cloud, ensure the OAuth consent screen uses the deployed public URLs:
   - Home: `${PUBLIC_BASE_URL}/`
   - Privacy: `${PUBLIC_BASE_URL}/privacy`
   - Terms: `${PUBLIC_BASE_URL}/terms`
4. Register the exact deployed callback URL as an authorized redirect URI. It must exactly equal `GOOGLE_OAUTH_REDIRECT_URI` (scheme, host, path, and trailing-slash behavior).
5. Configure the YouTube Data API scopes, add test users while the app is in testing, then submit Google verification if Google requires it for the requested scope/user type.
6. Complete one funded, owner-observed acceptance run and one private/unlisted YouTube upload. Keep the generated acceptance evidence and provider upload ID as launch evidence.
7. Have the privacy policy and terms reviewed/approved by the organization’s legal/data-protection owner. Engineering can provide GDPR/DSR mechanics and wording, but cannot provide legal sign-off.
8. Configure production alerts/metrics scraping, backup retention, restore ownership, secret rotation ownership, and an incident contact in the selected hosting/provider accounts.

Meta approval is not a dependency for this YouTube-only launch and should remain disabled in the production product surface until deliberately reopened.

## Verification evidence

- ESLint: passed with 0 errors (7 pre-existing test-only `any` warnings).
- Workspace TypeScript build: all 19 buildable projects passed.
- Marketing site: 43 tests passed.
- Review dashboard: 125 tests passed.
- Shared authentication: 39 tests passed.
- Shared metrics: 15 tests passed.
- Review queue local backend: 15 tests passed. PostgreSQL-specific tests require `TEST_DATABASE_URL`; CI supplies it.

The remaining verification requiring real provider infrastructure is explicitly listed above; it is not representable truthfully as a local automated test.
