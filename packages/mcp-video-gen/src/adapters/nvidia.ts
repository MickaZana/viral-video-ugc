import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * NVIDIA NIM Visual GenAI — text-to-video and image-to-video, reached through
 * NVIDIA's OpenAI-compatible NIM inference API.
 *
 * DEPLOYMENT SURFACE (verified live 2026-09-06 with a real build.nvidia.com
 * `nvapi-` key): NVIDIA does NOT currently expose Wan2.2 video generation on any
 * hosted endpoint — `integrate.api.nvidia.com/v1/models` (81 models), the
 * `ai.api.nvidia.com` GenAI paths, and NVCF (`api.nvcf.nvidia.com`, 197
 * functions) contain no `wan-ai/wan2.2` video generator, only an
 * `ai-synthetic-video-detector` classifier. Wan2.2 Visual GenAI ships as a
 * SELF-HOSTED NIM container (NGC, docs.nvidia.com/nim/visual-genai/). So in
 * practice `NVIDIA_VIDEO_BASE_URL` must point at your own NIM
 * (e.g. `http://localhost:8000/v1`). The `https://integrate.api.nvidia.com/v1`
 * default below is kept only so the adapter has a sane value and fails fast
 * with a clear 404 hint if someone selects `nvidia` without standing up a NIM;
 * it is not a working hosted video endpoint today.
 *
 * The default model is Wan2.2 (`wan-ai/wan2.2`), Alibaba's open video model
 * that NVIDIA packages and serves as a NIM: ~16fps, up to 201 frames, short
 * clips at 480p-class resolutions. `NVIDIA_VIDEO_MODEL` overrides the id for
 * anyone pointing this adapter at a different NIM video model on the same
 * endpoint.
 *
 * VERIFIED against the NVIDIA NIM Visual GenAI docs (the self-hosted NIM
 * contract — NOT exercised end-to-end live, as no NIM was reachable; see the
 * deployment note above):
 *  - Endpoint: `POST {baseUrl}/videos/generations`, where `baseUrl` is
 *    `NVIDIA_VIDEO_BASE_URL` or the (non-functional-for-video) default
 *    `https://integrate.api.nvidia.com/v1`.
 *  - Auth: `Authorization: Bearer ${NVIDIA_API_KEY}` (build.nvidia.com keys
 *    start `nvapi-`; confirmed live that such a key authenticates — probes
 *    return 404, not 401). A self-hosted NIM may not enforce auth, but this
 *    adapter still requires the env var for parity with every other adapter and
 *    with `VENDOR_CREDENTIAL_KEYS.nvidia = ["NVIDIA_API_KEY"]` — self-hosted
 *    users can set it to any non-empty placeholder.
 *  - Request body (OpenAI-compat): `{ model, prompt, size, seconds }`, optional
 *    `seed`; for image-to-video an `image` field carrying a
 *    `data:image/...;base64,...` string.
 *  - SYNCHRONOUS. Unlike the poll-based Replicate / fal.ai adapters
 *    (replicate.ts, wan.ts, seedance.ts, grok-video.ts) there is no job id and
 *    no polling — the single POST returns JSON containing a base64-encoded MP4.
 *
 * DEFENSIVELY handled (not all confirmed against one deployment — hosted vs.
 * self-hosted NIM builds differ in exactly where the payload sits):
 *  - The base64 MP4 is read from any of `data[0].b64_json`, `data.b64_json`,
 *    `b64_json`, or `artifacts[0].base64`.
 *  - Some hosted deployments return a URL instead of inline base64
 *    (`data[0].url` / `url`); if so the clip is downloaded via `fetchWithRetry`.
 *  - An `id` field is used for the RawClip id when present.
 *  - If the response instead looks like an async job (`{ id, status }`), that is
 *    surfaced as an explicit error — this adapter targets the documented
 *    synchronous API and does not poll.
 *
 * Variant handling (`NVIDIA_VIDEO_VARIANT`): `auto` (default) | `t2v` | `i2v`.
 * `auto` picks image-to-video iff a reference image is resolvable (precedence
 * below), else text-to-video. On a self-hosted NIM the variant is usually
 * server-fixed; the request we send is identical either way (the `image` field
 * is simply present or absent), so `t2v`/`i2v` only decide whether we attach an
 * image, never a different endpoint.
 *
 * Reference-image precedence (matches VideoGenAdapter.ts's `startingFrame` doc
 * and every sibling adapter): startingFrame > identityRef.primaryImageUrl >
 * referenceImageUrl > referenceImageDataUri. NVIDIA's `image` field wants an
 * inline data URI, so a resolvable-but-URL-only reference is fetched and
 * base64-inlined (SSRF-guarded — see `fetchImageAsDataUri`). If i2v is
 * requested/auto-selected but no image is resolvable, we fall back to t2v
 * rather than failing the segment.
 *
 * Duration: `durationSec` is clamped to a short-form 1-8s range and rounded.
 * Wan2.2 does not guarantee an exact output length; downstream assembly
 * normalizes final timing, so there is intentionally no ffmpeg trim here.
 *
 * NOTE — Wan2.2 "Animate" (drive a reference character image with a driving
 * video) is a distinct capability with its own inputs (character image +
 * driving video). It does not belong on the generic `VideoGenRequest` /
 * `size`+`seconds`+`image` shape used here — it would be a separate adapter
 * capability with an extended request type, not a branch inside `generate()`.
 */

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "wan-ai/wan2.2";
const DEFAULT_TIMEOUT_MS = 300_000;

