# Video-Generation Worker

A persistent background process that owns all video-generation provider execution.
HTTP request handlers enqueue work and return immediately; this worker claims jobs,
manages MCP sessions, handles retries and vendor fallbacks, and meters actual costs.

## Architecture

```
HTTP request path                          Worker process
┌──────────────────────┐                  ┌──────────────────────────────────┐
│ POST /accounts/run   │───enqueue───────▶│ Claim from provider_jobs queue   │
│ (returns run ID)     │                  │   ↓                              │
└──────────────────────┘                  │ Resolve vendor (MCP or REST)     │
         │                                │   ↓                              │
         │ SSE                            │ Execute video generation         │
         ▼                                │   ↓                              │
┌──────────────────────┐                  │ Complete / Fail / Fallback       │
│ /run-progress/:runId │◀──emit progress──│   ↓                              │
│ (existing SSE hub)   │                  │ Update cost ledger               │
└──────────────────────┘                  └──────────────────────────────────┘
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VVUGC_LLM_LIVE` | Yes (for real gen) | `false` | Two-key lock: must be `true` for real provider calls |
| `DATABASE_URL` | Production | — | PostgreSQL connection string (shared with review-dashboard) |
| `VIDEO_WORKER_CONCURRENCY` | No | `2` | Max parallel provider jobs |
| `VIDEO_WORKER_POLL_MS` | No | `5000` | Poll interval when queue is empty (ms) |
| `VIDEO_WORKER_LEASE_MS` | No | `120000` | Job lease duration (ms) |
| `VIDEO_WORKER_HEALTH_PORT` | No | `4330` | HTTP port for /healthz, /metrics, /status |
| `MCP_SERVER_URL` | No | — | URL of Higgsfield MCP server (if available) |
| `MCP_CONNECT_TIMEOUT_MS` | No | `30000` | MCP connection timeout (ms) |
| `MCP_MAX_RECONNECT_ATTEMPTS` | No | `5` | Max MCP reconnection attempts |
| `KLING_ACCESS_KEY` | For Kling | — | Kling API access key |
| `KLING_SECRET_KEY` | For Kling | — | Kling API secret key |
| `REPLICATE_API_TOKEN` | For Replicate | — | Replicate API token |
| `GEMINI_API_KEY` | For Gemini | — | Gemini API key (fallback still-image) |

Plus any existing vendor keys from `.env.example`.

## MCP Connection Setup

The Higgsfield adapter requires a live MCP session. Today this means a Claude Agent SDK
session with the `HiggsfieldAi` MCP server attached. The worker manages this connection:

1. On startup, attempts to connect to `MCP_SERVER_URL`
2. If unavailable, logs a warning and falls back to REST vendors (Kling/Replicate/Gemini)
3. Monitors health via consecutive-failure tracking
4. If the session becomes unhealthy mid-operation, routes subsequent jobs to fallbacks
5. Periodically attempts reconnection in the background

**No customer ever sees MCP session management.** The request path enqueues a job with
`requestedVendor: "higgsfield"` and a `fallbackVendors` chain. The worker handles
everything transparently.

## Fallback Chain

Default order: **Higgsfield → Kling → Replicate → Gemini (still-image/Ken-Burns)**

Each fallback records:
- `requestedVendor` — what was asked for
- `actualVendor` — what actually ran
- `fallbackReason` — why the original vendor failed
- `actualCost` — real cost of the vendor that succeeded

Override per-account/client by setting `fallbackVendors` at enqueue time.

## Retry Classification

| Category | Retryable? | Fallback? | Example |
|----------|-----------|-----------|---------|
| `retryable_timeout` | Yes | No (same vendor) | Request timed out |
| `retryable_5xx` | Yes | No | 503 Service Unavailable |
| `retryable_rate_limit` | Yes | No | 429 Too Many Requests |
| `non_retryable_invalid_request` | No | No (all vendors) | 400/422 validation |
| `non_retryable_auth` | No | Yes (next vendor) | 401/403 missing creds |
| `non_retryable_cancelled` | No | No | User cancelled |

Invalid requests never retry or fallback — the request itself is bad.

## Health Endpoints

- `GET /healthz` — Liveness probe (always 200 if process is up)
- `GET /readyz` — Readiness (200 if worker loop is running)
- `GET /metrics` — Prometheus exposition format
- `GET /status` — Operator diagnostics (MCP state, worker state)

## Prometheus Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `vvugc_worker_active_jobs` | Gauge | — |
| `vvugc_worker_jobs_claimed_total` | Counter | vendor |
| `vvugc_worker_jobs_completed_total` | Counter | vendor, was_fallback |
| `vvugc_worker_jobs_failed_total` | Counter | vendor, error_category |
| `vvugc_worker_jobs_dead_lettered_total` | Counter | vendor |
| `vvugc_worker_fallback_events_total` | Counter | from_vendor, to_vendor, reason |
| `vvugc_worker_retry_events_total` | Counter | vendor, error_category |
| `vvugc_worker_provider_duration_seconds` | Histogram | vendor, status |
| `vvugc_worker_provider_cost_usd` | Counter | vendor |
| `vvugc_worker_queue_depth` | Gauge | — |
| `vvugc_worker_lease_recoveries_total` | Counter | — |
| `vvugc_worker_mcp_session_healthy` | Gauge | — |

## Dead-Letter Replay

Jobs that exhaust retries + fallback chain are moved to `dead_letter` status.
Replay via the admin API:

```
POST /api/provider-jobs/:id/replay
```

This resets attempts and re-queues the job.

## Deployment

```bash
# Docker Compose (development)
docker compose up -d video-worker

# Standalone
docker build -f Dockerfile.video-worker -t vvugc-video-worker .
docker run --env-file .env -p 4330:4330 -v ./runs:/repo/runs vvugc-video-worker
```

## Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop claiming new jobs
2. Wait for active jobs to complete (respects lease timeout)
3. Disconnect MCP session
4. Close health HTTP server
5. Exit 0

## Dry-Run Safety

The same two-key lock as the rest of the system:
- `VVUGC_LLM_LIVE` must be `true` in the environment
- Without it, every job uses the mock adapter (no API calls, no cost)
- This is enforced at the worker level before any adapter is instantiated
