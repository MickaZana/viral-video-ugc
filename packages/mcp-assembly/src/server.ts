#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptionCueSchema, PlatformSchema, RawClipSchema, RewrittenScriptSchema } from "@vvugc/shared-schema";
import { assembleVideo } from "./lib.js";

const server = new McpServer({ name: "vvugc-mcp-assembly", version: "0.1.0" });

server.tool(
  "assemble_video",
  "Stitch generated clips into a final platform-ready video with burned-in captions (caption cues supplied by the caller — this tool only serializes/burns them), aspect ratio, and hashtags.",
  {
    clips: z.array(RawClipSchema),
    script: RewrittenScriptSchema,
    captions: z.array(CaptionCueSchema),
    platform: PlatformSchema,
    outDir: z.string()
  },
  async ({ clips, script, captions, platform, outDir }) => {
    const assembled = await assembleVideo({ clips, script, captions, platform, outDir });
    return { content: [{ type: "text", text: JSON.stringify(assembled, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
