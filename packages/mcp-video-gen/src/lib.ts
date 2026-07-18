import { loadEnv } from "@vvugc/shared-config";
import type { RawClip } from "@vvugc/shared-schema";
import type { McpToolCaller, VideoGenAdapter } from "./adapters/VideoGenAdapter.js";
import { createHiggsfieldAdapter } from "./adapters/higgsfield.js";
import { createHiggsfieldRestAdapter } from "./adapters/higgsfield-rest.js";
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
    case "higgsfield": {
      // The standalone REST path (a real, publicly documented API — see
      // higgsfield-rest.ts) works from any process, so it's preferred whenever
      // credentials are configured: it's what makes an unattended run (the CLI,
      // the review-dashboard's "Run now", weekly-run.yml's cron) actually able
      // to use Higgsfield at all, which the MCP-only path structurally can't.
      const { HIGGSFIELD_ACCESS_KEY, HIGGSFIELD_SECRET_KEY } = loadEnv();
      if (HIGGSFIELD_ACCESS_KEY && HIGGSFIELD_SECRET_KEY) {
        return createHiggsfieldRestAdapter(opts.outDir);
      }
      if (opts.callMcpTool) {
        return createHiggsfieldAdapter(opts.callMcpTool, opts.outDir);
      }
      throw new Error(
        "The Higgsfield adapter needs either HIGGSFIELD_ACCESS_KEY/HIGGSFIELD_SECRET_KEY " +
          "(the standalone REST API) or a callMcpTool callback wired to an active HiggsfieldAi " +
          "MCP session — neither is configured. Set the REST credentials, pass callMcpTool in, or use --dry-run."
      );
    }
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
