import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import { xaiGrokKeyCandidates } from "@vvugc/shared-config";
import type { CostLedger } from "@vvugc/shared-cost";

// Every failed attempt is logged here (provider/model/error class/classification)
// because callers like script/qa/caption agents don't pass onFallback — without a
// logger, a mid-chain failure was completely untraceable (audit F10).
const logger = pino({ name: "vvugc-llm-failover" });

export type LlmProvider = "anthropic" | "openai" | "gemini" | "grok" | "kimi";

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
  /** Gemini model id (secondary / fallback). Optional — an explicit caller value wins,
   *  then GEMINI_MODEL, then the verified-working default (see resolveGeminiModel). */
  geminiModel?: string;
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
  /**
   * Total wall-clock budget for the WHOLE failover chain, checked between
   * attempts (audit F10 — before this, the chain's worst case was the bare sum
   * of every provider's per-attempt timeout with no ceiling, ~8+ minutes).
   * Each attempt is still individually bounded by its own timeout (60s for the
   * fetch-based providers, 90s × up to 3 tries for the Anthropic SDK), so the
   * true hard ceiling is maxTotalMs + one final attempt. Defaults to
   * DEFAULT_MAX_TOTAL_MS.
   */
  maxTotalMs?: number;
}

/** Default total wall-clock budget for one generateWithFailover call (5 minutes).
 *  Sized to comfortably fit a normal single-provider success plus a full
 *  Anthropic SDK worst case (90s × 3 attempts + backoff ≈ 286s) before the
 *  fallback chain gives up with an aggregated error. */
export const DEFAULT_MAX_TOTAL_MS = 300_000;

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_TEXT_MODEL = "gpt-4.1-mini";
// "gemini-2.5-pro" is dead (404 "no longer available to new users", verified live
// 2026-08-31). Google's own error names "gemini-3.1-pro-preview" as the direct
// replacement, but that id currently returns 429 (quota exceeded) on this
// project's Gemini key specifically — an account/billing-quota condition, not a
// wrong-model-id problem, and Gemini is a FALLBACK provider here: a 429 on this
// default just makes generateWithFailover advance to Grok, exactly as designed
// (see the chain doc-comment below), so this default stays the *correct* current
// id rather than a lower tier picked around one account's quota. GEMINI_MODEL
// overrides this the same way GROK_MODEL/KIMI_MODEL do, so ops can point at
// "gemini-3.6-flash" (verified genuinely working end-to-end, 2026-08-31) or any
// other id without a code change if the quota issue persists.
const GEMINI_TEXT_MODEL = "gemini-3.1-pro-preview";

const GROK_API_BASE = "https://api.x.ai/v1";
// xAI's catalog has moved on again since this default was last fixed: "grok-2"
// (and "grok-2-latest"/"grok-3") no longer exist at all (400 "Model not found",
// verified live 2026-08-31 via GET /v1/models) — the current lineup is
// grok-4.3/4.5/4.6/4.20-*. "grok-4.3" is the verified-working, currently-priced
// chat model id (see shared-cost's GROK_RATE_TABLE). Never hardcode a model
// string callers can't override: GROK_MODEL always wins when set, read fresh on
// every call (not cached at module load) so a test or a runtime env change takes
// effect immediately, the same way xaiGrokKeyCandidates() re-reads env each call.
const GROK_TEXT_MODEL = "grok-4.3";

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

/** Resolves the Gemini chat model: an explicit caller value wins, then
 *  GEMINI_MODEL, then the current default. Mirrors resolveGrokModel exactly —
 *  added alongside the grok-4.3/gemini-3.1-pro-preview fix so Gemini has the
 *  same env-override escape hatch Grok and Kimi already had, since we've now
 *  seen this exact "vendor moved the model catalog on" failure mode recur
 *  more than once in one session. */
function resolveGeminiModel(explicit?: string): string {
  return explicit || process.env.GEMINI_MODEL || GEMINI_TEXT_MODEL;
}

