# VUGC — ARCHITECTURAL STABILITY RULE

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

- **Authentication model** — session cookie + operator Basic Auth (`shared-auth/sessions.ts`, `auth-context.ts`)
- **Organization/tenant model** — `orgId` as canonical tenant boundary (`shared-auth/accounts.ts`, `shared-platform/organization.ts`)
- **Authorization model** — role-based permissions + central helpers (`shared-platform/authorization.ts`)
- **Workspace model** — org-scoped, lazy default creation (`shared-platform/workspace.ts`)
- **Billing model** — Stripe subscription + quota + overage (`shared-billing/`, `quota.ts`)
- **Usage/quota model** — `checkRunQuota()` for all run paths (`quota.ts`, `billing-gate.ts`)
- **Audit model** — `audit.ndjson` + `security-events.ts`
- **Persistence abstraction** — JSON file stores with lockfile concurrency (future: Postgres via `DATABASE_URL`)
- **API conventions** — `/v1` namespace, envelope format, feature flags (`api-v1-routes.ts`, `api-envelope.ts`)
- **Testing architecture** — Vitest unit tests + Playwright E2E, cross-tenant isolation matrix

---

## Anti-Patterns (Do Not)

Do not create parallel systems for concepts that already exist:

- Do not create a second tenant system if organization tenancy already exists.
- Do not create a second billing system if the existing billing system can support the requirement.
- Do not create a second authorization system if the existing authorization layer can be extended.
- Do not create a second job system if the existing orchestration system can support the workload.
- Do not create a second feature flag system if `shared-platform/feature-flags.ts` can be extended.
- Do not create a second API credential system if `shared-platform/api-credentials.ts` can be extended.

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

```
viral-video-ugc/
├── apps/
│   ├── control-panel/          React SPA (Vite) — customer dashboard
│   ├── marketing-site/         Public landing page
│   ├── orchestrator/           AI pipeline (script/QA/caption agents)
│   ├── review-dashboard/       Express backend — main API server
│   └── video-worker/           Background video generation
├── packages/
│   ├── shared-platform/        Platform evolution (org, workspace, auth, flags, API, webhooks)
│   ├── shared-auth/            Accounts, sessions, clients, invites, settings, usage
│   ├── shared-billing/         Stripe, plans, tiers, checkout
│   ├── shared-config/          Env loading, validation
│   ├── shared-schema/          Zod schemas (Platform, ReviewItem, etc.)
│   ├── review-queue/           Review item storage (JSON/Postgres)
│   ├── shared-cost/            Per-run cost ledger
│   ├── shared-metrics/         Prometheus metrics
│   ├── shared-http/            HTTP utilities
│   ├── shared-analytics/       Analytics
│   ├── shared-originality/     Originality checking
│   └── mcp-*/                  8 MCP packages (discovery, video-gen, voiceover, etc.)
└── runs/                       Data directory (JSON file storage)
```

### Key Identifiers

| Concept | Canonical ID | Source |
|---------|-------------|--------|
| Tenant | `orgId` | `Account.orgId` |
| User | `accountId` | `Account.id` |
| Workspace | `workspace.id` | `shared-platform/workspace.ts` |
| Client | `AgencyClient.id` | `shared-auth/clients.ts` |
| API Credential | `ApiCredential.id` | `shared-platform/api-credentials.ts` |
| Run | `runId` | `manifest.json` in `runs/<runId>/` |
| Review Item | `ReviewItem.id` | `review-queue` |

### Feature Flags (all default: disabled)

| Flag | Env Var | Controls |
|------|---------|----------|
| Agency/Clients | `VVUGC_AGENCY_CLIENTS_ENABLED` | Agency UI + routes |
| API Platform | `VVUGC_API_ENABLED` | /v1 routes |
| Platform Admin | `VVUGC_PLATFORM_ADMIN_ENABLED` | Admin dashboard |
| Webhooks | `VVUGC_WEBHOOKS_ENABLED` | Webhook management |

---

## Goal

The goal is not architectural stagnation.

The goal is **controlled architectural evolution**.

VUGC must remain capable of becoming substantially larger and more
sophisticated without requiring unnecessary rewrites.