type NvidiaVariant = "auto" | "t2v" | "i2v";
type NvidiaMode = "t2v" | "i2v";

/**
 * The JSON boundary of `POST /videos/generations`. Every field is optional
 * because hosted and self-hosted NIM builds disagree on the exact shape — the
 * `unknown`-guarded helpers below (`extractVideoPayload`, `looksLikeAsyncJob`)
 * are what actually read it; this interface only documents the shapes we probe.
 */
interface NvidiaVideoResponse {
  id?: string;
  status?: string;
  b64_json?: string;
  url?: string;
  data?:
    | Array<{ b64_json?: string; url?: string; id?: string }>
    | { b64_json?: string; url?: string; id?: string };
  artifacts?: Array<{ base64?: string }>;
}

interface NvidiaErrorParts {
  provider: "nvidia";
  operation: string;
  httpStatus?: number;
  model: string;
  attempt?: number;
  stage?: string;
  message: string;
}

export function createNvidiaAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "nvidia",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("NVIDIA_API_KEY");
      const env = loadEnv();
      const baseUrl = (env.NVIDIA_VIDEO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const model = env.NVIDIA_VIDEO_MODEL || DEFAULT_MODEL;
      const variant = normalizeVariant(env.NVIDIA_VIDEO_VARIANT);
      const timeoutMs = Number(env.NVIDIA_VIDEO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

      // Cinema Controls: enrich prompt with visual direction (same idiom as
      // wan.ts / replicate.ts / grok-video.ts).
      const enrichedPrompt = req.visualDirection
        ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}`
        : req.prompt;

      const size = mapAspectRatioToSize(req.aspectRatio);
      const seconds = mapDurationToSeconds(req.durationSec);

      // Resolve the i2v image (if any). Prefer an existing data URI; fetch +
      // inline a URL-only reference; on any failure (including an SSRF-guard
      // rejection) fall back to t2v rather than throwing.
      const mode = resolveNvidiaMode(req, variant);
      let imageDataUri: string | undefined;
      if (mode === "i2v") {
        const ref = resolveReferenceImage(req);
        if (ref.dataUri) {
          imageDataUri = ref.dataUri;
        } else if (ref.url) {
          try {
            imageDataUri = await fetchImageAsDataUri(ref.url, {});
          } catch {
            imageDataUri = undefined;
          }
        }
      }

      const body = buildRequestBody({ model, prompt: enrichedPrompt, size, seconds, imageDataUri });
      const url = `${baseUrl}/videos/generations`;

      const res = await postGeneration(url, apiKey, body, { timeoutMs });
      if (!res.ok) {
        throw sanitizeNvidiaError({
          provider: "nvidia",
          operation: "videos/generations",
          httpStatus: res.status,
          model,
          stage: "post",
          message: await safeText(res)
        });
      }

      let json: unknown;
      try {
        // `res.json()` is `any`; pin it to the documented boundary type, then
        // hand it to the `unknown`-guarded extractors below.
        json = (await res.json()) as NvidiaVideoResponse;
      } catch (err) {
        throw sanitizeNvidiaError({
          provider: "nvidia",
          operation: "videos/generations",
          httpStatus: res.status,
          model,
          stage: "parse-json",
          message: err instanceof Error ? err.message : String(err)
        });
      }

      const payload = extractVideoPayload(json);
      if (!payload.base64 && !payload.url) {
        const hint = looksLikeAsyncJob(json)
          ? " Response looks like an async job ({id,status}); this adapter targets NVIDIA's documented synchronous API and does not poll."
          : "";
        throw sanitizeNvidiaError({
          provider: "nvidia",
          operation: "videos/generations",
          httpStatus: res.status,
          model,
          stage: "extract-payload",
          message: `No base64 MP4 or video URL found in response.${hint} Top-level keys: ${describeShape(json)}`
        });
      }

      let bytes: Buffer;
      if (payload.base64) {
        bytes = Buffer.from(payload.base64, "base64");
      } else {
        const dl = await fetchWithRetry(payload.url as string, { timeoutMs: 120_000 });
        if (!dl.ok) {
          throw sanitizeNvidiaError({
            provider: "nvidia",
            operation: "download-clip",
            httpStatus: dl.status,
            model,
            stage: "download",
            message: await safeText(dl)
          });
        }
        bytes = Buffer.from(await dl.arrayBuffer());
      }

      // Fallback id when the synchronous response omits one — kept prefix-free so
      // the filePath below reads `nvidia-<idx>-<id>` in both cases (siblings use
      // the raw vendor job id here the same way).
      const id = nonEmptyString(payload.id) ? payload.id : randomUUID();
      const filePath = `${outDir}/nvidia-${req.scriptSegmentIndex}-${id}.mp4`;

      // Validate BEFORE the clip reaches its final name: write `${filePath}.part`,
      // check the bytes on disk, and only then promote it into place. On a
      // validation failure leave NOTHING behind (no `.part`, no `.mp4`) so a
      // downstream `nvidia-*.mp4` glob can never ingest a corrupt response.
      const partPath = writeClipPartFile(bytes, filePath);
      try {
        validateGeneratedClip(partPath);
      } catch (err) {
        rmSync(partPath, { force: true });
        throw err;
      }
      promoteClipPartFile(filePath);

      return {
        id,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "nvidia",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — small, single-purpose, typed. External JSON is `unknown`
// and narrowed with explicit guards.
// ---------------------------------------------------------------------------

function normalizeVariant(raw: string | undefined): NvidiaVariant {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "t2v" || v === "i2v" ? v : "auto";
}

/** `auto` ⇒ i2v iff a reference image is resolvable, else t2v. */
function resolveNvidiaMode(req: VideoGenRequest, variant: NvidiaVariant): NvidiaMode {
  if (variant === "t2v") return "t2v";
  if (variant === "i2v") return "i2v";
  const ref = resolveReferenceImage(req);
  return ref.dataUri || ref.url ? "i2v" : "t2v";
}

/**
 * Precedence: startingFrame.imageDataUri/imageUrl → identityRef.primaryImageUrl
 * → referenceImageUrl → referenceImageDataUri (see VideoGenAdapter.ts's
 * `startingFrame` doc). A data URI is preferred where available so the caller
 * can skip the fetch entirely.
 */
function resolveReferenceImage(req: VideoGenRequest): { dataUri?: string; url?: string } {
  if (req.startingFrame?.imageDataUri) return { dataUri: req.startingFrame.imageDataUri };
  if (req.startingFrame?.imageUrl) return { url: req.startingFrame.imageUrl };
  if (req.identityRef?.primaryImageUrl) return { url: req.identityRef.primaryImageUrl };
  if (req.referenceImageUrl) return { url: req.referenceImageUrl };
  if (req.referenceImageDataUri) return { dataUri: req.referenceImageDataUri };
  return {};
}

/** NVIDIA `size` string for each supported aspect ratio (480p-class, ≤201 frames). */
function mapAspectRatioToSize(aspectRatio: VideoGenRequest["aspectRatio"]): string {
  switch (aspectRatio) {
    case "9:16":
      return "480x832";
    case "1:1":
      return "624x624";
    case "16:9":
      return "832x480";
    default:
      return "480x832";
  }
}

/**
 * Map `durationSec` → `seconds`, clamped to a sane short-form range (1-8s) and
 * rounded. Exact duration is not guaranteed by Wan2.2; downstream assembly
 * normalizes final timing.
 */
function mapDurationToSeconds(durationSec: number): number {
  const rounded = Math.round(durationSec);
  if (!Number.isFinite(rounded)) return 5;
  return Math.min(8, Math.max(1, rounded));
}

function buildRequestBody(args: {
  model: string;
  prompt: string;
  size: string;
  seconds: number;
  seed?: number;
  imageDataUri?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    size: args.size,
    seconds: args.seconds
  };
  if (typeof args.seed === "number" && Number.isFinite(args.seed)) body.seed = args.seed;
  if (args.imageDataUri) body.image = args.imageDataUri;
  return body;
}

/**
 * POST the generation request with its OWN bounded retry loop.
 *
 * `fetchWithRetry` deliberately does not retry non-OK HTTP responses (see its
 * doc comment) — it only retries transport-level failures. NVIDIA's endpoint
 * being synchronous means a transient 429/503 from the inference backend is a
 * normal, retryable condition that `fetchWithRetry` would surface as a hard
 * failure. So this loop retries transport errors AND the retryable status set
 * (429/500/502/503/504) with exponential backoff, while throwing immediately on
 * a client-fault status (400/401/403/404/422) that a retry could never fix.
 * Per-attempt timeout is enforced with an `AbortController`, the same pattern
 * `fetchWithRetry` uses internally.
 */
async function postGeneration(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts: { timeoutMs: number; retries?: number }
): Promise<Response> {
  const { timeoutMs, retries = 2 } = opts;
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const FATAL = new Set([400, 401, 403, 404, 422]);
  const model = typeof body.model === "string" ? body.model : "unknown";
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? new Error(`NVIDIA generation request timed out after ${timeoutMs}ms`)
          : err;
      if (attempt === retries) throw lastErr;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    clearTimeout(timer);

    if (res.ok) return res;
    if (FATAL.has(res.status)) {
      // A 404 here almost always means NVIDIA_VIDEO_BASE_URL points somewhere
      // without a Wan2.2 video NIM — the hosted `integrate.api.nvidia.com` API
      // does not serve video generation (verified 2026-09-06). Point it at a
      // self-hosted NIM, e.g. http://localhost:8000/v1.
      const hint =
        res.status === 404
          ? " — no `/videos/generations` endpoint at this base URL; NVIDIA has no hosted Wan2.2 video API, set NVIDIA_VIDEO_BASE_URL to a self-hosted NIM"
          : "";
      throw sanitizeNvidiaError({
        provider: "nvidia",
        operation: "videos/generations",
        httpStatus: res.status,
        model,
        attempt: attempt + 1,
        stage: "post",
        message: (await safeText(res)) + hint
      });
    }
    if (!RETRYABLE.has(res.status) || attempt === retries) return res;
    lastErr = new Error(`NVIDIA ${res.status} on attempt ${attempt + 1}`);
    await sleep(1000 * 2 ** attempt);
  }
  throw lastErr ?? new Error("NVIDIA generation request failed after retries");
}

/** A usable base64/URL payload is a NON-empty string; `""` counts as "not present". */
function nonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * Defensive payload extraction. Hosted and self-hosted NIM builds place the
 * base64 MP4 / URL / id in different spots — probe all documented shapes. An
 * explicitly-empty `b64_json`/`url` (`""`) is treated as "no payload" so the
 * caller reports "No base64 MP4 or video URL found" rather than misattributing
 * it as a zero-byte clip.
 */
function extractVideoPayload(json: unknown): { base64?: string; url?: string; id?: string } {
  const out: { base64?: string; url?: string; id?: string } = {};
  if (!isRecord(json)) return out;

  if (typeof json.id === "string") out.id = json.id;

  const data = json.data;
  const firstData = Array.isArray(data) && isRecord(data[0]) ? data[0] : undefined;
  const dataObj = !Array.isArray(data) && isRecord(data) ? data : undefined;

  if (nonEmptyString(json.b64_json)) out.base64 = json.b64_json;
  else if (firstData && nonEmptyString(firstData.b64_json)) out.base64 = firstData.b64_json;
  else if (dataObj && nonEmptyString(dataObj.b64_json)) out.base64 = dataObj.b64_json;
  else if (Array.isArray(json.artifacts) && isRecord(json.artifacts[0]) && nonEmptyString(json.artifacts[0].base64)) {
    out.base64 = json.artifacts[0].base64;
  }

  if (!out.base64) {
    if (nonEmptyString(json.url)) out.url = json.url;
    else if (firstData && nonEmptyString(firstData.url)) out.url = firstData.url;
    else if (dataObj && nonEmptyString(dataObj.url)) out.url = dataObj.url;
  }

  if (!out.id && firstData && typeof firstData.id === "string") out.id = firstData.id;

  return out;
}

/** True when the JSON reads like an async job envelope rather than a finished clip. */
function looksLikeAsyncJob(json: unknown): boolean {
  return isRecord(json) && typeof json.id === "string" && typeof json.status === "string";
}

/** Compact description of a JSON value's shape for error messages (keys only, no values). */
function describeShape(json: unknown): string {
  if (Array.isArray(json)) return `array(${json.length})`;
  if (isRecord(json)) return Object.keys(json).join(",") || "{}";
  return typeof json;
}

/**
 * Fetch a remote image and return it as a `data:<mime>;base64,<...>` URI.
 *
 * SSRF-safe: only http(s); rejects `localhost`, `*.local`, and literal
 * private/loopback/link-local IP hosts (v4 `127.` `10.` `192.168.` `169.254.`
 * `172.16-31.`, v6 `::1` `fc00::/7` `fe80::/10`, plus `::ffff:` v4-mapped);
 * requires an `image/*` Content-Type; enforces `maxBytes` against
 * `Content-Length` when present AND while streaming the body.
 */
async function fetchImageAsDataUri(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number }
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`NVIDIA reference image URL is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`NVIDIA reference image URL must be http(s), got "${parsed.protocol}"`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(
      `NVIDIA reference image host "${parsed.hostname}" is not allowed (private/loopback/link-local/localhost)`
    );
  }

  const res = await fetchWithRetry(url, { timeoutMs });
  if (!res.ok) {
    throw new Error(`NVIDIA reference image fetch failed: ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(`NVIDIA reference image has non-image Content-Type "${contentType || "<none>"}"`);
  }

  const declaredLen = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new Error(`NVIDIA reference image is ${declaredLen} bytes, over the ${maxBytes}-byte cap`);
  }

  const buf = await readBodyCapped(res, maxBytes);
  const mime = contentType.split(";")[0].trim() || "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Read a response body into a Buffer, aborting if it exceeds `maxBytes` mid-stream. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`NVIDIA reference image exceeds the ${maxBytes}-byte cap`);
    }
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`NVIDIA reference image exceeds the ${maxBytes}-byte cap (streamed)`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/** SSRF host filter — see `fetchImageAsDataUri`. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped && isBlockedIpv4(mapped[1])) return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    return false;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → refuse rather than risk it
  }
  const [a, b] = parts;
  if (a === 0 || a === 127) return true; // "this host" / loopback
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  return false;
}

/**
 * Write `bytes` to `${filePath}.part` (creating the dir first) and return that
 * staging path. The clip is deliberately NOT yet at its final name — the caller
 * validates the `.part` and only then calls `promoteClipPartFile`. On any write
 * failure, best-effort remove the partial and rethrow.
 */
