import type { RawClip } from "@vvugc/shared-schema";
import type { McpToolCaller, VideoGenAdapter } from "./adapters/VideoGenAdapter.js";
import { createHiggsfieldAdapter } from "./adapters/higgsfield.js";
import { createKlingAdapter } from "./adapters/kling.js";
import { createRunwayAdapter } from "./adapters/runway.js";
import { createPikaAdapter } from "./adapters/pika.js";
import { createGeminiAdapter } from "./adapters/gemini.js";
import { createMockAdapter } from "./adapters/mock.js";

export type { VideoGenAdapter, VideoGenRequest, McpToolCaller } from "./adapters/VideoGenAdapter.js";

export function getVideoGenAdapter(
  vendor: RawClip["vendor"],
  opts: { outDir: string; dryRun: boolean; callMcpTool?: McpToolCaller }
): VideoGenAdapter {
  if (opts.dryRun) return createMockAdapter(vendor, opts.outDir);

  switch (vendor) {
    case "higgsfield":
      if (!opts.callMcpTool) {
        throw new Error(
          "The Higgsfield adapter requires a callMcpTool callback wired to the conductor's connected " +
            "HiggsfieldAi MCP server — pass one in, or use --dry-run."
        );
      }
      return createHiggsfieldAdapter(opts.callMcpTool, opts.outDir);
    case "kling":
      return createKlingAdapter(opts.outDir);
    case "runway":
      return createRunwayAdapter(opts.outDir);
    case "pika":
      return createPikaAdapter(opts.outDir);
    case "gemini":
      return createGeminiAdapter(opts.outDir);
  }
}
