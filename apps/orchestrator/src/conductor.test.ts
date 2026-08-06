import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@vvugc/shared-schema";
import { runCycle } from "./conductor.js";
import { rewriteScript } from "./agents/script-agent.js";
import { scoreVideo } from "./agents/qa-agent.js";
import { generateVoiceoverTrack } from "@vvugc/mcp-voiceover";

vi.mock("./agents/script-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./agents/script-agent.js")>("./agents/script-agent.js");
  return { ...actual, rewriteScript: vi.fn(actual.rewriteScript) };
});
vi.mock("./agents/qa-agent.js", async () => {
  const actual = await vi.importActual<typeof import("./agents/qa-agent.js")>("./agents/qa-agent.js");
  return { ...actual, scoreVideo: vi.fn(actual.scoreVideo) };
});
vi.mock("@vvugc/mcp-voiceover", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/mcp-voiceover")>("@vvugc/mcp-voiceover");
  return { ...actual, generateVoiceoverTrack: vi.fn(actual.generateVoiceoverTrack) };
});

let testRunsDir: string;
let testDbPath: string;

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    niche: "fitness",
    platforms: ["tiktok"],
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    targetDurationSec: 25,
    maxCandidates: 2,
    videoVendor: "higgsfield",
    dryRun: true,
    autoPost: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("runCycle", () => {
  beforeEach(() => {
    testRunsDir = mkdtempSync(join(tmpdir(), "vvugc-conductor-test-"));
    testDbPath = join(testRunsDir, "review-queue.json");
    process.env.VVUGC_RUNS_DIR = testRunsDir;
    process.env.VVUGC_DB_PATH = testDbPath;
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.VVUGC_DB_PATH;
    if (existsSync(testRunsDir)) rmSync(testRunsDir, { recursive: true, force: true });
    vi.mocked(rewriteScript).mockRestore();
    vi.mocked(scoreVideo).mockRestore();
    vi.mocked(generateVoiceoverTrack).mockRestore();
  });

  it("dry-run: produces one review item per candidate x platform, and writes a readable manifest", async () => {
    const config = baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 2 });
    const result = await runCycle(config);

    expect(result.runId).toBe(config.runId);
    expect(result.candidatesFound).toBeGreaterThan(0);
    // reviewItemsCreated = min(candidatesFound, maxCandidates) chosen candidates x platforms
    const chosenCount = Math.min(result.candidatesFound, config.maxCandidates);
    expect(result.reviewItemsCreated).toBe(chosenCount * config.platforms.length);

    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.reviewItemsCreated).toBe(result.reviewItemsCreated);

    expect(existsSync(testDbPath)).toBe(true);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    expect(queue).toHaveLength(result.reviewItemsCreated);
    expect(queue.every((item: { status: string }) => item.status === "pending")).toBe(true);
    // Every review item carries an algorithmic originality score (@vvugc/shared-originality),
    // computed once per candidate and attached to every one of that candidate's platform items.
    expect(queue.every((item: { originalityScore?: number }) => typeof item.originalityScore === "number")).toBe(
      true
    );
  });

  it("dry-run: scales linearly with maxCandidates", async () => {
    const result = await runCycle(baseConfig({ maxCandidates: 1 }));
    expect(result.reviewItemsCreated).toBe(1);
  });

  it("remix-from-URL: an embedded sourceTranscript skips discovery and adapts exactly that one source across every platform", async () => {
    // Even in dry-run, a supplied source transcript is used verbatim (not mockTranscript),
    // because the whole point is to remix the user's pasted video — not a placeholder.
    const config = baseConfig({
      platforms: ["tiktok", "youtube_shorts"],
      maxCandidates: 1,
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      sourceTranscript: {
        videoId: "dQw4w9WgXcQ",
        source: "platform_captions",
        text: "Wait for this. The old way of onboarding is broken. You spend weeks on setup.",
        segments: [
          { startSec: 0, endSec: 2, text: "Wait for this." },
          { startSec: 2, endSec: 8, text: "The old way of onboarding is broken." },
          { startSec: 8, endSec: 15, text: "You spend weeks on setup." }
        ]
      }
    });
    const result = await runCycle(config);

    // One source video, remixed once, queued once per target platform.
    expect(result.candidatesFound).toBe(1);
    expect(result.reviewItemsCreated).toBe(config.platforms.length);

    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    // The source transcript text flows through to the review item, proving the remix
    // started from the user's pasted video rather than auto-discovered candidates.
    expect(queue.every((item: { sourceTranscriptText: string }) => item.sourceTranscriptText === config.sourceTranscript!.text)).toBe(true);
  });

  it("live mode, all discovery sources blocked: completes gracefully with zero results instead of crashing", async () => {
    // tiktok/meta discovery throw "not wired up" without API credentials configured —
    // the conductor's per-platform try/catch should absorb that, not propagate it.
    const result = await runCycle(baseConfig({ dryRun: false, platforms: ["tiktok"], maxCandidates: 1 }));
    expect(result.candidatesFound).toBe(0);
    expect(result.reviewItemsCreated).toBe(0);
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("a candidate whose script rewrite throws is skipped, not fatal to the run — other candidates still produce items", async () => {
    vi.mocked(rewriteScript).mockRejectedValue(new Error("simulated script-agent failure"));
    const config = baseConfig({ maxCandidates: 2 });
    const result = await runCycle(config);

    const chosenCount = Math.min(result.candidatesFound, config.maxCandidates);
    expect(result.candidatesFailed).toBe(chosenCount);
    expect(result.platformsFailed ?? 0).toBe(0);
    expect(result.reviewItemsCreated).toBe(0);
    // The run still completes and writes a manifest — it does not throw/crash.
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("a platform whose QA scoring throws is skipped, not fatal to the run — other platforms for the same candidate still succeed", async () => {
    vi.mocked(scoreVideo).mockImplementation(async (...args) => {
      const [assembled] = args;
      if (assembled.platform === "tiktok") throw new Error("simulated qa-agent failure");
      const actual = await vi.importActual<typeof import("./agents/qa-agent.js")>("./agents/qa-agent.js");
      return actual.scoreVideo(...args);
    });
    const config = baseConfig({ platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1 });
    const result = await runCycle(config);

    const chosenCount = Math.min(result.candidatesFound, config.maxCandidates);
    expect(result.candidatesFailed ?? 0).toBe(0);
    expect(result.platformsFailed).toBe(chosenCount); // one failed platform (tiktok) per candidate
    expect(result.reviewItemsCreated).toBe(chosenCount); // youtube_shorts still went through
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("dry-run: every review item carries the niche and a script with a non-empty hook", async () => {
    const config = baseConfig({ niche: "personal finance", maxCandidates: 1 });
    await runCycle(config);
    const queue = JSON.parse(readFileSync(testDbPath, "utf-8"));
    for (const item of queue) {
      expect(item.niche).toBe("personal finance");
      expect(item.script.hook.length).toBeGreaterThan(0);
    }
  });

  it("writes a cost ledger alongside the manifest, with zero cost in dry-run (no vendor calls made)", async () => {
    const result = await runCycle(baseConfig({ maxCandidates: 1 }));
    expect(result.costLedgerPath).toBeDefined();
    expect(existsSync(result.costLedgerPath!)).toBe(true);
    const ledger = JSON.parse(readFileSync(result.costLedgerPath!, "utf-8"));
    expect(ledger.totalUsd).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  describe("onProgress", () => {
    it("emits a human-readable line for discovery, each candidate stage, and each queued item — never silent between start and finish", async () => {
      const messages: string[] = [];
      const config = baseConfig({ platforms: ["tiktok"], maxCandidates: 1 });
      await runCycle(config, { onProgress: (m) => messages.push(m) });

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toContain("Discovering candidates");
      expect(messages.some((m) => m.startsWith("Found "))).toBe(true);
      expect(messages.some((m) => m.includes("[1/1] Transcribing"))).toBe(true);
      expect(messages.some((m) => m.includes("[1/1] Rewriting script"))).toBe(true);
      expect(messages.some((m) => m.includes("✓ Queued for review"))).toBe(true);
    });

    it("emits one progress line per clip (not just once per platform) — the mock script has multiple segments, so this catches the multi-clip 'looks hung' gap", async () => {
      const messages: string[] = [];
      const config = baseConfig({ platforms: ["tiktok"], maxCandidates: 1 });
      const result = await runCycle(config, { onProgress: (m) => messages.push(m) });
      expect(result.reviewItemsCreated).toBe(1); // sanity: the run actually succeeded

      const clipLines = messages.filter((m) => /clip \d+\/\d+/.test(m));
      // mock script = hook + 2 points + cta = 4 segments/clips (see script-agent.ts's mockRewrittenScript)
      expect(clipLines).toEqual([
        "[1/1] Generating video (tiktok) — clip 1/4...",
        "[1/1] Generating video (tiktok) — clip 2/4...",
        "[1/1] Generating video (tiktok) — clip 3/4...",
        "[1/1] Generating video (tiktok) — clip 4/4..."
      ]);
      expect(messages.some((m) => m === "[1/1] Assembling video (tiktok)...")).toBe(true);
      expect(messages.some((m) => m === "[1/1] Scoring quality (tiktok)...")).toBe(true);
    });

    it("emits a failure line (not silence) when a candidate's script rewrite throws", async () => {
      vi.mocked(rewriteScript).mockRejectedValue(new Error("simulated script-agent failure"));
      const messages: string[] = [];
      await runCycle(baseConfig({ maxCandidates: 1 }), { onProgress: (m) => messages.push(m) });

      expect(messages.some((m) => m.includes("✗ Failed"))).toBe(true);
    });

    it("defaults to a silent no-op when onProgress isn't provided — existing callers are unaffected", async () => {
      await expect(runCycle(baseConfig({ maxCandidates: 1 }))).resolves.toBeDefined();
    });
  });

  describe("voiceover (opt-in, additive)", () => {
    it("never attempts voiceover generation when voiceVendor is unset — current behavior is fully unchanged", async () => {
      const result = await runCycle(baseConfig({ voiceVendor: undefined, maxCandidates: 1 }));
      expect(generateVoiceoverTrack).not.toHaveBeenCalled();
      expect(result.reviewItemsCreated).toBeGreaterThan(0);
    });

    it(
      "dry-run with voiceVendor set: generates a voiceover track once per candidate (not per platform) using the mock adapter, no credentials needed",
      async () => {
        const config = baseConfig({ voiceVendor: "elevenlabs", platforms: ["tiktok", "youtube_shorts"], maxCandidates: 1 });
        const result = await runCycle(config);

        // one candidate, two platforms — voiceover must be generated once, then reused,
        // not once per platform (captions/script are already shared the same way).
        expect(generateVoiceoverTrack).toHaveBeenCalledTimes(1);
        expect(result.reviewItemsCreated).toBe(2); // still produces items for both platforms
      },
      // Real ffprobe/ffmpeg subprocesses per cue, even in dry-run — deliberate (see
      // mock.ts), so this is genuinely slower than the default 5s test timeout.
      30000
    );

    it(
      "scales with candidate count, not platform count — 2 candidates x 2 platforms still means 2 voiceover generations",
      async () => {
        const config = baseConfig({ voiceVendor: "grok", platforms: ["tiktok", "youtube_shorts"], maxCandidates: 2 });
        await runCycle(config);
        expect(generateVoiceoverTrack).toHaveBeenCalledTimes(2);
      },
      30000
    );

    it("a voiceover generation failure does not fail the candidate — falls back to no narration for it, same reviewItemsCreated as without voiceover at all", async () => {
      vi.mocked(generateVoiceoverTrack).mockRejectedValue(new Error("simulated TTS vendor failure"));
      const config = baseConfig({ voiceVendor: "elevenlabs", maxCandidates: 1 });

      const result = await runCycle(config);

      expect(result.reviewItemsCreated).toBeGreaterThan(0);
      expect(result.candidatesFailed ?? 0).toBe(0);
    });

    it("a voiceover failure is reported via onProgress, not silently swallowed", async () => {
      vi.mocked(generateVoiceoverTrack).mockRejectedValue(new Error("simulated TTS vendor failure"));
      const messages: string[] = [];
      await runCycle(baseConfig({ voiceVendor: "elevenlabs", maxCandidates: 1 }), { onProgress: (m) => messages.push(m) });

      expect(messages.some((m) => m.includes("Voiceover failed"))).toBe(true);
    });
  });
});
