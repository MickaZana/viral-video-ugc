import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar, xaiGrokKeyCandidates } from "@vvugc/shared-config";
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
    async synthesize(text: string, outPath: string, opts): Promise<{ filePath: string; durationSec: number }> {
      // xaiGrokKeyCandidates() trusts this project's .env over an ambient
      // shell key, and lists every other known value after it — if the
      // top candidate turns out to be an unfunded/wrong-team key (403), the
      // loop below retries with the next one instead of failing outright.
      const candidates = xaiGrokKeyCandidates();
      if (candidates.length === 0) requireEnvVar("XAI_API_KEY"); // throws the standard "missing env var" error
      const voiceId = opts?.voiceId || process.env.GROK_VOICE_ID || DEFAULT_VOICE_ID;
      const body = JSON.stringify({ text: [opts?.accent && `Accent: ${opts.accent}`, opts?.speechStyle, text].filter(Boolean).join("\n"), voice_id: voiceId, language: opts?.language || "en" });

      let res: Response | undefined;
      let lastError = "";
      for (const [i, apiKey] of candidates.entries()) {
        res = await fetchWithRetry(XAI_TTS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
          timeoutMs: 30_000
        });
        if (res.ok) break;
        lastError = `${res.status} ${await res.text()}`;
        // Only retry the next candidate on a permission/quota-shaped failure
        // (403) — a genuine bad request or server error would fail the same
        // way on every candidate, so there's no point burning the retry.
        if (res.status !== 403 || i === candidates.length - 1) break;
      }
      if (!res || !res.ok) {
        throw new Error(`Grok text-to-speech failed: ${lastError}`);
      }

      mkdirSync(dirname(outPath), { recursive: true });
      const bytes = await res.arrayBuffer();
      writeFileSync(outPath, Buffer.from(bytes));

      const durationSec = await probeDurationSec(outPath);
      return { filePath: outPath, durationSec };
    }
  };
}
