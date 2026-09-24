#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PlatformSchema } from "@vvugc/shared-schema";
import { discoverPlatform } from "@vvugc/mcp-discovery";
import { listReviewItems, getReviewItem, setReviewItemStatus } from "@vvugc/review-queue";
import { parseRunOptions } from "./cli.js";
import { startRunJob, getRunJob } from "./mcp/jobs.js";

/**
 * Local MCP server exposing this repo's pipeline (discover -> script -> video-gen
 * -> assembly -> QA -> human review queue) to any MCP-speaking agent — Claude
 * Code, Codex CLI, etc. — as a set of tools, so an agent can drive a run end to
 * end instead of the operator running the CLI by hand.
 *
 * Deliberately LOCAL-ONLY (stdio transport): the calling agent spawns this
 * process on the operator's own machine, reading the same .env this repo
 * already uses. No network exposure, no auth layer, no shared vendor budget —
 * whoever runs the agent spends their own configured keys. See docs/mcp-connectors.md
 * for how to point Claude Code / Codex at it.
 *
 * A hosted, multi-user version (per-user auth + per-user vendor keys, à la
 * Higgsfield's own remote MCP) is intentionally NOT this file's job — but the
 * actual work (job tracking in ./mcp/jobs.ts, runCycle in ./conductor.ts) is
 * kept transport-agnostic specifically so that a future HTTP server can reuse
 * it verbatim instead of duplicating pipeline logic.
 *
 * Every tool call is independent of every other MCP tool this session may have
 * connected (e.g. the vendor-hosted Higgsfield MCP) — this server only ever
 * calls into this repo's own code.
 */

const server = new McpServer({ name: "vvugc-conductor", version: "0.1.0" });

const VIDEO_VENDOR_ENUM = z.enum([
  "higgsfield",
  "kling",
  "runway",
  "pika",
  "gemini",
  "replicate",
  "seedance",
  "grok_video",
  "wan",
  "alibaba"
]);

server.tool(
  "discover",
  "Find currently-viral videos in a niche on one platform and return each candidate with its metrics " +
    "(views/likes) so an agent can decide what's worth turning into a run. Only youtube_shorts has live " +
    "discovery configured today (tiktok/instagram_reels need approved platform API access — see the repo " +
    "README's Platform support section) and will return an empty list for those.",
  {
    niche: z.string().min(1),
    platform: PlatformSchema.default("youtube_shorts"),
    limit: z.number().int().min(1).max(50).default(10)
  },
  async ({ niche, platform, limit }) => {
    try {
      const candidates = await discoverPlatform(platform, niche, limit);
      return { content: [{ type: "text", text: JSON.stringify({ candidates }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Discovery failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "start_run",
  "Kick off one full VUGC pipeline cycle for a niche: discover -> transcribe -> script rewrite -> " +
    "video-gen -> assembly -> QA -> human review queue. Returns immediately with a runId to poll via " +
    "get_run_status/get_run_result — a live run can take many minutes (real vendor video-gen calls), so " +
    "this tool never blocks waiting for it to finish. THIS SPENDS REAL VENDOR MONEY unless dryRun stays " +
    "true (the default): a live call additionally requires confirmLiveSpend: true or it is refused. Live " +
    "runs are still capped at $25 total spend / 8 distinct source angles by the pipeline itself.",
  {
    niche: z.string().min(1),
    platforms: z.array(PlatformSchema).min(1).default(["youtube_shorts"]),
    duration: z.number().int().min(15).max(60).default(25),
    maxCandidates: z.number().int().min(1).max(50).default(5),
    outputVariants: z.number().int().min(2).max(4).default(2),
    videoVendor: VIDEO_VENDOR_ENUM.default("kling"),
    voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
    dryRun: z.boolean().default(true),
    confirmLiveSpend: z.boolean().default(false)
  },
  async ({ niche, platforms, duration, maxCandidates, outputVariants, videoVendor, voiceVendor, dryRun, confirmLiveSpend }) => {
    if (!dryRun && !confirmLiveSpend) {
      return {
        content: [
          {
            type: "text",
            text:
              "Refusing: dryRun=false requires confirmLiveSpend=true. This would call real, billed vendor " +
              "APIs (an LLM provider for the script, and the chosen videoVendor for clips) up to this run's " +
              "$25 cost cap / 8-angle flow limit. Re-call with confirmLiveSpend: true to actually spend money, " +
              "or leave dryRun: true to exercise the whole pipeline with mocked stages at no cost."
          }
        ],
        isError: true
      };
    }

    const config = parseRunOptions({
      niche,
      platforms,
      brandVoice: "neutral, energetic, concise",
      locale: "en",
      duration,
      maxCandidates,
      outputVariants,
      videoVendor,
      voiceVendor,
      dryRun,
      autoPost: false
    });
    const job = startRunJob(config);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { runId: job.runId, status: job.status, dryRun: job.dryRun, note: "poll get_run_status with this runId" },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "get_run_status",
  "Poll a run started with start_run: its phase (running/completed/failed), the most recent progress " +
    "lines, and its error if it failed.",
  { runId: z.string().min(1) },
  async ({ runId }) => {
    const job = getRunJob(runId);
    if (!job) {
      return { content: [{ type: "text", text: `No such run: ${runId}` }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              runId: job.runId,
              status: job.status,
              dryRun: job.dryRun,
              recentProgress: job.progress.slice(-20),
              error: job.error
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "get_run_result",
  "Get the full manifest (candidates found, review items created, estimated vendor spend) of a run " +
    "started with start_run, once it has finished. Errors if the run is still in progress — poll " +
    "get_run_status first.",
  { runId: z.string().min(1) },
  async ({ runId }) => {
    const job = getRunJob(runId);
    if (!job) {
      return { content: [{ type: "text", text: `No such run: ${runId}` }], isError: true };
    }
    if (job.status === "running") {
      return {
        content: [{ type: "text", text: `Run ${runId} is still running — poll get_run_status first.` }],
        isError: true
      };
    }
    if (job.status === "failed") {
      return { content: [{ type: "text", text: `Run ${runId} failed: ${job.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(job.result, null, 2) }] };
  }
);

server.tool(
  "list_review_queue",
  "List items awaiting human review, optionally filtered by status. Nothing here has been posted " +
    "anywhere yet — this repo doesn't implement platform publishing; approve/reject only changes queue status.",
  { status: z.enum(["pending", "approved", "rejected"]).optional() },
  async ({ status }) => {
    const items = await listReviewItems(status);
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

server.tool(
  "get_review_item",
  "Get one review-queue item by id, including its video path, script, and QA score.",
  { id: z.string().min(1) },
  async ({ id }) => {
    const item = await getReviewItem(id);
    if (!item) {
      return { content: [{ type: "text", text: `No such review item: ${id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
  }
);

server.tool(
  "approve_review_item",
  "Mark a review-queue item approved. Deliberately separate from start_run so a run can never post " +
    "anything by itself — approval is always its own explicit call.",
  { id: z.string().min(1) },
  async ({ id }) => {
    await setReviewItemStatus(id, "approved");
    return { content: [{ type: "text", text: `Approved ${id}` }] };
  }
);

server.tool(
  "reject_review_item",
  "Mark a review-queue item rejected.",
  { id: z.string().min(1) },
  async ({ id }) => {
    await setReviewItemStatus(id, "rejected");
    return { content: [{ type: "text", text: `Rejected ${id}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
