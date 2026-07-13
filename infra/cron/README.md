# Weekly cadence — deployment notes (not deployed by this scaffold)

`eventbridge-stub.ts` documents the intended Lambda handler shape and can be run locally today:

```bash
pnpm --filter @vvugc/orchestrator build
node --loader tsx infra/cron/eventbridge-stub.ts '{"niche":"fitness","platforms":["tiktok","youtube_shorts"]}'
```

## Deploying for real (future work, needs your cloud account + explicit go-ahead)

1. **Package**: containerize the orchestrator (native deps: `better-sqlite3`, `ffmpeg-static`) as a Lambda container image, or move `review-queue` to DynamoDB/RDS and `mcp-assembly` to a Step Functions task backed by Fargate/Batch (ffmpeg jobs don't fit Lambda's 15-min/ephemeral-disk limits well for longer videos).
2. **Schedule**: one EventBridge Scheduler rule per niche, e.g. `cron(0 14 ? * WED,THU *)` (Wed & Thu 14:00 UTC) — adjust per your audience's timezone.
3. **Fan-out**: if running multiple niches, either one rule per niche with a fixed JSON input, or a single rule invoking a dispatcher Lambda that reads a `niches` config table and fans out one `runCycle` invocation per niche via SQS/Step Functions Map state.
4. **Secrets**: move `.env` values into AWS Secrets Manager / SSM Parameter Store; inject via Lambda environment variables at deploy time, never commit them.
5. **Higgsfield MCP access**: the Higgsfield adapter needs a live MCP connection (`callMcpTool`), which today only exists inside a Claude Agent SDK / Claude environment session. For a Lambda-triggered run, either (a) have the Lambda invoke a Claude Agent SDK session configured with the Higgsfield MCP server attached, or (b) wait for/build a direct Higgsfield REST client if one becomes available, and swap it in behind the same `VideoGenAdapter` interface — Kling/Runway/Pika already work as direct Lambda-callable REST adapters today.
6. **Observability**: ship `pino` logs to CloudWatch; add a DLQ on the EventBridge target for failed runs; alert on `runCycle` throwing or on `reviewItemsCreated === 0`.
