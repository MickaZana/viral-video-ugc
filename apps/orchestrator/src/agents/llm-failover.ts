import Anthropic from "@anthropic-ai/sdk";
import { xaiGrokKeyCandidates } from "@vvugc/shared-config";
import type { CostLedger } from "@vvugc/shared-cost";

export type LlmProvider = "anthropic" | "gemini" | "grok" | "kimi";

export interface LlmFailoverResult {
  /** Raw text from whichever provider succeeded. The CALLER parses it through its
   *  own zod schema — provider choice never changes the validation contract, which
   *  is exactly what protects against cross-vendor schema drift. */
  text: string;
  provider: LlmProvider;
  model: string;
}

/** A single image to attach as a multimodal content block, base64-encoded (no
 *  data: URI prefix — each provider's own request shape adds that). Used by the
 *  ad-deconstruction agent to send sampled video frames to whichever provider
 *  actually ends up serving the call. */
export interface LlmImageInput {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

export interface LlmFailoverOptions {
  system: string;
  userPrompt: string;
  maxTokens: number;
  /** Anthropic model id (primary when Anthropic key configured). */
  anthropicModel: string;
  /** Gemini model id (secondary / fallback). */
  geminiModel: string;
  /** Grok model id (fallback to Gemini, or main key when Gemini is unfunded/unconfigured). */
  grokModel?: string;
  /** Kimi (Moonshot AI) model id — only consulted when preferredProvider is "kimi". */
  kimiModel?: string;
  /**
   * When set to "kimi", the call tries Kimi FIRST (for its long-horizon agentic reasoning
   * on structured extraction/synthesis tasks) before falling into the exact same
   * anthropic->gemini->grok chain every other caller uses — Kimi never replaces that
   * chain, it only gets first crack when a caller explicitly opts in. Omitted (the
   * default): behavior is byte-identical to before Kimi existed. See generateWithFailover.
   */
  preferredProvider?: "kimi";
  /** Multimodal image content blocks (e.g. sampled video frames), forwarded to whichever
   *  provider serves the call. Anthropic and Gemini both accept images; Grok's default
   *  text-only model does not, so a Grok fallback fails fast with a clear error rather
   *  than silently dropping the images and guessing at an answer. */
  images?: LlmImageInput[];
  /** Cost-ledger stage name (e.g. "script_rewrite"). */
  stage: string;
  costLedger?: CostLedger;
  /** Fires when the call actually falls back to another provider (labeling/surfacing). */
  onFallback?: (provider: LlmProvider, model: string, primaryError: unknown) => void;
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TEXT_MODEL = "gemini-2.5-pro";

const GROK_API_BASE = "https://api.x.ai/v1";
// "grok-2-latest" 400s ("Model not found") on this account's current xAI tier —
// "grok-2" is the verified-working chat model id. Never hardcode a model string
// callers can't override: GROK_MODEL always wins when set, read fresh on every
// call (not cached at module load) so a test or a runtime env change takes
// effect immediately, the same way xaiGrokKeyCandidates() re-reads env each call.
const GROK_TEXT_MODEL = "grok-2";

// Moonshot AI's Kimi — OpenAI-compatible chat completions API at api.moonshot.ai
// (verified against platform.kimi.ai/docs/api/chat and /docs/api/models-overview,
// 2026-08-31 — the same docs Moonshot moved from platform.moonshot.ai to). Distinct
// from Grok's role in this chain ("the resilient fallback when Gemini is unfunded"):
// Kimi is opted into deliberately by a specific caller (see preferredProvider) for its
// long-horizon agentic reasoning on structured extraction/synthesis tasks, not as a
// generic third-string fallback for everyone.
const KIMI_API_BASE = "https://api.moonshot.ai/v1";
// kimi-k3 is Moonshot's current flagship reasoning model (1M-token context,
// reasoning_effort control) per the docs above — migration guidance there
// consistently recommends it over the older k2.x line. NOT live-verified: no
// MOONSHOT_API_KEY/KIMI_API_KEY exists in this repo's .env, so this default is
// doc-sourced only. KIMI_MODEL overrides it the same way GROK_MODEL does.
const KIMI_TEXT_MODEL = "kimi-k3";

/** Resolves the Grok chat model: an explicit caller value wins, then
 *  GROK_MODEL, then the verified-working default. Centralized so every
 *  call site (here and the three agents) can be overridden the same way. */
function resolveGrokModel(explicit?: string): string {
  return explicit || process.env.GROK_MODEL || GROK_TEXT_MODEL;
}

/** Resolves the Kimi chat model: an explicit caller value wins, then
 *  KIMI_MODEL, then the doc-sourced default. Mirrors resolveGrokModel exactly. */
function resolveKimiModel(explicit?: string): string {
  return explicit || process.env.KIMI_MODEL || KIMI_TEXT_MODEL;
}

/** MOONSHOT_API_KEY is Moonshot's own name for the credential; KIMI_API_KEY is
 *  accepted as an alias for consistency with this repo's GROK_API_KEY/XAI_API_KEY
 *  alias pattern. Unlike xaiGrokKeyCandidates(), there's no known "unfunded team"
 *  failure mode for Kimi to harden against yet, so this stays a simple lookup —
 *  add multi-candidate retry here if that changes, matching callGrok's pattern. */
function resolveKimiApiKey(): string | undefined {
  return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
}

/** Classify whether an Anthropic error is a "hard" provider failure (fall back to
 *  Gemini / Grok) vs a local/config problem that must surface as-is.
 *
 *  Fails over ONLY on real provider-outage conditions (the SDK's connection/timeout/
 *  generic-API/rate-limit/5xx errors). Never fails over on:
 *    - config errors (AuthenticationError / PermissionDeniedError) — a misconfiguration
 *      would otherwise silently route the whole pipeline onto a fallback provider and
 *      hide a deployment error;
 *    - our own response-shape errors (e.g. "no text block", thrown as a plain `Error`)
 *      — an unexpected-but-received response is a data problem, not an outage. */
function isHardAnthropicFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  // Plain `Error`s are thrown by our own code (response-shape problems) — surface.
  if (name === "Error" || name === "TypeError") return false;
  // Config/auth problems on Anthropic — surface loudly when key was configured.
  if (name === "AuthenticationError" || name === "PermissionDeniedError") return false;
  // Everything else the Anthropic SDK raises after its internal retries is a genuine
  // provider failure (connection, timeout, 5xx, 429) — fail over.
  return true;
}

function recordKimiUsage(
  costLedger: CostLedger | undefined,
  stage: string,
  usage: { input_tokens: number; output_tokens: number },
  model: string
): void {
  costLedger?.recordKimiUsage(stage, usage, model);
}

async function callAnthropic(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required env var "ANTHROPIC_API_KEY"');
  }
  const client = new Anthropic({
    apiKey,
    // H-5 FIX: Explicit timeout (90s) prevents the default 10-minute hang
    timeout: 90_000,
    maxRetries: 2,
  });
  // Plain string content when there are no images — byte-identical to the pre-multimodal
  // request shape. Images (when present) become content blocks preceding the text block,
  // per @anthropic-ai/sdk's real ImageBlockParam/Base64ImageSource types (verified against
  // the installed SDK's messages.d.ts, not guessed): { type: "image", source: { type:
  // "base64", media_type, data } }.
  const content: Anthropic.MessageParam["content"] = opts.images?.length
    ? [
        ...opts.images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 }
        })),
        { type: "text" as const, text: opts.userPrompt }
      ]
    : opts.userPrompt;
  const message = await client.messages.create({
    model: opts.anthropicModel,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content }]
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("LLM response contained no text block");
  }
  opts.costLedger?.recordAnthropicUsage(opts.stage, message.usage, opts.anthropicModel);
  return { text: textBlock.text, provider: "anthropic", model: opts.anthropicModel };
}

