import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { Transcript } from "@vvugc/shared-schema";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

export interface AudioSource {
  videoId: string;
  /** Raw audio bytes already extracted from the source video (e.g. via ffmpeg/yt-dlp upstream). */
  audio: Blob | Buffer;
  filename?: string;
}

interface WhisperVerboseJson {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
}

/**
 * Real OpenAI Whisper transcription call — replaces the previous unconditional
 * `throw` placeholder. Takes already-extracted audio bytes rather than a
 * CandidateVideo/URL directly: this pipeline has no audio-download step yet
 * (yt-dlp or a platform-specific downloader would need to be wired in first
 * for TikTok/Instagram/Facebook candidates), so that boundary stays an
 * explicit, separate gap rather than silently assumed away here.
 */
export async function transcribeWithWhisper(source: AudioSource): Promise<Transcript> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  const form = new FormData();
  const blob = source.audio instanceof Blob ? source.audio : new Blob([new Uint8Array(source.audio)]);
  form.append("file", blob, source.filename ?? `${source.videoId}.mp3`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const res = await fetchWithRetry(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    timeoutMs: 60_000
  });

  if (!res.ok) {
    throw new Error(`Whisper transcription failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as WhisperVerboseJson;

  return {
    videoId: source.videoId,
    source: "whisper",
    text: data.text,
    segments: (data.segments ?? []).map((s) => ({
      startSec: s.start,
      endSec: s.end,
      text: s.text.trim()
    }))
  };
}
