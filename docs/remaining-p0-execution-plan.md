# Remaining P0 Execution Plan

This plan covers the work that cannot be truthfully closed by mocked APIs or local engineering alone:

1. Funded live vendor acceptance.
2. TikTok and Meta developer approval.
3. Provider-hosted OAuth connection flows.
4. Production secrets and operational validation.
5. Final launch evidence.

The tasks are ordered by dependency. Do not announce general availability until every launch gate at the end of this document passes.

## Definition of done

The remaining P0 work is complete when:

- An agency can connect at least one real YouTube publishing account through OAuth.
- Approved TikTok and Meta applications can complete their respective OAuth flows.
- A real source is discovered and transcribed.
- A real Claude script, real video, optional voiceover, captions, and final MP4 are produced.
- The video appears only in the correct organization's client review queue.
- An authorized reviewer approves it.
- It publishes to the intended client account.
- The published URL and platform post ID are persisted.
- The acceptance-evidence file passes every check.
- Costs, latency, retries, failure notifications, audit events, and token refresh behavior are verified.
- This succeeds in staging for three consecutive scheduled cycles.

## Phase 0 — Decisions and accounts

Owner: product owner

Estimated elapsed time: one to three days, excluding platform review queues.

### Tasks

- Select the first supported production path:
  - Discovery: YouTube.
  - Script and QA: Anthropic.
  - Video: choose one of Kling, Runway, Gemini, or Replicate.
  - Voice: ElevenLabs, Grok, or no narration.
  - Publishing: YouTube first.
- Decide which company or legal entity owns each provider account.
- Confirm the production domain and OAuth callback domain.
- Create separate staging and production provider applications where supported.
- Set spending limits and alert thresholds in every funded vendor account.
- Define the maximum acceptable cost per completed video.
- Define the maximum acceptable end-to-end generation time.
- Assign a named owner for billing, platform approval, security incidents, and failed scheduled runs.

### Required output

A private operations record containing:

- Provider account owner.
- Application IDs.
- Billing owner.
- Approved callback URLs.
- Spending limits.
- Emergency vendor-disable contacts.

Do not place secrets in this document or the Git repository.

### Acceptance criteria

- Every provider account uses organization-controlled email and MFA.
- Staging and production credentials are separate.
- Cost and latency targets have explicit numeric values.

## Phase 1 — Production secret configuration

Owners: engineering and operations

Estimated engineering time: half a day.

### Required secrets

Configure these in the deployment platform's encrypted secret store:

