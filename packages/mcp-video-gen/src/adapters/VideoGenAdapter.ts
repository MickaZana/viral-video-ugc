import type { RawClip } from "@vvugc/shared-schema";

export interface VideoGenRequest {
  scriptSegmentIndex: number;
  prompt: string;
  durationSec: number;
  aspectRatio: "9:16" | "1:1" | "16:9";
  referenceImageUrl?: string;
}

export interface VideoGenAdapter {
  readonly vendor: RawClip["vendor"];
  generate(req: VideoGenRequest): Promise<RawClip>;
}

/**
 * Higgsfield has two reachable paths, both implementing this same interface —
 * see getVideoGenAdapter's selection logic in lib.ts: a standalone REST API
 * (platform.higgsfield.ai — higgsfield-rest.ts, HIGGSFIELD_ACCESS_KEY/
 * HIGGSFIELD_SECRET_KEY, works from any process) and, for a Claude Agent SDK
 * session with the `HiggsfieldAi` MCP server already connected,
 * higgsfield.ts's callMcpTool-based path. The REST path is preferred when
 * configured — the MCP path exists for interactive/agent-driven use where a
 * live MCP session is already present and no separate credentials are set up.
 */
export type McpToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
