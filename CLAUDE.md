# Project instructions for Claude

## Model selection (deliberate, budget-constrained)

This repo intentionally runs a **mix of Claude models** across the three orchestrator agents (`apps/orchestrator/src/agents/*.ts`), not one model everywhere. This is a cost/quality decision, not an oversight — preserve it when touching these files, and apply the same reasoning to any new Claude-calling stage you add.

| Agent | Stage | Model | Why |
|---|---|---|---|
| `script-agent.ts` | `script_rewrite` | `claude-fable-5` | The hook/point/CTA creative-writing bottleneck — the single stage where output quality has the most leverage over whether a finished video is worth generating at all. Worth the premium. |
| `qa-agent.ts` | `qa_score` | `claude-sonnet-5` | The gatekeeping judgment call — decides what reaches a human's review queue. Keeps the balanced default model rather than either end of the mix. |
| `caption-agent.ts` | `caption_timing` | `claude-haiku-4-5` | Mechanical, bounded, high-volume (runs once per candidate every cycle) — splits an already-written script into timed cards by reading length. Not a creative judgment call, doesn't need a premium model. |

Rules for keeping this coherent:

- **Every** `client.messages.create({ model: ... })` call must pass that same model string to `costLedger.recordAnthropicUsage(stage, usage, model)` right after — the cost ledger (`packages/shared-cost/src/index.ts`) prices per model via `ANTHROPIC_RATE_TABLE`, and silently drops to a $0 estimate for any model string not present in that table.
- Adding a **new** model to the mix means adding it to `ANTHROPIC_RATE_TABLE` in `packages/shared-cost/src/index.ts` *and* the pricing table in `docs/cost-table.md` in the same change — they're required to stay in sync, and there's a comment in each file pointing at the other.
- Before assigning a model to a new Claude-calling stage, classify it the same way the table above does: is this stage the *creative bottleneck* (quality has outsized leverage → pricier model), *mechanical/high-volume* (bounded, repetitive, low judgment → cheaper model), or a *judgment/gatekeeping call* (moderate reasoning, real consequences → the balanced default)? Don't default every new stage to whatever the last agent used.
- `claude-sonnet-4-5` stays in `ANTHROPIC_RATE_TABLE` for historical reasons only (pricing old on-disk cost-ledger JSON correctly) — no agent should newly target it; use `claude-sonnet-5`.

See `docs/cost-table.md` for the actual per-million-token rates and `packages/shared-cost/src/index.test.ts` for how the ledger's per-model splitting is verified.
