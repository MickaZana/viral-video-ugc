import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RawClip } from "@vvugc/shared-schema";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/** Writes an empty placeholder file instead of calling any vendor — used for --dry-run. */
export function createMockAdapter(vendor: RawClip["vendor"], outDir: string): VideoGenAdapter {
  return {
    vendor,
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const filePath = `${outDir}/mock-${vendor}-${req.scriptSegmentIndex}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `MOCK CLIP\nprompt: ${req.prompt}\nduration: ${req.durationSec}s\n`);
      return {
        id: `mock-${vendor}-${req.scriptSegmentIndex}`,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor,
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