async function callGemini(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required env var "GEMINI_API_KEY"');
  }
  // Native fetch with a hard timeout — inline timeout is enough; we deliberately avoid
  // pulling a shared-http dep into the orchestrator just for fallback calls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    // Gemini's generateContent takes images as inline_data parts ahead of the text part —
    // well-documented, standard Gemini multimodal shape. Omitted entirely when there are
    // no images, so the request body is byte-identical to the pre-multimodal shape.
    const imageParts = (opts.images ?? []).map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 }
    }));
    const res = await fetch(
      `${GEMINI_API_BASE}/models/${opts.geminiModel}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [...imageParts, { text: `${opts.system}\n\n${opts.userPrompt}` }] }
          ],
          generationConfig: { maxOutputTokens: opts.maxTokens }
        }),
        signal: controller.signal
      }
    );
    if (!res.ok) {
      throw new Error(`Gemini text generation failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini text generation returned no text");
    opts.costLedger?.recordGeminiUsage(opts.stage, {
      input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0
    }, opts.geminiModel);
    return { text, provider: "gemini", model: opts.geminiModel };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Gemini text generation timed out after 60s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGrok(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  // The default Grok text model (grok-2) has no vision support — fail fast and honestly
  // rather than silently dropping the images and returning a guess with no basis in them.
  if (opts.images?.length) {
    throw new Error(
      "Grok text generation does not support multimodal (image) requests with the current text-only default model"
    );
  }
  // xaiGrokKeyCandidates() trusts this project's .env over an ambient shell
  // key, then lists every other known value — if the top candidate is an
  // unfunded/wrong-team key (403), the loop below retries the next one
  // instead of failing the whole failover chain outright.
  const candidates = xaiGrokKeyCandidates();
  if (candidates.length === 0) {
    throw new Error('Missing required env var "GROK_API_KEY" or "XAI_API_KEY"');
  }
  const grokModel = resolveGrokModel(opts.grokModel);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    let res: Response | undefined;
    let lastError = "";
    for (const [i, apiKey] of candidates.entries()) {
      res = await fetch(`${GROK_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: grokModel,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.userPrompt }
          ],
          max_tokens: opts.maxTokens
        }),
        signal: controller.signal
      });
      if (res.ok) break;
      lastError = `${res.status} ${await res.text()}`;
      // Only retry the next candidate on a permission/quota-shaped failure
      // (403) — a genuine bad request or server error fails identically on
      // every candidate, so there's no point burning the retry on those.
      if (res.status !== 403 || i === candidates.length - 1) break;
    }
    if (!res || !res.ok) {
      throw new Error(`Grok text generation failed: ${lastError}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("Grok text generation returned no text");
    opts.costLedger?.recordGrokUsage(
      opts.stage,
      {
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0
      },
      grokModel
    );
    return { text, provider: "grok", model: grokModel };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Grok text generation timed out after 60s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Kimi (Moonshot AI) — OpenAI-compatible chat completions, same request/response shape
 *  as callGrok (model/messages/max_tokens in, choices[0].message.content +
 *  usage.prompt_tokens/completion_tokens out). Text-only for now: the callers that opt
 *  into preferredProvider: "kimi" (ad-storyboard-agent) work on already-extracted text,
 *  not images, so multimodal support isn't added here — see callAnthropic/callGemini for
 *  the deconstruction agent's image path instead. */
async function callKimi(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = resolveKimiApiKey();
  if (!apiKey) {
    throw new Error('Missing required env var "MOONSHOT_API_KEY" or "KIMI_API_KEY"');
  }
  const kimiModel = resolveKimiModel(opts.kimiModel);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${KIMI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: kimiModel,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.userPrompt }
        ],
        max_tokens: opts.maxTokens
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Kimi text generation failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("Kimi text generation returned no text");
    recordKimiUsage(
      opts.costLedger,
      opts.stage,
      {
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0
      },
      kimiModel
    );
    return { text, provider: "kimi", model: kimiModel };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Kimi text generation timed out after 60s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute text generation with the multi-provider failover chain:
 * 0. Kimi, ONLY when the caller explicitly sets preferredProvider: "kimi" (e.g.
 *    ad-storyboard-agent) — any Kimi failure (including "not configured") falls through
 *    to step 1 exactly as if Kimi had never been tried; it never blocks or replaces the
 *    standard chain below, which every other caller still runs unchanged.
 * 1. Anthropic (primary if ANTHROPIC_API_KEY configured)
 * 2. Gemini (fallback or secondary key; or primary if Anthropic unconfigured)
 * 3. Grok (fallback to Gemini, and becomes the main key if Gemini is unfunded or unconfigured)
 */
export async function generateWithFailover(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  if (opts.preferredProvider === "kimi" && resolveKimiApiKey()) {
    try {
      return await callKimi(opts);
    } catch {
      // Fall through into the unchanged standard chain below — Kimi is a "try first"
      // opt-in, never a hard dependency. No onFallback here: onFallback labels
      // fallbacks WITHIN the standard chain (its existing contract for the 3 other
      // callers); the chain below fires its own onFallback calls as usual from here.
    }
  }

  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasGrok = xaiGrokKeyCandidates().length > 0;

  if (!hasAnthropic && !hasGemini && !hasGrok) {
    throw new Error(
      'No LLM provider key configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROK_API_KEY/XAI_API_KEY in .env.'
    );
  }

  // 1. If Anthropic is configured, try it first
  if (hasAnthropic) {
    try {
      return await callAnthropic(opts);
    } catch (err) {
      if (!isHardAnthropicFailure(err)) throw err;

      // Failover from Anthropic to Gemini or Grok
      if (hasGemini) {
        try {
          opts.onFallback?.("gemini", opts.geminiModel, err);
          return await callGemini(opts);
        } catch (geminiErr) {
          if (hasGrok) {
            const grokModel = resolveGrokModel(opts.grokModel);
            opts.onFallback?.("grok", grokModel, geminiErr);
            return await callGrok(opts);
          }
          throw geminiErr;
        }
      } else if (hasGrok) {
        const grokModel = resolveGrokModel(opts.grokModel);
        opts.onFallback?.("grok", grokModel, err);
        return await callGrok(opts);
      }
      throw err;
    }
  }

  // 2. If Anthropic is not configured, try Gemini next
  if (hasGemini) {
    try {
      return await callGemini(opts);
    } catch (geminiErr) {
      // If Gemini is unfunded, returns error, or fails -> Grok becomes the main key
      if (hasGrok) {
        const grokModel = resolveGrokModel(opts.grokModel);
        opts.onFallback?.("grok", grokModel, geminiErr);
        return await callGrok(opts);
      }
      throw geminiErr;
    }
  }

  // 3. If Gemini is not configured / not funded, Grok is the main key
  return await callGrok(opts);
}

export { GEMINI_TEXT_MODEL, GROK_TEXT_MODEL, KIMI_TEXT_MODEL };
