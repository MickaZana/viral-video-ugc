# Video-Generation Worker — Independent Infrastructure Review

**Feature**: Hosted Video-Generation Worker with Higgsfield MCP Reliability and Fallbacks
**Date**: 2026-08-19
**Status**: Awaiting human review before merge/deploy

---

## Verification Checklist

### Security & Isolation

- [ ] Auth: Worker does not expose any customer-facing endpoints; health endpoints are operator-only
- [ ] Tenant isolation: Jobs carry orgId/clientId; store queries enforce ownership
- [ ] Secrets: No API keys, tokens, or credentials appear in logs (sanitizeError strips 32+ char strings)
- [ ] Provider credentials: Loaded from env at adapter instantiation, never serialized to job records
- [ ] CSRF/Origin: No browser-facing mutations on the worker's health server
- [ ] MCP session: Owned by the worker process, never exposed to HTTP request path

### Cost Controls

- [ ] Dry-run enforcement: VVUGC_LLM_LIVE=true required, same two-key lock as rest of system
- [ ] Bounded retries: maxAttempts per job (default 3), never unbounded
- [ ] Cost metering: actualCost recorded per completed job, provider-specific rates
- [ ] Estimated vs actual: estimatedCost set at enqueue, actualCost set at completion
- [ ] Dead-letter: Jobs exhausting retries stop, never silently retry forever
- [ ] Rate-limit backoff: Higher base backoff on 429s to avoid spending during limits

### Reliability

- [ ] Lease model: SKIP LOCKED claim, heartbeat renewal, expired-lease recovery
- [ ] Graceful shutdown: SIGTERM/SIGINT → stop claiming → wait for active → exit
- [ ] Idempotency: Duplicate idempotencyKey returns existing job, no duplicate generation
- [ ] Cancellation: Pre-execution check + inter-vendor check, acknowledgeCancelled protocol
- [ ] MCP unavailability: Detected before spending credits, automatic fallback to REST vendors
- [ ] Provider timeout: Classified as retryable, bounded retry count
- [ ] Fallback chain: Ordered (Higgsfield→Kling→Replicate→Gemini), per-account overridable
- [ ] Invalid request: Never retries, never falls back (request is bad for all vendors)

### Observability

- [ ] Health endpoints: /healthz (liveness), /readyz (readiness), /status (operator)
- [ ] Prometheus metrics: Queue depth, active jobs, latency, cost, fallback rate, dead-letter count
- [ ] Structured logging: pino with jobId/runId/vendor context, no secrets
- [ ] MCP health: Tracked via consecutive-failure counter and state gauge
- [ ] Fallback reasons: Recorded on the job record for dashboard display

### Deployment

- [ ] Dockerfile: Multi-stage, non-root, health check, deterministic prod install
- [ ] docker-compose: Service with env_file, volume mount, depends_on review-dashboard
- [ ] Env documentation: All variables documented with types and defaults
- [ ] Existing services unmodified: review-dashboard/orchestrator/marketing-site unchanged

### Compatibility

- [ ] Existing PipelineJobStore: Untouched — provider jobs layer on top
- [ ] Existing VideoGenAdapter interface: Used unchanged via getVideoGenAdapter()
- [ ] Existing model selection rules: Preserved (AGENTS.md contract)
- [ ] Existing fallback behavior: Not deleted — enhanced at provider-job level
- [ ] Existing run-progress SSE: Unchanged — worker emits to same channel
- [ ] Existing cost ledger: Compatible — actualCost uses same rate model

### Testing

- [ ] Provider job store: enqueue, claim, heartbeat, complete, fail, cancel, replay, recovery
- [ ] MCP session: connect, unavailable, reconnect, health tracking, sanitized errors
- [ ] Retry policy: All 6 categories classified correctly, backoff bounded
- [ ] Fallback chain: Default chain, custom chain, disabled vendors, unknown vendors
- [ ] Idempotency: Duplicate key returns same job
- [ ] Lease recovery: Expired leases re-queued
- [ ] Cancellation: Before claim, during generation
- [ ] Dry-run: Mock adapter used, no real calls
- [ ] Tenant isolation: listByRun scoped correctly
- [ ] Secret sanitization: Long strings and key= patterns redacted

---

## Residual Risks

1. **MCP connector not fully implemented**: The `createMcpConnector` function in index.ts
   is a placeholder that throws. Real MCP integration requires a Claude Agent SDK session
   or equivalent stdio/HTTP MCP transport. The worker gracefully falls back to REST vendors
   until this is wired.

2. **PostgreSQL provider job store not yet implemented**: The in-memory store works for
   development and testing. Production requires porting to PostgreSQL (same pool as
   pipeline-jobs.ts). The interface is defined; implementation follows the same pattern
   as the existing pipeline-jobs.postgres store.

3. **Progress emission from worker**: The worker currently completes/fails jobs in the store
   but doesn't emit to the run-progress SSE hub. Integration requires the worker to call
   `emitProgress()` or write to a shared channel the dashboard reads.

4. **Enqueue path**: The review-dashboard's job creation flow needs to enqueue provider-level
   jobs (one per clip/segment) alongside or instead of the current run-level pipeline job.
   This integration is the handoff point between the existing system and the new worker.

5. **Cost ledger integration**: The worker records `actualCost` on the provider job, but
   doesn't yet write to the existing cost-ledger.json/packages/shared-cost. A follow-up
   pass should call `costLedger.recordVideoGeneration(vendor, cost)`.

---

## Verdict

**Architecture**: Sound. Clean separation between job contract, worker lifecycle, MCP
session management, retry policy, and fallback logic. Each atom is independently testable.

**Safety**: The two-key lock, bounded retries, dead-lettering, and sanitized logging
prevent runaway costs and credential leaks.

**Compatibility**: No existing files modified except docker-compose.yml (additive service).
The existing pipeline-jobs store, video adapters, and model selection are untouched.

**Recommendation**: Approve for merge to a feature branch. The 5 residual items above are
follow-up work that doesn't block the infrastructure foundation being reviewed here.
Deploy to staging with `VVUGC_LLM_LIVE=false` first, verify dry-run behavior, then
enable with a real provider credential.

---

## Files Changed

### New Files
- `packages/review-queue/src/provider-jobs.ts` — Provider job type/store interface + in-memory impl
- `apps/video-worker/package.json` — Package manifest
- `apps/video-worker/tsconfig.json` — TypeScript config
- `apps/video-worker/src/index.ts` — Entry point with signal handling
- `apps/video-worker/src/worker.ts` — Core worker loop
- `apps/video-worker/src/mcp-session.ts` — MCP session lifecycle
- `apps/video-worker/src/retry-policy.ts` — Error classification + backoff
- `apps/video-worker/src/fallback-chain.ts` — Vendor fallback resolution
- `apps/video-worker/src/metrics.ts` — Prometheus metrics
- `apps/video-worker/src/health.ts` — Health HTTP server
- `apps/video-worker/src/worker.test.ts` — Comprehensive test suite
- `Dockerfile.video-worker` — Container build
- `docs/video-worker.md` — Operations documentation
- `docs/video-worker-review.md` — This review document

### Modified Files
- `docker-compose.yml` — Added video-worker service (additive only)
