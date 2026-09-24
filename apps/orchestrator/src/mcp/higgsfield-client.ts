import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolCaller } from "@vvugc/mcp-video-gen";

const DEFAULT_HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const REQUIRED_TOOLS = ["generate_video", "job_status", "media_import_url"] as const;

export interface ConnectedHiggsfieldMcp {
  callMcpTool: McpToolCaller;
  close(): Promise<void>;
}

/**
 * Connects the background orchestrator to Higgsfield's Streamable HTTP MCP.
 * The MCP server uses account OAuth; the caller supplies a short-lived bearer
 * token obtained through that account's authorized MCP session. API key ID /
 * secret pairs are intentionally not treated as MCP credentials.
 *
 * Returns undefined when no MCP token is configured, so the conductor can use
 * its normal vendor fallback chain without delaying or failing other providers.
 */
export async function connectHiggsfieldMcp(
  env: NodeJS.ProcessEnv = process.env
): Promise<ConnectedHiggsfieldMcp | undefined> {
  const accessToken = env.HIGGSFIELD_MCP_ACCESS_TOKEN?.trim();
  if (!accessToken) return undefined;

  const url = env.MCP_SERVER_URL?.trim() || DEFAULT_HIGGSFIELD_MCP_URL;
  const client = new Client({ name: "vvugc-orchestrator", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((tool) => !available.has(tool));
    if (missing.length > 0) {
      throw new Error(`Higgsfield MCP is missing required tools: ${missing.join(", ")}`);
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Unable to initialize Higgsfield MCP: ${safeError(error)}`);
  }

  return {
    async callMcpTool(toolName, args) {
      const result = (await client.callTool({ name: toolName, arguments: args })) as CallToolResult;
      if (result.isError) {
        const details = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        throw new Error(`Higgsfield MCP tool ${toolName} failed${details ? `: ${details}` : ""}`);
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = result.content.find((item) => item.type === "text");
      if (text?.type === "text") {
        try {
          return JSON.parse(text.text) as unknown;
        } catch {
          return { text: text.text };
        }
      }
      return result;
    },
    close: () => client.close()
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
