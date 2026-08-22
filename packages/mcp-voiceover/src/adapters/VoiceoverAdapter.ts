export type VoiceoverVendor = "elevenlabs" | "grok" | "mock";

export interface VoiceoverAdapter {
  readonly vendor: VoiceoverVendor;
  /**
   * Synthesizes `text` as speech and writes it to `outPath`. Returns the actual
   * duration of what was synthesized — TTS engines don't take a target duration,
   * they speak at their own natural pace, so the caller (audio-sync.ts) is
   * responsible for conforming this to whatever time window it needs to fill
   * (e.g. a caption cue's exact start/end).
   */
  synthesize(text: string, outPath: string, opts?: { voiceId?: string; language?: string; accent?: string; speechStyle?: string }): Promise<{ filePath: string; durationSec: number }>;
}
