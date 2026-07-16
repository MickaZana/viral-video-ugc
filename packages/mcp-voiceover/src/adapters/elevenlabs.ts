import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import { probeDurationSec } from "../ffprobe.js";
import type { VoiceoverAdapter } from "./VoiceoverAdapter.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// Eleven Multilingual v2's default voice ("Rachel") — a stable, well-known ElevenLabs
// voice ID, not something invented; overridable via ELEVENLABS_VOICE_ID for anyone
// with their own cloned/preferred voice.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * ElevenLabs' text-to-speech endpoint — verified against their current API docs
 * (api-reference/text-to-speech/convert): POST /v1/text-to-speech/{voice_id},
 * auth via the `xi-api-key` header (not Bearer), request body is JSON `{text,
 * model_id}`, response is the raw audio bytes (not JSON-wrapped).
 */
export function createElevenLabsAdapter(): VoiceoverAdapter {
  return {
    vendor: "elevenlabs",
    async synthesize(text: string, outPath: string): Promise<{ filePath: string; durationSec: number }> {
      const apiKey = requireEnvVar("ELEVENLABS_API_KEY");
      const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

      const res = await fetchWithRetry(
        `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
          timeoutMs: 30_000
        }
      );
      if (!res.ok) {
        throw new Error(`ElevenLabs text-to-speech failed: ${res.status} ${await res.text()}`);
      }

      mkdirSync(dirname(outPath), { recursive: true });
      const bytes = await res.arrayBuffer();
      writeFileSync(outPath, Buffer.from(bytes));

      const durationSec = await probeDurationSec(outPath);
      return { filePath: outPath, durationSec };
    }
  };
}
