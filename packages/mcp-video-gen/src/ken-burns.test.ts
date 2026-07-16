import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeDurationSec, stillImageToClip } from "./ken-burns.js";
import { makeTestImage } from "./test-fixtures.js";

describe("stillImageToClip (real ffmpeg)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("renders a still image into a clip matching the requested duration and dimensions", async () => {
    dir = mkdtempSync(join(tmpdir(), "ken-burns-"));
    const stillPath = makeTestImage(join(dir, "still.png"));
    const outPath = join(dir, "clip.mp4");

    await stillImageToClip(stillPath, 2, { w: 160, h: 284 }, outPath);

    const duration = await probeDurationSec(outPath);
    expect(duration).toBeGreaterThan(1.5);
    expect(duration).toBeLessThan(2.5);
  }, 30_000);
});
