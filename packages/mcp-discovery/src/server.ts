#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PlatformSchema } from "@vvugc/shared-schema";
import { discoverPlatform } from "./lib.js";

const server = new McpServer({ name: "vvugc-mcp-discovery", version: "0.1.0" });

server.tool(
  "discover_platform",
  "Discover trending/high-engagement videos for a niche on a given platform, via official platform APIs only.",
  {
    platform: PlatformSchema,
    niche: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10)
  },
  async ({ platform, niche, limit }) => {
    const candidates = await discoverPlatform(platform, niche, limit);
    return { content: [{ type: "text", text: JSON.stringify(candidates, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
