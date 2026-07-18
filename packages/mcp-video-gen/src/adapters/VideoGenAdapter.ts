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
 * Higgsfield's tools are only reachable through the MCP connection a Claude
 * Agent SDK session already has (this environment's `HiggsfieldAi` MCP
 * server) — there is no separate public REST API for a standalone Node
 * process to call directly. Adapters for MCP-only vendors take a
 * `callMcpTool` callback the conductor supplies at runtime, rather than
 * making their own HTTP calls, so the same VideoGenAdapter interface covers
 * both "direct REST vendor" (Kling, Runway, Pika) and "MCP-only vendor"
 * (Higgsfield) cases.
 */
export type McpToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
