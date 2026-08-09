import Anthropic from "@anthropic-ai/sdk";
import { requireEnvVar } from "@vvugc/shared-config";
import type { CostLedger } from "@vvugc/shared-cost";

export type LlmProvider = "anthropic" | "gemini";

export interface LlmFailoverResult {
  /** Raw text from whichever provider succeeded. The CALLER parses it through its
   *  own zod schema — provider choice never changes the validation contract, which
   *  is exactly what protects against cross-vendor schema drift. */
  text: string;
  provider: LlmProvider;
  model: string;
}

export interface LlmFailoverOptions {
  system: string;
  userPrompt: string;
  maxTokens: number;
  /** Anthropic model id (primary). */
  anthropicModel: string;
  /** Gemini model id (fallback). */
  geminiModel: string;
  /** Cost-ledger stage name (e.g. "script_rewrite"). */
  stage: string;
  costLedger?: CostLedger;
  /** Fires when the call actually falls back to Gemini (labeling/surfacing). */
  onFallback?: (provider: LlmProvider, model: string, primaryError: unknown) => void;
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TEXT_MODEL = "gemini-2.5-pro";

/** Classify whether an Anthropic error is a "hard" provider failure (fall back to
 *  Gemini) vs a local/config problem that must surface as-is.
 *
 *  Fails over ONLY on real provider-outage conditions (the SDK's connection/timeout/
 *  generic-API/rate-limit/5xx errors). Never fails over on:
 *    - config errors (AuthenticationError / PermissionDeniedError) — a misconfiguration
 *      would otherwise silently route the whole pipeline onto a fallback provider and
 *      hide a deployment error;
 *    - our own response-shape errors (e.g. "no text block", thrown as a plain `Error`)
 *      — an unexpected-but-received response is a data problem, not an outage. */
function isHardProviderFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  // Plain `Error`s are thrown by our own code (response-shape problems) — surface.
  if (name === "Error" || name === "TypeError") return false;
  // Config/auth problems — surface loudly, never silently fail over.
  if (name === "AuthenticationError" || name === "PermissionDeniedError") return false;
  // Everything else the Anthropic SDK raises after its internal retries is a genuine
  // provider failure (connection, timeout, 5xx, 429) — fail over to Gemini.
  return true;
}

async function callAnthropic(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const client = new Anthropic({ apiKey: requireEnvVar("ANTHROPIC_API_KEY") });
  const message = await client.messages.create({
    model: opts.anthropicModel,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.userPrompt }]
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("LLM response contained no text block");
  }
  opts.costLedger?.recordAnthropicUsage(opts.stage, message.usage, opts.anthropicModel);
  return { text: textBlock.text, provider: "anthropic", model: opts.anthropicModel };
}

async function callGemini(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  const apiKey = requireEnvVar("GEMINI_API_KEY");
  // Native fetch with a hard timeout — this is a rare failover path so a small
  // inline timeout is enough; we deliberately avoid pulling a shared-http dep into
  // the orchestrator just for one fallback call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(
      `${GEMINI_API_BASE}/models/${opts.geminiModel}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${opts.system}\n\n${opts.userPrompt}` }] }
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

/**
 * Failover LLM call: Anthropic primary, Gemini fallback. Transient errors are
 * absorbed by the Anthropic SDK's own retries; only hard provider failures reach
 * the Gemini fallback. Returns raw text + which provider/model produced it. The
 * caller owns zod parsing, so a fallback can never silently change the output
 * contract (the schema-drift guardrail).
 */
export async function generateWithFailover(opts: LlmFailoverOptions): Promise<LlmFailoverResult> {
  // Validate the primary provider's config up front. A missing ANTHROPIC_API_KEY is
  // a deployment/config error, not an outage — it must surface loudly, never silently
  // route the whole pipeline onto Gemini.
  requireEnvVar("ANTHROPIC_API_KEY");
  try {
    return await callAnthropic(opts);
  } catch (err) {
    if (!isHardProviderFailure(err)) throw err;
    opts.onFallback?.("gemini", opts.geminiModel, err);
    return callGemini(opts);
  }
}

export { GEMINI_TEXT_MODEL };
