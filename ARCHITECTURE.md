# VUGC — ARCHITECTURAL STABILITY RULE

> **Canonical architecture reference.** This file is the source of truth for module
> boundaries, key identifiers, and feature flags. The pipeline/dataflow design lives in
> [`docs/architecture.md`](docs/architecture.md) (kept consistent with this file).
> Current go-live status: [`docs/go-live-plan.md`](docs/go-live-plan.md).
> Superseded audits/plan docs are archived under [`docs/archive/`](docs/archive/) — do not
> treat them as current truth.

## Directive

The existing VUGC architecture is considered the current stable foundation.

Do NOT treat the architecture as immutable.

New functionality may always be added when justified.

However, do not introduce architectural changes merely for novelty,
preference, speculation, or theoretical future scaling.

Before making a foundational architectural change, determine whether the
existing architecture genuinely cannot support the requested capability.

---

## Extension Priority

Prefer:

```
EXTEND → REUSE → REFACTOR → REPLACE
```

in that order.

Only REPLACE when the existing implementation creates a demonstrable
technical, security, scalability, reliability, or maintainability problem.

---

## Integration Requirements

New features must integrate with the existing:

- **Authentication model** — session cookie + operator Basic Auth (`shared-auth/src/sessions.ts`, `apps/review-dashboard/src/auth-context.ts`, `apps/review-dashboard/src/auth.ts`)
- **Organization/tenant model** — `orgId` as canonical tenant boundary (`shared-auth/src/accounts.ts`, `shared-platform/src/organization.ts`)
- **Authorization model** — role-based permissions + central helpers (`shared-platform/src/authorization.ts`)
- **Workspace model** — org-scoped, lazy default creation (`shared-platform/src/workspace.ts`)
- **Billing model** — Stripe subscription + quota + overage (`packages/shared-billing/`, `apps/review-dashboard/src/quota.ts`, `apps/review-dashboard/src/overage.ts`)
- **Usage/quota model** — `checkRunQuota()` for all HTTP run paths (`apps/review-dashboard/src/quota.ts`, `shared-platform/src/billing-gate.ts`; CLI/cron runs are intentionally unmetered)
- **Audit model** — `runs/audit.ndjson` + `apps/review-dashboard/src/security-events.ts`
- **Persistence abstraction** — JSON file stores with lockfile concurrency for run artifacts/review queue, plus PostgreSQL via `DATABASE_URL` (implemented for identity, provider/pipeline jobs, and billing; **required in production** for identity and provider-job persistence)
- **API conventions** — `/v1` namespace, envelope format, feature flags (`apps/review-dashboard/src/api-v1-routes.ts`, `shared-platform/src/api-envelope.ts`)
- **Testing architecture** — Vitest unit tests + Playwright E2E, cross-tenant isolation matrix

---

## Anti-Patterns (Do Not)

Do not create parallel systems for concepts that already exist:

- Do not create a second tenant system if organization tenancy already exists.
- Do not create a second billing system if the existing billing system can support the requirement.
- Do not create a second authorization system if the existing authorization layer can be extended.
- Do not create a second job system if the existing orchestration system can support the workload.
- Do not create a second feature flag system if `shared-platform/src/feature-flags.ts` can be extended.
- Do not create a second API credential system if `shared-platform/src/api-credentials.ts` can be extended.

---

## When Replacement Is Justified

If a new requirement genuinely exceeds the capabilities of an existing subsystem, the agent is authorized to evolve or replace that subsystem.

Any foundational architectural change must:

1. **Explain** why the existing architecture is insufficient.
2. **Identify** affected components.
3. **Preserve** backwards compatibility where practical.
4. **Include** migration strategy.
5. **Include** regression tests.
6. **Include** security implications.
7. **Include** performance implications.
8. **Include** rollback considerations.
9. **Verify** all existing tests still pass.
10. **Document** the architectural change.

---

## Current Architecture Reference

(Verified against the working tree — this is the complete `apps/` and `packages/` inventory.)

```
viral-video-ugc/
├── apps/
│   ├── control-panel/          React SPA (Vite) — customer workspace; built into review-dashboard, served at /app
│   ├── marketing-site/         Public landing page (port 4320)
│   ├── orchestrator/           AI pipeline (script/QA/caption + curriculum/batch/ad agents), CLI `vvugc`, MCP server
│   ├── review-dashboard/       Express backend — main API server (port 4310)
│   └── video-worker/           Background video-generation worker (port 4330)
├── packages/
│   ├── curriculum-engine/      Course/lesson plan generation, QA, and storage
│   ├── design-tokens/          Shared design tokens (tokens.css)
│   ├── shared-platform/        Platform evolution (org, workspace, auth, flags, API, webhooks)
│   ├── shared-auth/            Accounts, sessions, clients, invites, settings, usage
│   ├── shared-billing/         Stripe, plans, tiers, checkout
│   ├── shared-config/          Env loading, validation
│   ├── shared-schema/          Zod schemas (Platform, ReviewItem, etc.)
│   ├── shared-persistence/     Postgres database helpers + asset paths
│   ├── review-queue/           Review item storage (JSON locally; Postgres via DATABASE_URL — required in production)
│   ├── shared-cost/            Per-run cost ledger
│   ├── shared-metrics/         Prometheus metrics
│   ├── shared-http/            HTTP utilities
│   ├── shared-analytics/       Analytics
│   ├── shared-product-analytics/  Product event store/aggregates
│   ├── shared-originality/     Originality checking
│   └── mcp-*/                  7 MCP packages: discovery, transcript, video-gen, voiceover, assembly, publish, lipsync
└── runs/                       Data directory (JSON manifests, cost ledgers, audit.ndjson; identity/queue/billing on Postgres in production)
```

### Key Identifiers

| Concept | Canonical ID | Source |
|---------|-------------|--------|
| Tenant | `orgId` | `Account.orgId` |
| User | `accountId` | `Account.id` |
| Workspace | `workspace.id` | `shared-platform/workspace.ts` |
| Client | `AgencyClient.id` | `shared-auth/clients.ts` |
| API Credential | `ApiCredential.id` | `shared-platform/api-credentials.ts` |
| Run | `runId` | `manifest.json` in `runs/<runId>/` (written by `apps/orchestrator/src/conductor.ts`) |
| Review Item | `ReviewItem.id` | `review-queue` |

### Feature Flags (all default: disabled)

| Flag | Env Var | Controls |
|------|---------|----------|
| Agency/Clients | `VVUGC_AGENCY_CLIENTS_ENABLED` | Agency UI + routes |
| API Platform | `VVUGC_API_ENABLED` | /v1 routes |
| Platform Admin | `VVUGC_PLATFORM_ADMIN_ENABLED` | Admin dashboard |
| Webhooks | `VVUGC_WEBHOOKS_ENABLED` | Webhook management |

Status nuance: the flags default to `false` (`shared-platform/src/feature-flags.ts`), and enabling them does not imply the feature behind them is complete — e.g. `/v1` routes are deliberate 501 `not_implemented` stubs even when `VVUGC_API_ENABLED=true` (`apps/review-dashboard/src/api-v1-routes.ts`), and webhooks are dormant/not publicly exposed (`shared-platform/src/webhooks.ts`).

---

## Goal

The goal is not architectural stagnation.

The goal is **controlled architectural evolution**.

VUGC must remain capable of becoming substantially larger and more
sophisticated without requiring unnecessary rewrites.
