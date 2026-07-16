#!/usr/bin/env node
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CandidateVideoSchema } from "@vvugc/shared-schema";
import { transcribeCandidate } from "./lib.js";

const server = new McpServer({ name: "vvugc-mcp-transcript", version: "0.1.0" });

server.tool(
  "transcribe_candidate",
  "Transcribe a candidate video's audio/captions into text with timestamped segments.",
  { video: CandidateVideoSchema },
  async ({ video }) => {
    // Standalone MCP invocation has no run directory to scope extracted audio
    // under (unlike conductor.ts, which passes its own runDir/audio) — a
    // per-video OS temp dir is the closest equivalent.
    const transcript = await transcribeCandidate(video, join(tmpdir(), "vvugc-mcp-transcript", video.id));
    return { content: [{ type: "text", text: JSON.stringify(transcript, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
