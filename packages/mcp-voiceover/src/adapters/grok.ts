import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import { probeDurationSec } from "../ffprobe.js";
import type { VoiceoverAdapter } from "./VoiceoverAdapter.js";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";

// "eve" is xAI's documented default voice for the Grok TTS API (launched March 2026).
const DEFAULT_VOICE_ID = "eve";

/**
 * xAI's Grok Text-to-Speech API — verified against xAI's current docs
 * (developers/model-capabilities/audio/voice): POST /v1/tts, auth via a
 * standard `Authorization: Bearer` header (unlike ElevenLabs' custom header),
 * JSON body `{text, voice_id, language}`, response is raw audio bytes.
 */
export function createGrokAdapter(): VoiceoverAdapter {
  return {
    vendor: "grok",
    async synthesize(text: string, outPath: string): Promise<{ filePath: string; durationSec: number }> {
      const apiKey = requireEnvVar("XAI_API_KEY");
      const voiceId = process.env.GROK_VOICE_ID || DEFAULT_VOICE_ID;

      const res = await fetchWithRetry(XAI_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: voiceId, language: "en" }),
        timeoutMs: 30_000
      });
      if (!res.ok) {
        throw new Error(`Grok text-to-speech failed: ${res.status} ${await res.text()}`);
      }

      mkdirSync(dirname(outPath), { recursive: true });
      const bytes = await res.arrayBuffer();
      writeFileSync(outPath, Buffer.from(bytes));

      const durationSec = await probeDurationSec(outPath);
      return { filePath: outPath, durationSec };
    }
  };
}