- `ANTHROPIC_API_KEY`
- `YOUTUBE_API_KEY`
- Credentials for the selected video vendor
- Credentials for the selected voice vendor, if applicable
- `OPENAI_API_KEY` for ASR fallback
- `SOCIAL_TOKEN_ENCRYPTION_KEY`
- `ASSET_SIGNING_SECRET`
- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`
- `DATABASE_URL`
- [x] Stripe keys and real Price IDs when billing is enabled

Generate `SOCIAL_TOKEN_ENCRYPTION_KEY` and `ASSET_SIGNING_SECRET` from cryptographically secure random bytes. Use at least 32 random bytes for each.

### Engineering tasks

- Add startup validation that refuses production startup when mandatory secrets are missing.
- Document the key-rotation procedure for encrypted social tokens.
- Back up the PostgreSQL database before rotating the social-token encryption key.
- Add a rotation command that decrypts with the previous key and re-encrypts with the next key.
- Confirm secrets never appear in logs, acceptance reports, API responses, job records, or audit records.

### Acceptance criteria

- Production refuses to start with an incomplete secret set.
- A staging token can be encrypted, read by the publishing service, rotated, and read again.
- Repository and log scans find no credential values.
- Staging and production use different encryption and signing keys.

### Rollback

- Retain the previous encryption key in the secret store until all stored tokens have been re-encrypted and verified.
- If rotation validation fails, restore the database backup and previous key.

## Phase 2 — First funded live pipeline acceptance

Owners: engineering and content operations

Estimated engineering time: one to two days.

Start with one client, one YouTube source, one video vendor, one target platform, and a maximum of one candidate.

### Procedure

1. Create a staging organization and client.
2. Configure its niche, brand voice, locale, platform, duration, and chosen vendors.
3. Run the acceptance endpoint with live mode enabled.
4. Observe each stage:
   - Discovery
   - Caption retrieval
   - ASR fallback, if captions are unavailable
   - Claude rewrite
   - Caption timing
   - Video generation
   - Voice generation, if selected
   - Assembly
   - QA and originality checks
   - Review-queue insertion
5. Review the resulting MP4 manually.
6. Inspect `acceptance-evidence.json`, `manifest.json`, and `cost-ledger.json`.
7. Repeat with a source that has no usable caption track to force the ASR path.
8. Repeat once with a deliberately invalid vendor credential to verify retry, failure, and dead-letter behavior.

### Required evidence

Capture:

- Provider job IDs.
- Run ID.
- Client and organization IDs.
- Final artifact path and checksum.
- Acceptance report.
- Actual USD cost.
- Total processing time.
- Per-stage processing time.
- Retry count.
- Human quality decision and notes.

### Acceptance criteria

- No mock adapter is used.
- Every generated video file is non-empty and playable.
- Audio and captions remain synchronized.
- Source, rewritten script, and final video are visible only to the intended organization.
- A failed vendor call retries and eventually reaches the correct terminal state.
- The measured cost is below the agreed maximum.
- The measured processing time is below the agreed maximum.
- No secret appears in persisted evidence.

### Rollback

- Set scheduled clients to `manual`.
- Disable live scheduled execution.
- Revoke the failing vendor credential.
- Keep dry-run functionality available while the vendor issue is investigated.

## Phase 3 — YouTube OAuth and real publishing

Owners: engineering and product owner

Estimated engineering time: two to four days.

YouTube should be completed first because it does not depend on TikTok Research API or Meta app approval.

### Provider setup

- Create a Google Cloud project.
- Enable YouTube Data API v3.
- Configure the OAuth consent screen.
- Add staging and production redirect URIs.
- Request only the scopes required for account identification and video upload.
- Complete verification if Google requires it for the selected scopes or user volume.

### Engineering tasks

- Add an OAuth initiation endpoint that creates a signed, expiring state value containing organization and client identity.
- Add a callback endpoint that verifies state before exchanging the authorization code.
- Store access and refresh tokens with the encrypted social-connection store.
- Retrieve and persist the connected channel ID and display name.
- Refresh expired access tokens using the stored refresh token.
- Mark connections `expired` or `reconnect_required` when refresh fails.
- Prevent duplicate callback processing through an idempotency key.
- Add a disconnect action that revokes the provider token before deleting the local connection where possible.
- Update publishing so it selects the client's stored connection instead of global environment access tokens.
- Persist the connected account ID on every publishing result.

### Security requirements

- OAuth state must be signed, single-use, and short-lived.
- Callback redirect destinations must come from an allowlist.
- Tokens must never be sent to browser JavaScript.
- Refresh and publishing operations must be server-side.
- Authorization must verify both organization and client ownership.

### Acceptance criteria

- Two different organizations can connect different YouTube channels.
- Neither organization can enumerate, refresh, disconnect, or publish through the other's connection.
- Access-token expiry is handled without manual intervention.
- Revoking consent at Google produces a clear reconnect state.
- An approved staging video publishes to the intended channel.
- Published post ID and URL are persisted on the correct review item.
- Repeating the publish request does not create a duplicate upload.

### Rollback

- Disable YouTube publishing while retaining review and download functionality.
- Revoke staging OAuth credentials.
- Disconnect affected client connections.

## Phase 4 — TikTok developer approval and OAuth

Owners: product owner for approval; engineering for integration

Estimated engineering time after approval: three to five days.

Platform review time is external and can take substantially longer.

### Approval work

- Create or verify the TikTok developer organization.
- Create separate staging and production applications.
- Apply for the Research API if TikTok discovery is required.
- Apply for Content Posting API access for publishing.
- Provide:
  - Product description
  - Privacy policy
  - Terms of service
  - Data retention and deletion policy
  - Screen recording of the authorization and publishing workflow
  - Production domain ownership
- Record every submitted scope and its product justification.

### Engineering tasks

- Implement signed OAuth state and callback handling.
- Store the TikTok user/account identifier with encrypted tokens.
- Implement refresh-token rotation according to TikTok's response rules.
- Surface approval, audit, privacy, and publishing states in the UI.
- Handle creator-information and publishing-limit checks before upload.
- Make publishing idempotent and persist provider job IDs.
- Add reconnect UX for revoked or expired authorization.
- Replace global TikTok publishing tokens with per-client connections.

### Acceptance criteria

- Live discovery succeeds through the approved Research API application.
- A client connects its own TikTok account.
- A video publishes only after human approval.
- The intended account receives the post.
- Token refresh, revocation, retry, and duplicate-submit cases are verified.

### Rollback

- Disable TikTok discovery and publishing per client.
- Keep YouTube and dry-run workflows operational.

## Phase 5 — Meta approval and OAuth

Owners: product owner for approval; engineering for integration

Estimated engineering time after approval: four to seven days.

### Approval work

- Create or verify the Meta Business portfolio.
- Create separate staging and production applications.
- Connect a test Facebook Page and Instagram Business/Creator account.
- Request the exact Instagram and Page permissions used by discovery and publishing.
- Submit privacy policy, data deletion instructions, screencast, test credentials, and scope justification.

### Engineering tasks

- Implement Meta OAuth initiation and callback routes with signed state.
- Discover eligible Pages and Instagram professional accounts after authorization.
- Let the user select the exact destination account.
- Persist Page ID, Instagram account ID, labels, token expiry, and granted scopes.
- Handle long-lived token exchange and expiry.
- Replace global Meta publishing environment variables with per-client connection data.
- Verify the signed public asset URL is reachable from Meta in staging.
- Persist container IDs, publishing IDs, final URLs, and errors.
- Surface account eligibility and missing-permission errors in plain language.

### Acceptance criteria

- Instagram discovery succeeds for the approved application and selected professional account.
- Two clients can connect different Meta destinations without data leakage.
- Instagram Reels and Facebook publishing target the selected account.
- Token expiry, revocation, account removal, and missing permissions have actionable reconnect states.
- Public video URLs expire after the intended publishing window.

### Rollback

- Disable the affected Meta destination without disabling the rest of the client.
- Revoke the Meta token and invalidate outstanding asset links.

## Phase 6 — Scheduling, jobs, and failure operations

Owners: engineering and operations

Estimated engineering time: two to four days.

The local durable job implementation must be validated against the actual deployment topology.

### Engineering tasks

- Store production jobs in PostgreSQL rather than a local JSON file.
- Use transactional job claiming with `FOR UPDATE SKIP LOCKED` or a dedicated queue service.
- Add worker heartbeats and reclaim jobs abandoned by crashed workers.
- Add exponential backoff with jitter.
- Define retryable versus non-retryable errors by vendor.
- Add maximum runtime and cancellation propagation to vendor polling loops.
- Add a dead-letter inspection and replay UI.
- Enforce plan quota at enqueue time and again immediately before execution.
- Make scheduler and manual-run idempotency keys deterministic.
- Add notifications for:
  - Dead-lettered jobs
  - Reconnect-required social accounts
  - Empty scheduled runs
  - Cost-limit breaches
  - Repeated vendor degradation

### Acceptance criteria

- Killing a worker during video generation does not lose the job.
- Two workers cannot execute the same job concurrently.
- A stuck job is reclaimed safely.
- Non-retryable errors dead-letter immediately.
- Retryable errors use bounded exponential backoff.
- A cancelled job stops before additional vendor spend where the provider supports cancellation.
- Job state survives application restarts and deployment rollouts.

### Rollback

- Stop workers while preserving queued jobs.
- Return clients to manual scheduling.
- Resume only after queue integrity has been verified.

## Phase 7 — Security and compliance launch review

Owners: engineering, product owner, and external security/legal reviewers where appropriate

Estimated engineering time: three to seven days.

### Engineering tasks

- Replace Basic Auth as the primary operator identity with named accounts and roles.
- Add fine-grained client roles:
  - Owner
  - Admin
  - Editor
  - Reviewer
  - Viewer
- Apply explicit CSRF tokens to session-authenticated mutations; same-origin checking remains defense in depth.
- Add login and security-event audit records tied to account IDs.
- Add session revocation for password changes, role changes, and account removal.
- Add MFA for owners and administrators.
- Add data export and deletion workflows.
- Define retention periods for source transcripts, generated media, tokens, audit records, and rejected content.
- Add automated dependency and container scanning in CI.
- Add database backup, restore, and point-in-time recovery tests.
- Run a tenant-isolation security test against every read and mutation route.
- Conduct threat modeling for:
  - OAuth account linking
  - Signed public media URLs
  - Publishing actions
  - Prompt injection through source transcripts
  - Malicious media files
  - SSRF and path traversal

### Acceptance criteria

- No cross-tenant read or mutation succeeds.
- Every privileged action has a named actor in the audit trail.
- Backup restoration meets the agreed recovery objectives.
- Dependency and container scans have no unresolved critical findings.
- OAuth and publishing threats have documented mitigations.
- Privacy policy and platform disclosures match actual data handling.

## Phase 8 — Staging soak and launch

Owners: engineering, operations, and content operations

Minimum elapsed time: three scheduled cycles.

### Staging soak

Run at least:

- Five clients.
- Two niches.
- Two locales.
- Two destination accounts.
- One voiceover and one non-voiceover configuration.
- Three consecutive scheduled cycles.

Measure:

- Completion rate.
- Cost per usable video.
- Median and 95th-percentile completion time.
- Retry frequency.
- Dead-letter frequency.
- Human approval rate.
- Regeneration rate.
- Publishing success rate.
- Token refresh success rate.

### Launch gates

All must be true:

- At least 95% of scheduled client runs reach a clear terminal state.
- No tenant-isolation incident occurs.
- No duplicate publication occurs.
- No secret appears in logs or downloadable evidence.
- Backup and restoration have been demonstrated.
- Cost is within the approved unit-economics threshold.
- Failed jobs and expired connections generate actionable notifications.
- Legal and platform policy review is complete.
- Marketing claims are updated to match measured capabilities.

## Work that remains blocked on external input

The following cannot be completed solely through repository changes:

- Supplying funded vendor credentials.
- Choosing the primary production video and voice vendors.
- Supplying the production domain and redirect URLs.
- Completing TikTok developer review.
- Completing Meta App Review.
- Completing Google OAuth verification if required.
- ~~Supplying real Stripe products and Price IDs.~~ (Completed)
- Approving cost, latency, retention, and reliability targets.
- Providing real client accounts for the staging soak.

## Recommended execution order

1. Complete Phase 0 decisions.
2. Configure staging secrets.
3. Run the first funded pipeline acceptance.
4. Complete YouTube OAuth and publishing.
5. Submit TikTok and Meta approval applications immediately; their review clocks can run in parallel.
6. Move jobs to PostgreSQL and complete operational hardening while approvals are pending.
7. Complete TikTok and Meta integrations after approval.
8. Run security/compliance review.
9. Complete the three-cycle staging soak.
10. Update marketing copy from measured evidence and launch.
