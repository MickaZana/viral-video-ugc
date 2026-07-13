/**
 * Documents the future serverless entrypoint shape for weekly cadence —
 * NOT deployed by this scaffold. When ready to deploy:
 *
 *   1. Package this handler (and the orchestrator's dependencies) as a
 *      Lambda function (container image recommended, since ffmpeg-static
 *      and better-sqlite3 are native deps — or swap review-queue to a
 *      managed store like DynamoDB/RDS for a pure-Lambda deploy).
 *   2. Create an EventBridge Scheduler rule per niche/cadence, e.g.
 *      cron(0 14 ? * WED,THU *)  — every Wed & Thu at 14:00 UTC.
 *   3. Each rule's event payload supplies { niche, platforms, brandVoice }
 *      so one Lambda handles every niche without redeploying.
 *   4. Point the rule's target at this Lambda's ARN with the payload above
 *      as the fixed input.
 *
 * Local equivalent for testing before any cloud deploy:
 *   node --loader tsx infra/cron/eventbridge-stub.ts '{"niche":"fitness","platforms":["tiktok"]}'
 */
import { RunConfigSchema, type Platform } from "@vvugc/shared-schema";
import { nanoid } from "nanoid";
import { runCycle } from "../../apps/orchestrator/src/conductor.js";

interface ScheduledEventInput {
  niche: string;
  platforms: Platform[];
  brandVoice?: string;
  targetDurationSec?: number;
  maxCandidates?: number;
  videoVendor?: "higgsfield" | "kling" | "runway" | "pika";
}

export function parseEventInput(raw: unknown): ScheduledEventInput {
  if (typeof raw !== "object" || raw === null) throw new Error("Scheduled event payload must be an object");
  return raw as ScheduledEventInput;
}

export async function handler(event: unknown) {
  const input = parseEventInput(event);
  const config = RunConfigSchema.parse({
    runId: nanoid(),
    niche: input.niche,
    platforms: input.platforms,
    brandVoice: input.brandVoice ?? "neutral, energetic, concise",
    targetDurationSec: input.targetDurationSec ?? 25,
    maxCandidates: input.maxCandidates ?? 5,
    videoVendor: input.videoVendor ?? "higgsfield",
    dryRun: false,
    autoPost: false,
    createdAt: new Date().toISOString()
  });
  return runCycle(config);
}

if (process.argv[2]) {
  handler(JSON.parse(process.argv[2])).then((r) => console.log(JSON.stringify(r, null, 2)));
}