function writeClipPartFile(bytes: Buffer, filePath: string): string {
  const partPath = `${filePath}.part`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(partPath, bytes);
    return partPath;
  } catch (err) {
    try {
      rmSync(partPath, { force: true });
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw err;
  }
}

/**
 * Promote a validated `${filePath}.part` into its final `filePath` via
 * `renameSync`. On failure, best-effort remove the partial and rethrow.
 */
function promoteClipPartFile(filePath: string): void {
  const partPath = `${filePath}.part`;
  try {
    renameSync(partPath, filePath);
  } catch (err) {
    try {
      rmSync(partPath, { force: true });
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw err;
  }
}

/**
 * Guard against an HTML/JSON error page (or any non-video body) reaching ffmpeg:
 * the file must exist, be non-empty, and start with an MP4 `ftyp` box (bytes
 * 4-8 === "ftyp") or a leading `\x00\x00\x00` box-size prefix. On failure the
 * error names the first bytes as hex + ASCII. Run against the `${filePath}.part`
 * staging file BEFORE it is promoted, so a body that fails these checks never
 * lands as a finished `nvidia-*.mp4`.
 */
function validateGeneratedClip(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`NVIDIA clip was not written to ${filePath}`);
  }
  const size = statSync(filePath).size;
  if (size === 0) {
    throw new Error(`NVIDIA clip at ${filePath} is empty (0 bytes)`);
  }

  const want = Math.min(80, size);
  const head = Buffer.alloc(want);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, head, 0, want, 0);
  } finally {
    closeSync(fd);
  }

  const hasFtyp = head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp";
  const hasBoxSizePrefix =
    head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x00;
  if (!hasFtyp && !hasBoxSizePrefix) {
    throw new Error(
      `NVIDIA response did not decode to an MP4 (no ftyp box). ` +
        `First ${head.length} bytes: ${head.toString("hex")} | ${toAsciiPreview(head)}`
    );
  }
}

