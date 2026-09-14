import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeDurationSec } from "./ffprobe.js";
import { writeSilentWav } from "./silent-wav.js";

// Real ffprobe binary (ffprobe-static), real WAV bytes (writeSilentWav) — no
// mocking. This is the one file in the package that had zero coverage; the
// point of testing it is confirming the real resolveFfprobePath()/setFfprobePath()
// wiring actually works end to end on whatever machine runs the suite, not just
// that a mocked callback fires.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vvugc-ffprobe-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("probeDurationSec", () => {
  it("reports the real duration of a WAV file it didn't generate itself", async () => {
    const filePath = join(dir, "two-seconds.wav");
    writeSilentWav(filePath, 2);

    const duration = await probeDurationSec(filePath);

    // PCM WAV duration is exact from the header (sample count / sample rate) —
    // ffprobe should read it back essentially exactly, not just "close enough".
    expect(duration).toBeCloseTo(2, 1);
  });

  it("reports a different duration for a differently-sized file, not a constant", async () => {
    const short = join(dir, "short.wav");
    const long = join(dir, "long.wav");
    writeSilentWav(short, 1);
    writeSilentWav(long, 5);

    const [shortDuration, longDuration] = await Promise.all([probeDurationSec(short), probeDurationSec(long)]);

    expect(shortDuration).toBeCloseTo(1, 1);
    expect(longDuration).toBeCloseTo(5, 1);
  });

  it("rejects for a file that doesn't exist", async () => {
    await expect(probeDurationSec(join(dir, "nope.wav"))).rejects.toThrow();
  });

  it("rejects for a file that isn't a real media file", async () => {
    const filePath = join(dir, "not-media.wav");
    writeFileSync(filePath, "this is plain text, not a WAV file");

    await expect(probeDurationSec(filePath)).rejects.toThrow();
  });
});