function resolveOpenAIModel(): string {
  return process.env.OPENAI_MODEL || OPENAI_TEXT_MODEL;
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

/** How a failed provider attempt must be handled by the failover chain. */
export type LlmErrorClassification = "retryable" | "non-retryable";

/** One failed provider attempt. Kept for every attempt so the final thrown error
 *  can show the WHOLE chain of failures instead of only whichever provider
 *  happened to be last (audit F10). */
export interface LlmFailoverAttemptRecord {
  provider: LlmProvider;
  model: string;
  errorName: string;
  message: string;
  classification: LlmErrorClassification;
}

export type LlmFailoverErrorReason = "non-retryable" | "exhausted" | "deadline";

/** Thrown instead of a bare last-provider error whenever the failover chain
 *  aborts: on a non-retryable error (fail fast), when every provider has been
 *  tried (exhausted), or when the total wall-clock budget is gone (deadline).
 *  `.message` embeds every attempt's provider/model/error-class/error-message,
 *  so existing `rejects.toThrow(/.../)` matchers against original provider error
 *  text (e.g. "no text block", "does not support multimodal") keep matching. */
export class LlmFailoverError extends Error {
  readonly reason: LlmFailoverErrorReason;
  readonly attempts: readonly LlmFailoverAttemptRecord[];
  constructor(reason: LlmFailoverErrorReason, attempts: readonly LlmFailoverAttemptRecord[], cause?: unknown) {
    super(formatFailoverError(reason, attempts), cause !== undefined ? { cause } : undefined);
    this.name = "LlmFailoverError";
    this.reason = reason;
    this.attempts = attempts;
  }
}

function formatFailoverError(reason: LlmFailoverErrorReason, attempts: readonly LlmFailoverAttemptRecord[]): string {
  const head =
    reason === "deadline"
      ? "LLM failover aborted: total wall-clock deadline exceeded"
      : reason === "non-retryable"
        ? "LLM failover aborted on a non-retryable error"
        : "LLM failover exhausted all configured providers";
  if (attempts.length === 0) return `${head} (before any provider attempt)`;
  const detail = attempts
    .map((a, i) => `attempt ${i + 1} ${a.provider}/${a.model} [${a.errorName}]: ${a.message}`)
    .join(" | ");
  return `${head} — ${detail}`;
}

/** HTTP status an attempt failed with, if the error carries one: the Anthropic
 *  SDK puts it on APIError.status; our fetch-based wrappers embed it in
 *  "<Provider> text generation failed: <status> <body>". */
function httpStatusOf(err: Error): number | undefined {
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  const match = /failed:\s*(\d{3})\b/.exec(err.message);
  return match ? Number(match[1]) : undefined;
}

/** Single error-classification policy for the WHOLE chain (audit F10).
 *
 *  retryable (fail over to the next provider):
 *    - transient availability: timeouts, network/connection failures, 429, 408/409, 5xx;
 *    - account availability: Anthropic's explicit prepaid-credit exhaustion (a 400),
 *      402/payment-required, and any quota/billing wording — routing an unfunded
 *      account onto the next provider is what the chain exists for (test-backed:
 *      Anthropic credit -> OpenAI, Gemini 402/403-quota -> Grok);
 *    - 404 / NotFoundError: model-catalog rot is provider-specific (grok-2 and
 *      gemini-2.5-pro both died this way) — the next provider has its own model id;
 *    - unknown/unclassifiable shapes (chain resilience, the pre-F10 default).
 *
 *  non-retryable (abort the chain immediately with an aggregated LlmFailoverError):
 *    - auth/misconfiguration: AuthenticationError, PermissionDeniedError, 401, 403
 *      (without quota/billing wording) — a deployment error must surface loudly,
 *      not silently reroute the whole pipeline onto fallback providers;
 *    - invalid-request: BadRequestError, 400 (non-billing), 422 — the same request
 *      will fail identically everywhere, so burning the remaining providers' latency
 *      and budget buys nothing (this was the core F10 waste);
 *    - our own response-shape/capability/missing-env guards (plain `Error`s thrown
 *      by this module, e.g. "no text block", "does not support multimodal"). */
function classifyLlmError(err: unknown): LlmErrorClassification {
  if (!(err instanceof Error)) return "non-retryable";
  const name = err.name;
  const msg = err.message;
  const status = httpStatusOf(err);

  // Unambiguous transport-layer class names (these carry no HTTP status).
  if (name === "AbortError" || name === "APIConnectionTimeoutError" || name === "APITimeoutError") return "retryable";
  if (name === "APIConnectionError") return "retryable";

  // Account-availability exceptions — checked BEFORE any status-based fail-fast
  // rule, because exhausted prepaid credits arrive as a 400 and unfunded Gemini
  // accounts as 402/403, and both MUST route to the next provider (test-backed).
  if (/credit balance is too low|insufficient credits/i.test(msg)) return "retryable";
  if (/\b402\b|quota|billing|payment required/i.test(msg)) return "retryable";

  // Status-based policy: when a status is known it wins over message heuristics.
  if (status !== undefined) {
    if (status === 402 || status === 429 || status === 408 || status === 409) return "retryable";
    if (status >= 500) return "retryable";
    if (status === 404) return "retryable";
    if (status === 401 || status === 403 || status === 400 || status === 422) return "non-retryable";
    // Any other unexpected status falls through to name/message heuristics.
  }

  // Name-based policy for status-less errors (Anthropic SDK class names).
  if (name === "NotFoundError") return "retryable";
  if (name === "RateLimitError" || name === "APIError" || name === "APIStatusError" || name === "InternalServerError" || name === "OverloadedError") return "retryable";
  if (name === "AuthenticationError" || name === "PermissionDeniedError" || name === "BadRequestError") return "non-retryable";

  // Message heuristics for our own status-less wrappers ("... timed out after 60s")
  // and raw network throws (undici's "fetch failed", ECONNRESET, ...). Must run
  // BEFORE the plain-`Error` rule below, since our timeout wrappers ARE plain Errors.
  if (/\btimed out\b|\btimeout\b/i.test(msg)) return "retryable";
  if (/\bfetch failed\b|network|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "retryable";

  // Plain `Error`s / TypeErrors are thrown by OUR code (response-shape, capability,
  // missing-env guards) — data/config problems, not outages.
  if (name === "Error" || name === "TypeError") return "non-retryable";

  return "retryable";
}

/** Anthropic-gate predicate (name kept — long-form-production.ts's doc comment
 *  references it): true = provider-availability condition, fail over to the next
 *  provider; false = surface without trying fallbacks. Thin wrapper over the
 *  shared classifier so every provider in the chain applies ONE policy. */
function isHardAnthropicFailure(err: unknown): boolean {
  return classifyLlmError(err) === "retryable";
}

async function callOpenAI(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing required env var "OPENAI_API_KEY"');
  const model = resolveOpenAIModel();
  const userContent = opts.images?.length
    ? [
        ...opts.images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` }
        })),
        { type: "text", text: opts.userPrompt }
      ]
    : opts.userPrompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: userContent }
        ],
        max_tokens: opts.maxTokens
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`OpenAI text generation failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : content?.map((part) => part.text ?? "").join("");
    // Record BEFORE the empty-text guard: if the request resolved, the tokens
    // were consumed, and every attempt that produced usage must land on the
    // ledger with its own model string (AGENTS.md / audit F10) even when the
    // payload turns out to be unusable.
    opts.costLedger?.recordOpenAIUsage(opts.stage, {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0
    }, model);
    if (!text) throw new Error("OpenAI text generation returned no text");
    return { text, provider: "openai", model };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("OpenAI text generation timed out after 60s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  // AGENTS.md rule, applied literally: record usage with this call's model string
  // RIGHT AFTER messages.create resolves — before any response-shape validation can
  // skip it (audit F10: a no-text-block response consumed tokens and used to record
  // nothing).
  opts.costLedger?.recordAnthropicUsage(opts.stage, message.usage, opts.anthropicModel);
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("LLM response contained no text block");
  }
  return { text: textBlock.text, provider: "anthropic", model: opts.anthropicModel };
}

async function callGemini(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required env var "GEMINI_API_KEY"');
  }
  // Native fetch with a hard timeout — inline timeout is enough; we deliberately avoid
  // pulling a shared-http dep into the orchestrator just for fallback calls.
  const geminiModel = resolveGeminiModel(opts.geminiModel);
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
      `${GEMINI_API_BASE}/models/${geminiModel}:generateContent`,
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
    // Record before the empty-text guard — consumed tokens always hit the ledger
    // with this attempt's own model string (audit F10).
    opts.costLedger?.recordGeminiUsage(opts.stage, {
      input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0
    }, geminiModel);
    if (!text) throw new Error("Gemini text generation returned no text");
    return { text, provider: "gemini", model: geminiModel };
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
    // Record before the empty-text guard — consumed tokens always hit the ledger
    // with this attempt's own model string (audit F10).
    opts.costLedger?.recordGrokUsage(
      opts.stage,
      {
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0
      },
      grokModel
    );
    if (!text) throw new Error("Grok text generation returned no text");
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
    // Record before the empty-text guard — consumed tokens always hit the ledger
    // with this attempt's own model string (audit F10).
    recordKimiUsage(
      opts.costLedger,
      opts.stage,
      {
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0
      },
      kimiModel
    );
    if (!text) throw new Error("Kimi text generation returned no text");
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
 *    ad-storyboard-agent) — any Kimi failure (including "not configured" and
 *    non-retryable classes) falls through to step 1 exactly as if Kimi had never
 *    been tried; it never blocks or replaces the standard chain below. Unlike
 *    before, the failure is now recorded + logged instead of silently swallowed.
 * 1. Anthropic (primary if ANTHROPIC_API_KEY configured)
 * 2. OpenAI (fallback or primary if Anthropic is unfunded/unconfigured)
 * 3. Gemini, then Grok (remaining fallbacks)
 *
 * Failover policy (audit F10):
 * - Every provider is attempted AT MOST ONCE (attempt count is bounded by this
 *   fixed chain; the Anthropic SDK's own internal retries — exponential backoff
 *   + jitter, maxRetries 2 — stay within its single slot).
 * - Each attempt is individually timed out (60s fetch providers / 90s Anthropic
 *   SDK) and the whole chain is bounded by opts.maxTotalMs (default
 *   DEFAULT_MAX_TOTAL_MS), checked before every attempt.
 * - Errors are classified retryable (timeout/429/5xx/network + account-availability
 *   billing/quota) vs non-retryable (auth 401/403, invalid-request 400/422, our own
 *   response-shape/capability guards). Non-retryable aborts the chain immediately.
 * - Every failed attempt is logged (provider/model/error class/classification) and
 *   recorded, so the final thrown LlmFailoverError aggregates the full attempt
 *   history instead of surfacing only the last provider's error.
 */
export async function generateWithFailover(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const startedAt = Date.now();
  const maxTotalMs = opts.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const attempts: LlmFailoverAttemptRecord[] = [];
  let lastError: unknown = undefined;

  const recordFailure = (provider: LlmProvider, model: string, err: unknown): LlmErrorClassification => {
    const classification = classifyLlmError(err);
    const errorName = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    attempts.push({ provider, model, errorName, message, classification });
    lastError = err;
    logger.warn(
      { stage: opts.stage, provider, model, attempt: attempts.length, errorName, classification, err: message },
      "LLM provider attempt failed"
    );
    return classification;
  };

  const ensureDeadline = (): void => {
    if (Date.now() - startedAt >= maxTotalMs) {
      logger.error({ stage: opts.stage, maxTotalMs, attempts: attempts.length }, "LLM failover deadline exceeded");
      throw new LlmFailoverError("deadline", attempts);
    }
  };

  const abort = (reason: LlmFailoverErrorReason, cause?: unknown): LlmFailoverError => {
    logger.error({ stage: opts.stage, reason, attempts }, "LLM failover aborted");
    return new LlmFailoverError(reason, attempts, cause);
  };

  // Preferred-provider probe (Kimi): try-first opt-in with UNCONDITIONAL
  // fall-through — a Kimi failure of ANY class still enters the standard chain
  // below (pre-existing contract: "as if Kimi had never been tried"); the F10 fix
  // is that it's now recorded + logged rather than swallowed by a bare catch.
  if (opts.preferredProvider === "kimi" && resolveKimiApiKey()) {
    ensureDeadline();
    try {
      return await callKimi(opts);
    } catch (err) {
      recordFailure("kimi", resolveKimiModel(opts.kimiModel), err);
    }
  }

  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasGrok = xaiGrokKeyCandidates().length > 0;

  if (!hasAnthropic && !hasOpenAI && !hasGemini && !hasGrok) {
    throw new Error(
      'No LLM provider key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROK_API_KEY/XAI_API_KEY in .env.'
    );
  }

  // Fallback chain after the Anthropic primary, minus unconfigured providers.
  // onFallback keeps its historical contract: it fires BEFORE each fallback
  // attempt with the previous failure as the cause — including the legacy
  // "Anthropic is not configured" sentinel as the cause of the first fallback
  // when OpenAI is configured but Anthropic isn't (and NOT firing when the first
  // attempted provider is Gemini/Grok with no prior failure).
  const fallbacks: Array<{ provider: LlmProvider; model: () => string; call: () => Promise<LlmFailoverResult> }> = [];
  if (hasOpenAI) fallbacks.push({ provider: "openai", model: resolveOpenAIModel, call: () => callOpenAI(opts) });
  if (hasGemini) fallbacks.push({ provider: "gemini", model: () => resolveGeminiModel(opts.geminiModel), call: () => callGemini(opts) });
  if (hasGrok) fallbacks.push({ provider: "grok", model: () => resolveGrokModel(opts.grokModel), call: () => callGrok(opts) });

  let prevFailure: unknown = !hasAnthropic && hasOpenAI ? new Error("Anthropic is not configured") : undefined;

  // 1. If Anthropic is configured, try it first.
  if (hasAnthropic) {
    ensureDeadline();
    try {
      return await callAnthropic(opts);
    } catch (err) {
      recordFailure("anthropic", opts.anthropicModel, err);
      if (!isHardAnthropicFailure(err)) throw abort("non-retryable", err);
      prevFailure = err;
    }
  }

  // 2..4. Walk the remaining configured providers, failing fast on non-retryable
  // errors and stopping at the deadline instead of stacking unbounded latency.
  for (const fb of fallbacks) {
    ensureDeadline();
    const model = fb.model();
    if (prevFailure !== undefined) opts.onFallback?.(fb.provider, model, prevFailure);
    try {
      return await fb.call();
    } catch (err) {
      const classification = recordFailure(fb.provider, model, err);
      if (classification === "non-retryable") throw abort("non-retryable", err);
      prevFailure = err;
    }
  }

  throw abort("exhausted", lastError);
}

export { GEMINI_TEXT_MODEL, GROK_TEXT_MODEL, KIMI_TEXT_MODEL, OPENAI_TEXT_MODEL };