function toAsciiPreview(buf: Buffer): string {
  let out = "";
  for (const byte of buf) {
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  return out;
}

/**
 * Compose a provider error, stripping anything that could leak the API key or
 * the reference-image bytes: `Bearer ...`, `nvapi-...`, `authorization`/
 * `api_key` values, and any `data:...;base64,...` URI. Included response text is
 * truncated to 500 chars.
 */
function sanitizeNvidiaError(parts: NvidiaErrorParts): Error {
  const scrubbed = scrubSecrets(parts.message).slice(0, 500);
  const segs = [
    `[${parts.provider}]`,
    parts.operation,
    `model=${parts.model}`,
    parts.httpStatus !== undefined ? `http=${parts.httpStatus}` : undefined,
    parts.attempt !== undefined ? `attempt=${parts.attempt}` : undefined,
    parts.stage ? `stage=${parts.stage}` : undefined,
    scrubbed ? `— ${scrubbed}` : undefined
  ].filter((s): s is string => Boolean(s));
  return new Error(segs.join(" "));
}

function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/nvapi-[A-Za-z0-9._-]+/gi, "nvapi-[redacted]")
    .replace(/("?authorization"?\s*[:=]\s*)("?)[^"\s,}]+\2/gi, "$1[redacted]")
    .replace(/("?api[_-]?key"?\s*[:=]\s*)("?)[^"\s,}]+\2/gi, "$1[redacted]")
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, "data:[redacted-base64]");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no response body>";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
