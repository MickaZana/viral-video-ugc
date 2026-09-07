import { dirname, join } from "node:path";
import { appendFileSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  aggregateUsage,
  createAccountStore,
  createSessionStore,
  resolveOrgId,
  roleHasPermission,
  EmailAlreadyRegisteredError,
  toPublicAccount,
  ACCOUNT_ROLES,
  type Account,
  type AccountPermission,
  type AccountRole,
  type AgencyClientInput,
  type AccountSettingsInput
} from "@vvugc/shared-auth";
import type { Invite } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import { BrandKitSchema, PlatformSchema, RunConfigSchema, ProductProfileSchema, ProductImageSchema, CreatorProfileSchema, CreatorReferenceImageSchema, PRESET_CATEGORY_IDS, type ProductProfile, type CreatorProfile, type Preset } from "@vvugc/shared-schema";
import type { CandidateVideo } from "@vvugc/shared-schema";
import { runAcceptance, runCycle, fetchRemixTranscript, parseSourceUrl, previewRemix } from "@vvugc/orchestrator";
import { BUILTIN_UGC_TEMPLATES, getUgcTemplate, templateCompatibility, BUILTIN_PRESETS, getPreset, listPresetsByCategory } from "@vvugc/orchestrator";
import { createProductEventStore, ProductEventTypeSchema, summarizeUsage } from "@vvugc/shared-product-analytics";
import { estimateCostUsd, type CostVendor } from "@vvugc/shared-cost";
import { discoverPlatform } from "@vvugc/mcp-discovery";
import { generateCharacterPortraitBatch, CharacterAttributesSchema } from "@vvugc/mcp-video-gen";
import { isRealRun, isLLMLive, isDiscoveryLive } from "./llm-gate.js";
import { buildDiscoverResponse } from "./discoveryAnalyze.js";
import {
  getReviewItem,
  listReviewItems,
  setReviewItemStatus,
  deleteReviewItemsByOrg
} from "@vvugc/review-queue";
import { z } from "zod";
import { LocalBillingRepository, type BillingRepository } from "./billing-postgres.js";
import { deleteSecurityEventsForAccount, deleteSecurityEventsForOrg, listSecurityEvents, writeSecurityEvent } from "./security-events.js";
import { createPipelineJobStore } from "./jobs.js";
import { createMfaChallengeStore, createMfaStore } from "./mfa.js";
import { createPasswordResetStore } from "./password-reset.js";
import { createProgressCallback, completeRun, sseProgressHandler } from "./run-progress.js";
import { generateTotpSecret, otpauthTotpUrl, verifyTotpCode } from "./totp.js";
import { purgeOrgRuns } from "./runs.js";
import {
  createGoogleOAuthState,
  createOAuthNonceStore,
  exchangeGoogleAuthorizationCode,
  fetchGoogleYouTubeChannel,
  googleAuthorizationUrl,
  verifyGoogleOAuthState
} from "./google-oauth.js";
import { resolveSocialTokenEncryptionKey } from "./social-token-key.js";
import { PostgresIdentityRepository, MfaSecretCipher } from "./identity-postgres.js";
import { createPostgresDatabase, type PostgresDatabase } from "@vvugc/shared-persistence";
import { runMigrations } from "@vvugc/review-queue";
import { LocalTenantProfileRepository, PostgresTenantProfileRepository, type TenantProfileRepository } from "./tenant-profile-postgres.js";

const isProduction = process.env.NODE_ENV === "production";
const SESSION_COOKIE = isProduction ? "__Host-vvugc_session" : "vvugc_session";

/**
 * Minimal manual cookie parsing rather than adding the `cookie`/`cookie-parser`
 * dependency — the format this needs (a single httpOnly session token, no
 * signing/encryption beyond the session store's own random token) doesn't need
 * a general-purpose cookie library, matching this repo's existing preference
 * for small hand-rolled utilities over new dependencies for simple parsing
 * (see shared-http's fetchWithRetry instead of an HTTP client library).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function sessionCookieHeader(token: string, maxAgeSec: number): string {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${maxAgeSec}`];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookieHeader(): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

export interface AuthedRequest extends Request {
  accountId?: string;
  auditActor?: string;
  /** Set by the session middleware after it has verified both the token and account. */
  account?: Account;
}

/** The deliberately async identity boundary.  The file implementation is only a
 * development/test adapter; production never exposes a synchronous DB facade. */
export interface IdentityRepository {
  signUp(email: string, password: string, orgName?: string): Promise<Account>;
  signUpAsMember(email: string, password: string, orgId: string, role?: AccountRole): Promise<Account>;
  /** Consumes a valid invitation and creates its membership atomically when the
   * backing repository is PostgreSQL.  The local adapter preserves the legacy
   * development semantics behind the same awaitable boundary. */
  acceptInvite(invite: Invite, password: string): Promise<Account | undefined>;
  authenticate(email: string, password: string): Promise<Account | undefined>;
  findById(id: string): Promise<Account | undefined>;
  findByEmail(email: string): Promise<Account | undefined>;
  listByOrg(orgId: string): Promise<Account[]>;
  updatePassword(accountId: string, password: string): Promise<boolean>;
  setRole(orgId: string, accountId: string, role: AccountRole): Promise<Account | undefined>;
  removeMember(orgId: string, accountId: string): Promise<boolean>;
  deleteAccount(id: string): Promise<boolean>;
  deleteOrg(id: string): Promise<boolean>;
  createSession(accountId: string): Promise<{ token: string; accountId: string; createdAt: string; expiresAt: string }>;
  verifySession(token: string): Promise<{ token: string; accountId: string; createdAt: string; expiresAt: string } | undefined>;
  revokeSession(token: string): Promise<void>;
  revokeAllSessions(accountId: string): Promise<void>;
  createReset(accountId: string, email: string): Promise<{ token: string; email: string; createdAt: string; expiresAt: string }>;
  consumeReset(token: string): Promise<{ token: string; email: string; createdAt: string; expiresAt: string } | undefined>;
  getMfa(accountId: string): Promise<{ accountId: string; secret: string; confirmedAt?: string; createdAt: string } | undefined>;
  putMfa(record: { accountId: string; secret: string; confirmedAt?: string; createdAt: string }): Promise<void>;
  removeMfa(accountId: string): Promise<boolean>;
  createMfaChallenge(accountId: string): Promise<{ token: string; accountId: string; createdAt: string; expiresAt: string }>;
  consumeMfaChallenge(token: string): Promise<{ token: string; accountId: string; createdAt: string; expiresAt: string } | undefined>;
  addOAuthNonce(nonce: string): Promise<void>;
  consumeOAuthNonce(nonce: string): Promise<boolean>;
}

export interface AccountRouteDependencies {
  logger?: { info: (...args: unknown[]) => void };
  identity?: IdentityRepository;
  tenantProfiles?: TenantProfileRepository;
  /** Production injects the PostgreSQL repository; local development receives the file adapter. */
  billing?: BillingRepository;
}

export interface InitializedIdentity {
  readonly identity: IdentityRepository;
  readonly database?: PostgresDatabase;
  readonly tenantProfiles?: TenantProfileRepository;
}

function localIdentity(runsDir: string): IdentityRepository {
  const accounts = createAccountStore(join(runsDir, "accounts.json"));
  const sessions = createSessionStore(join(runsDir, "sessions.json"));
  const resets = createPasswordResetStore(join(runsDir, "password-resets.json"));
  const mfa = createMfaStore(join(runsDir, "mfa.json"));
  const challenges = createMfaChallengeStore(join(runsDir, "mfa-challenges.json"));
  const nonces = createOAuthNonceStore(join(runsDir, "oauth-nonces.json"));
  return {
    signUp: async (...args) => accounts.signUp(...args), signUpAsMember: async (...args) => accounts.signUpAsMember(...args), acceptInvite: async (invite, password) => accounts.signUpAsMember(invite.email, password, invite.orgId, invite.role), authenticate: async (...args) => accounts.authenticate(...args), findById: async (id) => accounts.findById(id), findByEmail: async (email) => accounts.findByEmail(email), listByOrg: async (orgId) => accounts.listByOrg(orgId), updatePassword: async (...args) => accounts.updatePassword(...args), setRole: async (...args) => accounts.setRole(...args), removeMember: async (...args) => accounts.removeMember(...args), deleteAccount: async (id) => accounts.deleteAccount(id), deleteOrg: async (id) => accounts.deleteOrg(id),
    createSession: async (id) => sessions.create(id), verifySession: async (token) => sessions.verify(token), revokeSession: async (token) => { sessions.revoke(token); }, revokeAllSessions: async (id) => { sessions.revokeAllForAccount(id); },
    createReset: async (_id, email) => resets.create(email), consumeReset: async (token) => resets.consume(token), getMfa: async (id) => mfa.get(id), putMfa: async (record) => { mfa.put(record); }, removeMfa: async (id) => mfa.remove(id), createMfaChallenge: async (id) => challenges.create(id), consumeMfaChallenge: async (token) => challenges.consume(token), addOAuthNonce: async (nonce) => { nonces.add(nonce); }, consumeOAuthNonce: async (nonce) => nonces.consume(nonce)
  };
}

/** Initializes the sole production identity source and migrates it before routes are registered. */
export async function initializeIdentity(env = loadEnv()): Promise<InitializedIdentity> {
  const databaseUrl = process.env.DATABASE_URL;
  // Production intentionally accepts only the explicit standard name.  Falling
  // back to a provider-specific variable here could silently select a different
  // deployment than the one whose migrations were verified.
  if (!databaseUrl && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production; refusing filesystem identity storage");
  }
  const connectionString = databaseUrl ?? process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    return { identity: localIdentity(env.VVUGC_RUNS_DIR), tenantProfiles: new LocalTenantProfileRepository(env.VVUGC_RUNS_DIR, resolveSocialTokenEncryptionKey()) };
  }
  const database = createPostgresDatabase({ connectionString });
  try {
    await runMigrations(database.pool);
    return {
      identity: new PostgresIdentityRepository(database.pool, new MfaSecretCipher(process.env.MFA_ENCRYPTION_KEY)),
      tenantProfiles: new PostgresTenantProfileRepository(database.pool, resolveSocialTokenEncryptionKey()),
      database
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`vvugc-csrf:${sessionToken}`).digest("base64url");
}

export function runIdForIdempotency(orgId: string, idempotencyKey: string): string {
  return `job-${createHash("sha256").update(`${orgId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function equalToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Same rationale as server.ts's own asyncHandler (kept explicit even though Express 5
// forwards async rejections on its own) — duplicated rather than imported since these
// are two independent route-registration modules, not worth a shared-utility extraction
// for four lines.
function asyncHandler<P = Record<string, string>>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const PRODUCT_IMAGE_MIME = new Map([["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"]]);
const MAX_PRODUCT_HTML_BYTES = 512_000;
const MAX_PRODUCT_IMAGE_BYTES = 2_000_000;

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd");
  }
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 100 && b >= 64 && b <= 127) || a === 0 || a >= 224;
}

async function assertSafeExternalUrl(raw: string): Promise<URL> {
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only http and https URLs are supported");
  if (parsed.username || parsed.password) throw new Error("URLs with embedded credentials are not supported");
  const addresses = isIP(parsed.hostname) ? [parsed.hostname] : (await lookup(parsed.hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("URL resolves to a private or reserved address");
  return parsed;
}

async function assertDnsStable(url: URL, before: string[]): Promise<void> {
  if (isIP(url.hostname)) return;
  const after = (await lookup(url.hostname, { all: true })).map((entry) => entry.address).sort();
  if (after.join(",") !== [...before].sort().join(",") || after.some(isPrivateAddress)) throw new Error("remote host DNS changed during request");
}

async function fetchExternalBytes(raw: string, maxBytes: number, accepted: (contentType: string) => boolean): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  let current = raw;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const url = await assertSafeExternalUrl(current);
    const initialAddresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((entry) => entry.address);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "VVUGC-product-ingest/1.0" } });
      await assertDnsStable(url, initialAddresses);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect missing location");
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) throw new Error(`remote page returned ${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      if (!accepted(contentType)) throw new Error(`unsupported remote content type: ${contentType || "unknown"}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("remote response is too large");
      if (!response.body) throw new Error("remote response has no body");
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let total = 0;
      for (; ;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maxBytes) { await reader.cancel(); throw new Error("remote response is too large"); } chunks.push(Buffer.from(next.value)); }
      const buffer = Buffer.concat(chunks, total);
      return { bytes: buffer, contentType, finalUrl: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too many redirects");
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().slice(0, 20_000);
}

export function extractProductFields(html: string, sourceUrl: string): Partial<ProductProfile> {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? "";
  const description = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim() ?? "";
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim();
  const text = stripHtml(html);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
  const benefits = (sentences.filter((s) => /\b(helps?|designed to|reduces?|improves?|supports?|made with|features?)\b/i.test(s)).length
    ? sentences.filter((s) => /\b(helps?|designed to|reduces?|improves?|supports?|made with|features?)\b/i.test(s))
    : (text.match(/[^.!?]*(?:helps?|designed to|reduces?|improves?|supports?|made with|features?)[^.!?]*[.!?]/gi) ?? [])).slice(0, 8);
  const cta = text.match(/\b(shop now|buy now|get yours|learn more|try it|subscribe|add to cart)\b/i)?.[1] ?? "Learn more";
  const customer = text.match(/\b(for|designed for)\s+([A-Za-z][^.!?]{3,90})/i)?.[2]?.trim();
  return {
    name: title.slice(0, 160) || new URL(sourceUrl).hostname,
    description: description.slice(0, 5000) || text.slice(0, 5000),
    shortDescription: description.slice(0, 500),
    targetCustomer: customer,
    primaryBenefits: benefits.map((s) => s.slice(0, 300)),
    claims: benefits.map((s) => s.slice(0, 300)),
    callToAction: cta,
    extractedSourceText: text,
    extractionStatus: "complete",
    extractedImageUrls: ogImage ? [new URL(ogImage, sourceUrl).toString()] : [],
    ...(ogImage ? { canonicalUrl: sourceUrl } : {})
  };
}

const SettingsInputSchema = z.object({
  appMode: z.enum(["standard", "curriculum"]).optional().default("standard"),
  niche: z.string().min(1),
  brandVoice: z.string().min(1),
  platforms: z.array(PlatformSchema).min(1),
  targetDurationSec: z.number().int().min(15).max(60),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video", "wan", "nvidia"]),
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  cadence: z.enum(["weekly", "manual"])
});

const AppModeInputSchema = z.object({ appMode: z.enum(["standard", "curriculum"]) });

const ClientInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  niche: z.string().trim().min(1).max(200),
  brandVoice: z.string().trim().min(1).max(500),
  brandKit: BrandKitSchema.optional(),
  locale: z.string().trim().min(2).max(35).default("en"),
  platforms: z.array(PlatformSchema).min(1),
  targetDurationSec: z.number().int().min(15).max(60),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video", "wan", "nvidia"]),
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  cadence: z.enum(["weekly", "manual"]),
  active: z.boolean().default(true)
});

// This is intentionally a quote for the video-generation vendor only.  The
// pipeline cannot know narration character count until it has written captions,
// so voiceover is disclosed as variable rather than being made-up precision.
const LiveRunQuoteInputSchema = z.object({
  clientId: z.string().min(1),
  templateId: z.string().min(1).optional()
}).strict();
const MAX_PLATFORM_VIDEOS_PER_FLOW = 8;

/**
 * The canonical shape of GET-style POST /accounts/run/quote's response. `.strict()`
 * so the route cannot silently return a field the control-panel `RunQuote` type
 * (apps/control-panel/src/lib/types.ts) doesn't consume — parity between the two
 * is asserted key-for-key in accounts.test.ts. Keep the two in lockstep.
 */
const LiveRunQuoteResponseSchema = z.object({
  currency: z.literal("USD"),
  videoVendor: z.string(),
  minimumVideoVendorSpendUsd: z.number(),
  maximumVideoVendorSpendUsd: z.number(),
  clipsPerCandidate: z.number().int(),
  maximumClipsPerCandidate: z.number().int(),
  platformCount: z.number().int(),
  minimumCandidateCount: z.number().int(),
  maximumPlatformVideosPerFlow: z.number().int(),
  voiceover: z.union([
    z.object({ cost: z.literal("variable"), vendor: z.string().optional() }),
    z.object({ cost: z.literal("not_selected") })
  ]),
  notes: z.array(z.string())
}).strict();

const ProductInputSchema = ProductProfileSchema.omit({ id: true, orgId: true, createdAt: true, updatedAt: true, productImages: true, extractionStatus: true }).extend({
  clientId: z.string().min(1).optional(),
  extractionStatus: z.enum(["manual", "pending", "complete", "failed"]).default("manual")
});
const CreatorInputSchema = CreatorProfileSchema.omit({ id: true, orgId: true, createdAt: true, updatedAt: true, referenceImages: true, consentConfirmedAt: true, consentConfirmedBy: true }).extend({ clientId: z.string().min(1).optional(), referenceImages: z.array(CreatorReferenceImageSchema).max(8).optional() });

/**
 * Account signup/login is separate from the dashboard's existing single-operator
 * HTTP Basic Auth (auth.ts) — Basic Auth stays exactly as it is (it gates the
 * approve/reject queue for whoever operates this dashboard instance), while
 * accounts are the beginning of the customer-facing, multi-tenant surface (each
 * agency/brand gets its own login and usage view — see @vvugc/shared-auth).
 * Deliberately additive: nothing here changes what Basic Auth already protects.
 *
 * Settings/usage/billing are keyed by orgId (resolveOrgId(account)), not the raw
 * session accountId — every member of an org (owner + invited teammates) shares
 * one set of each, which is the actual point of multi-seat access.
 */
export function registerAccountRoutes(
  app: Express,
  deps: AccountRouteDependencies = {}
): { requireSession: RequestHandler; verifySessionRequest: (req: Request) => Promise<{ accountId: string; account: Account } | undefined>; identity: IdentityRepository } {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const identity = deps.identity ?? (process.env.NODE_ENV === "production" ? (() => { throw new Error("production account routes require initialized PostgreSQL identity") })() : localIdentity(VVUGC_RUNS_DIR));
  const tenantProfiles = deps.tenantProfiles ?? new LocalTenantProfileRepository(VVUGC_RUNS_DIR, resolveSocialTokenEncryptionKey());
  const billing = deps.billing ?? new LocalBillingRepository(VVUGC_RUNS_DIR);
  app.use("/accounts/creators/:creatorId/images", (req: AuthedRequest, res: Response, next: NextFunction) => requireSession(req, res, next), async (req: AuthedRequest, res: Response, next: NextFunction) => { const account = requireAccount(req, res); if (!account) return; const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const creator = await tenantProfiles.creatorGet(resolveOrgId(account), id); if (creator && !creator.consentConfirmed) return res.status(400).json({ error: "explicit consent is required before uploading reference images" }); next(); });
  const jobStore = createPipelineJobStore(join(VVUGC_RUNS_DIR, "pipeline-jobs.json"));
  const productEvents = createProductEventStore(join(VVUGC_RUNS_DIR, "product-events.json"));

  // Triggering a run is a real (potentially paid, once live credentials are configured)
  // vendor call chain — same "every attempt counts" reasoning as regeneration/publishing.
  const runRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many run requests — try again later" }
  });

  // Same rationale as server.ts's authRateLimiter for Basic Auth — slows credential
  // stuffing/brute force against signup+login without penalizing normal use.
  const accountRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too many attempts — try again later" }
  });

  const requireSession: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => { void (async () => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? await identity.verifySession(token) : undefined;
    if (!session) return res.status(401).json({ error: "not authenticated" });
    // Browser fetch/form mutations carry Origin. Service clients without a browser
    // cookie context remain usable; the SameSite cookie and global origin check are
    // the first line, while this explicit token prevents same-origin gadget attacks.
    if (req.headers.origin && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const supplied = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
      if (!token || !equalToken(supplied, csrfTokenFor(token))) {
        return res.status(403).json({ error: "invalid CSRF token" });
      }
    }
    const account = await identity.findById(session.accountId);
    if (!account) return res.status(401).json({ error: "not authenticated" });
    req.accountId = session.accountId; req.account = account;
    req.auditActor = `account:${session.accountId}`;
    next();
  })().catch(next); };

  /** Read-only session check for the dual-auth middleware in server.ts — returns the
   *  accountId when the request carries a valid session cookie (no CSRF enforcement;
   *  the caller decides whether a mutation needs it). Used so the control-panel data
   *  endpoints can be reached with either a real account session OR the operator's
   *  Basic Auth, without duplicating the session store wiring. */
  const verifySessionRequest = async (req: Request): Promise<{ accountId: string; account: Account } | undefined> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? await identity.verifySession(token) : undefined;
    if (!session) return undefined;
    const account = await identity.findById(session.accountId);
    return account ? { accountId: session.accountId, account } : undefined;
  };

  /** Resolves the authenticated account, 401ing if the session's accountId somehow
   *  doesn't map to a real account (e.g. deleted after the session was issued). */
  function requireAccount(req: AuthedRequest, res: Response): Account | undefined {
    const account = req.account;
    if (!account) {
      res.status(401).json({ error: "not authenticated" });
      return undefined;
    }
    return account;
  }

  async function resolveProductForRun(orgId: string, rawProductId: unknown, clientId?: string): Promise<ProductProfile | undefined> {
    if (typeof rawProductId !== "string" || !rawProductId.trim()) return undefined;
    const product = await tenantProfiles.productGet(orgId, rawProductId);
    if (!product) throw new Error("product not found");
    if (clientId && product.clientId && product.clientId !== clientId) throw new Error("product is not assigned to this client");
    return product;
  }
  const CREATOR_IMAGE_VENDORS = new Set(["higgsfield", "gemini", "replicate"]);
  async function resolveCreatorForRun(orgId: string, rawCreatorId: unknown, clientId?: string, videoVendor?: string): Promise<CreatorProfile | undefined> {
    if (rawCreatorId === undefined || rawCreatorId === null || rawCreatorId === "") return undefined;
    if (typeof rawCreatorId !== "string") throw new Error("creatorProfileId must be a string");
    const creator = await tenantProfiles.creatorGet(orgId, rawCreatorId);
    if (!creator || !creator.active) throw new Error("creator profile not found or inactive");
    if (creator.clientId && clientId && creator.clientId !== clientId) throw new Error("creator profile does not belong to this client");
    if (videoVendor && creator.compatibleVendors.length > 0 && !creator.compatibleVendors.includes(videoVendor as CreatorProfile["compatibleVendors"][number])) throw new Error(`creator profile is not compatible with ${videoVendor}`);
    if (videoVendor && creator.preferredVideoVendor && creator.preferredVideoVendor !== videoVendor) throw new Error(`creator profile requires preferred vendor ${creator.preferredVideoVendor}`);
    return CreatorProfileSchema.parse(creator);
  }
  const publicCreator = (creator: CreatorProfile) => ({ ...creator, referenceImages: creator.referenceImages.map(({ filePath: _filePath, ...image }) => image) });
  const resolveTemplate = (raw: unknown) => { if (!raw) return undefined; if (typeof raw !== "string") throw new Error("templateId must be a string"); const template = getUgcTemplate(raw); if (!template) throw new Error("template not found"); return template; };
  const publicProduct = (product: ProductProfile) => ({ ...product, productImages: product.productImages.map(({ filePath: _filePath, ...image }) => image) });
  const creatorPreflight = (creator: CreatorProfile, videoVendor: string) => {
    const warnings: string[] = [];
    if (creator.referenceImages.length > 0 && !CREATOR_IMAGE_VENDORS.has(videoVendor)) warnings.push(`${videoVendor} does not accept creator reference images; generation will use text guidance only`);
    if (creator.avatarMode === "vendor_avatar" && videoVendor !== "higgsfield") warnings.push(`${videoVendor} does not provide persistent creator identity; avatar consistency is not guaranteed`);
    if (creator.compatibleVendors.length > 0 && !creator.compatibleVendors.includes(videoVendor as CreatorProfile["compatibleVendors"][number])) warnings.push(`creator profile is not marked compatible with ${videoVendor}`);
    if (creator.preferredVideoVendor && creator.preferredVideoVendor !== videoVendor) warnings.push(`creator profile prefers ${creator.preferredVideoVendor}`);
    return { vendor: videoVendor, warnings, blocking: creator.compatibleVendors.length > 0 && !creator.compatibleVendors.includes(videoVendor as CreatorProfile["compatibleVendors"][number]) || Boolean(creator.preferredVideoVendor && creator.preferredVideoVendor !== videoVendor) };
  };

  // Built-ins are globally defined, but discovery and preview remain authenticated so
  // the endpoint cannot become an anonymous product/creator-profile oracle.
  app.get("/templates", requireSession, (req: AuthedRequest, res: Response) => {
    if (!requireAccount(req, res)) return;
    res.json({ templates: BUILTIN_UGC_TEMPLATES });
  });
  app.get("/templates/:id", requireSession, (req: AuthedRequest, res: Response) => {
    if (!requireAccount(req, res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const template = getUgcTemplate(id);
    if (!template) return res.status(404).json({ error: "template not found" });
    res.json({ template });
  });
  // Curated presets — same globally-defined-but-authenticated shape as templates
  // above. Optional ?category= filter matches PresetCategory values.
  app.get("/presets", requireSession, (req: AuthedRequest, res: Response) => {
    if (!requireAccount(req, res)) return;
    const rawCategory = typeof req.query.category === "string" ? req.query.category : undefined;
    if (rawCategory && !(PRESET_CATEGORY_IDS as readonly string[]).includes(rawCategory)) {
      return res.status(400).json({ error: `unknown category "${rawCategory}"`, validCategories: PRESET_CATEGORY_IDS });
    }
    const presets = rawCategory ? listPresetsByCategory(rawCategory as Preset["category"]) : BUILTIN_PRESETS;
    res.json({ presets });
  });
  app.get("/presets/:id", requireSession, (req: AuthedRequest, res: Response) => {
    if (!requireAccount(req, res)) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const preset = getPreset(id);
    if (!preset) return res.status(404).json({ error: "preset not found" });
    res.json({ preset });
  });
  // Product/UX usage analytics (@vvugc/shared-product-analytics) — distinct from the
  // published-content performance loop in @vvugc/shared-analytics. orgId/accountId are
  // ALWAYS server-derived from the session, never trusted from the request body — a
  // client can only ever record events under its own org, so the worst a buggy/malicious
  // client can do is pollute its own org's usage counts, never another org's or anything
  // with real business consequences (this is telemetry, not an authorization boundary).
  app.post("/accounts/analytics/event", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const parsedType = ProductEventTypeSchema.safeParse(req.body?.eventType);
    if (!parsedType.success) {
      return res.status(400).json({ error: "invalid or missing eventType", validEventTypes: ProductEventTypeSchema.options });
    }
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined;
    try {
      const event = productEvents.record({ orgId: resolveOrgId(account), accountId: account.id, eventType: parsedType.data, meta });
      res.status(201).json({ event });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "failed to record event" });
    }
  });
  // Usage summary for the caller's own org — ?days= (default 30) sets the
  // activeAccountCount window; totals/mostUsedFeatures always cover all recorded history.
  app.get("/accounts/analytics/summary", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const events = productEvents.listByOrg(resolveOrgId(account));
    res.json(summarizeUsage(events, sinceMs));
  });
  app.post("/accounts/preview-template", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const templateId = req.body?.templateId;
    if (typeof templateId !== "string" || !templateId.trim()) return res.status(400).json({ error: "templateId is required" });
    const template = getUgcTemplate(templateId);
    if (!template) return res.status(404).json({ error: "template not found" });
    const platformResult = PlatformSchema.array().min(1).safeParse(req.body?.platforms ?? ["tiktok"]);
    if (!platformResult.success) return res.status(400).json({ error: "platforms must be a non-empty list of supported platforms" });
    const durationSec = typeof req.body?.durationSec === "number" ? req.body.durationSec : template.recommendedDurationSec;
    if (!Number.isInteger(durationSec) || durationSec < 15 || durationSec > 60) return res.status(400).json({ error: "durationSec must be an integer from 15 to 60" });
    const orgId = resolveOrgId(account);
    const productId = typeof req.body?.productProfileId === "string" ? req.body.productProfileId : undefined;
    const creatorId = typeof req.body?.creatorProfileId === "string" ? req.body.creatorProfileId : undefined;
    const product = productId ? await tenantProfiles.productGet(orgId, productId) : undefined;
    const creator = creatorId ? await tenantProfiles.creatorGet(orgId, creatorId) : undefined;
    if (productId && !product) return res.status(404).json({ error: "product not found" });
    if (creatorId && !creator) return res.status(404).json({ error: "creator profile not found" });
    const hasBrandVoice = typeof req.body?.brandVoice === "string" && req.body.brandVoice.trim().length > 0;
    const inputPresent: Record<string, boolean> = { productProfile: Boolean(product), creatorProfile: Boolean(creator), brandKit: Boolean(req.body?.brandKit), brandVoice: hasBrandVoice };
    const requiredInputs = template.requiredInputs.map((input) => ({ input, present: inputPresent[input] ?? false }));
    const missingFields = requiredInputs.filter(({ present }) => !present).map(({ input }) => input);
    // This route deliberately reads only tenant-scoped profiles and computes data in
    // memory: no run is created and no LLM/video/caption vendor is called.
    res.json({ template, compatibilityWarnings: templateCompatibility(template, platformResult.data, durationSec), requiredInputs, missingFields, plannedScriptBeats: template.scriptStructure });
  });

  /** Resolves the account and 403s if its role lacks the given permission. Returns the
   *  account (so callers can fall through to using it) or undefined after writing the
   *  error response. Every mutation route gates through this — the UI hides what a role
   *  can't do, but a direct API hit gets a real 403, not just a hidden button. */
  function requirePermission(permission: AccountPermission): (req: AuthedRequest, res: Response) => Account | undefined {
    return (req, res) => {
      const account = requireAccount(req, res);
      if (!account) return undefined;
      if (!roleHasPermission(account.role, permission)) {
        res.status(403).json({ error: `requires the ${permission} permission` });
        return undefined;
      }
      return account;
    };
  }

  const clientIp = (req: Request): string | undefined => {
    const forwarded = req.headers["x-forwarded-for"];
    return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
  };

  app.post("/accounts/signup", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { email, password, orgName } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    let account;
    try {
      account = await identity.signUp(email, password, typeof orgName === "string" ? orgName : undefined);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    const session = await identity.createSession(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    writeSecurityEvent({
      type: "account.created",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "role: owner (org creator)"
    });
    res.status(201).json({ account: toPublicAccount(account), csrfToken: csrfTokenFor(session.token) });
  }));

  app.post("/accounts/login", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    const account = await identity.authenticate(email, password);
    if (!account) {
      writeSecurityEvent({ type: "login.failed", email, ip: clientIp(req) });
      return res.status(401).json({ error: "invalid email or password" });
    }

    // Step one of a two-step login when the account has two-factor enabled: the
    // password is correct, but instead of a session the client gets a short-lived,
    // single-use challenge token it must redeem with a valid TOTP code (see
    // POST /accounts/mfa/challenge). No session cookie is set here — knowing the
    // password alone no longer grants access to an MFA-protected account.
    const mfa = await identity.getMfa(account.id);
    if (mfa?.confirmedAt) {
      const challenge = await identity.createMfaChallenge(account.id);
      writeSecurityEvent({
        type: "login.mfa_challenge",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req)
      });
      return res.json({ mfaRequired: true, mfaToken: challenge.token, expiresAt: challenge.expiresAt });
    }

    const session = await identity.createSession(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    writeSecurityEvent({
      type: "login.succeeded",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ account: toPublicAccount(account), csrfToken: csrfTokenFor(session.token) });
  }));

  // Step two of an MFA login: redeem the challenge token from /accounts/login
  // with the account's current authenticator code. The challenge is single-use
  // (consumed by this handler whether it succeeds or fails), so a leaked token
  // can't be brute-forced — each attempt needs a fresh challenge. Public (no
  // session cookie exists yet at this point in the flow).
  app.post("/accounts/mfa/challenge", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { mfaToken, code } = req.body ?? {};
    if (typeof mfaToken !== "string" || typeof code !== "string") {
      return res.status(400).json({ error: "mfaToken and code are required" });
    }
    const challenge = await identity.consumeMfaChallenge(mfaToken);
    if (!challenge) return res.status(400).json({ error: "MFA challenge is invalid or has expired — log in again" });
    const account = await identity.findById(challenge.accountId);
    const mfa = account ? await identity.getMfa(account.id) : undefined;
    if (!account || !mfa?.confirmedAt) {
      return res.status(400).json({ error: "MFA is not enabled for this account" });
    }
    if (!verifyTotpCode(mfa.secret, code)) {
      writeSecurityEvent({
        type: "login.mfa_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req)
      });
      return res.status(401).json({ error: "invalid authentication code" });
    }
    const session = await identity.createSession(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    writeSecurityEvent({
      type: "login.mfa_succeeded",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ account: toPublicAccount(account), csrfToken: csrfTokenFor(session.token) });
  }));

  app.post("/accounts/logout", requireSession, asyncHandler(async (req: Request, res: Response) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await identity.revokeSession(token);
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  }));

  app.get("/accounts/me", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    res.json({
      account: toPublicAccount(account),
      csrfToken: sessionToken ? csrfTokenFor(sessionToken) : undefined,
      mfaEnabled: Boolean((await identity.getMfa(account.id))?.confirmedAt)
    });
  }));

  app.get("/accounts/usage", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json(aggregateUsage(resolveOrgId(account), VVUGC_RUNS_DIR));
  });

  app.get("/accounts/settings", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json(await tenantProfiles.settingsGet(resolveOrgId(account)));
  }));

  app.put("/accounts/settings", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("settings.manage")(req, res);
    if (!account) return;
    const parsed = SettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    res.json(await tenantProfiles.settingsUpsert(resolveOrgId(account), parsed.data as AccountSettingsInput));
  }));

  // Dedicated, minimal app-mode toggle. The full PUT above re-validates the entire
  // settings shape with SettingsInputSchema (niche: min(1)), which 400s for a fresh
  // account whose niche is still "" and has no niche editor yet. This route does a
  // server-side merge instead: it reads the current stored settings (already a valid
  // AccountSettings — niche may be "", and settingsUpsert does not re-run
  // SettingsInputSchema) and overrides only appMode.
  app.put("/accounts/settings/app-mode", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("settings.manage")(req, res);
    if (!account) return;
    const parsed = AppModeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const orgId = resolveOrgId(account);
    const current = await tenantProfiles.settingsGet(orgId);
    const { accountId: _accountId, updatedAt: _updatedAt, ...rest } = current;
    const saved = await tenantProfiles.settingsUpsert(orgId, { ...rest, appMode: parsed.data.appMode });
    res.json(saved);
  }));

  app.get("/accounts/clients", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({ clients: await tenantProfiles.clientList(resolveOrgId(account)) });
  }));

  app.get("/accounts/social-connections", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    if (clientId && !await tenantProfiles.clientGet(resolveOrgId(account), clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.json({ connections: await tenantProfiles.socialList(resolveOrgId(account), clientId) });
  }));

  app.post("/accounts/social-connections", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const parsed = z.object({
      clientId: z.string().min(1),
      platform: PlatformSchema,
      accountLabel: z.string().trim().min(1).max(200),
      providerAccountId: z.string().trim().min(1).max(200).optional(),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      expiresAt: z.string().datetime().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid social connection" });
    if (!await tenantProfiles.clientGet(resolveOrgId(account), parsed.data.clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.status(201).json({ connection: await tenantProfiles.socialConnect(resolveOrgId(account), parsed.data) });
  }));

  app.delete("/accounts/social-connections/:id", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!await tenantProfiles.socialDisconnect(resolveOrgId(account), id)) return res.status(404).json({ error: "connection not found" });
    res.status(204).end();
  }));

  app.post("/accounts/clients/:clientId/oauth/google/start", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("social.manage")(req, res);
    if (!account) return;
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    const orgId = resolveOrgId(account);
    if (!await tenantProfiles.clientGet(orgId, clientId)) return res.status(404).json({ error: "client not found" });
    const env = loadEnv();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.OAUTH_STATE_SECRET) {
      return res.status(503).json({ error: "Google OAuth is not configured" });
    }
    const created = createGoogleOAuthState(orgId, clientId, env.OAUTH_STATE_SECRET);
    await identity.addOAuthNonce(created.value.nonce);
    res.json({
      authorizationUrl: googleAuthorizationUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
        state: created.state
      })
    });
  }));

  app.get(
    "/oauth/google/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const env = loadEnv();
      if (!code || !state || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.OAUTH_STATE_SECRET) {
        return res.status(400).send("Google OAuth callback is incomplete");
      }
      const verified = verifyGoogleOAuthState(state, env.OAUTH_STATE_SECRET);
      if (!verified || !(await identity.consumeOAuthNonce(verified.nonce))) return res.status(400).send("OAuth state is invalid, expired, or already used");
      if (!await tenantProfiles.clientGet(verified.orgId, verified.clientId)) return res.status(404).send("Client not found");
      const tokens = await exchangeGoogleAuthorizationCode({
        code,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI
      });
      const channel = await fetchGoogleYouTubeChannel(tokens.accessToken);
      const connection = {
        clientId: verified.clientId,
        platform: "youtube_shorts" as const,
        accountLabel: channel.label,
        providerAccountId: channel.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt
      };
      await tenantProfiles.socialConnect(verified.orgId, connection);
      // Return to the SPA's client brand page — that's where the Publishing
      // panel that started this flow lives, so the confirmation notice shows up
      // exactly where the user clicked "Connect YouTube".
      res.redirect(`/app/brand/clients/${encodeURIComponent(verified.clientId)}?oauth=google-connected`);
    })
  );

  // SSE endpoint for real-time pipeline progress events.
  // The client connects once a run starts and receives stage-by-stage updates.
  // Org-scoped: a run only streams for the org that owns it (defense-in-depth on
  // top of the session check) — another tenant's runId answers 404, not a stream.
  app.get(
    "/accounts/run-progress/:runId",
    requireSession,
    asyncHandler<{ runId: string }>(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res)
      if (!account) return
      const orgId = resolveOrgId(account)
      const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId
      const owned = (await jobStore.list(orgId)).some((j) => j.config?.runId === runId)
      if (!owned) return res.status(404).json({ error: "run not found" })
      sseProgressHandler(req, res)
    })
  );

  app.post(
    "/accounts/clients/:clientId/acceptance",
    requireSession,
    runRateLimiter,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
      const orgId = resolveOrgId(account);
      const client = await tenantProfiles.clientGet(orgId, clientId);
      if (!client) return res.status(404).json({ error: "client not found" });
      const live = req.body?.live === true;
      // Dry-run acceptance is free and safe; a live run spends a real (potentially paid)
      // vendor chain, so it's gated by the stricter permission.
      if (!roleHasPermission(account.role, live ? "pipeline.run.live" : "pipeline.run")) {
        return res.status(403).json({ error: live ? "requires the pipeline.run.live permission" : "requires the pipeline.run permission" });
      }
      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        orgId,
        accountId: orgId,
        clientId,
        niche: client.niche,
        brandVoice: client.brandVoice,
        brandKit: client.brandKit,
        locale: client.locale,
        platforms: client.platforms,
        targetDurationSec: client.targetDurationSec,
        videoVendor: client.videoVendor,
        voiceVendor: client.voiceVendor,
        dryRun: !(live && isLLMLive()),
        createdAt: new Date().toISOString()
      });
      const evidence = await runAcceptance(config, { onProgress: () => { } });
      res.status(evidence.passed ? 200 : 422).json(evidence);
    })
  );

  app.get("/accounts/jobs", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    if (clientId && !await tenantProfiles.clientGet(resolveOrgId(account), clientId)) return res.status(404).json({ error: "client not found" });
    res.json({ jobs: await jobStore.list(resolveOrgId(account), clientId) });
  });

  app.post("/accounts/jobs", requireSession, runRateLimiter, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("pipeline.run")(req, res);
    if (!account) return;
    const orgId = resolveOrgId(account);
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : "";
    const client = await tenantProfiles.clientGet(orgId, clientId);
    if (!client || !client.active) return res.status(404).json({ error: "client not found" });

    const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : randomUUID();
    const runId = typeof req.body?.runId === "string" ? req.body.runId : runIdForIdempotency(orgId, idempotencyKey);
    const config = RunConfigSchema.parse({
      runId,
      orgId,
      accountId: orgId,
      clientId,
      niche: client.niche,
      platforms: client.platforms,
      brandVoice: client.brandVoice,
      brandKit: client.brandKit,
      locale: client.locale,
      targetDurationSec: client.targetDurationSec,
      videoVendor: client.videoVendor,
      voiceVendor: client.voiceVendor,
      dryRun: !isRealRun(req),
      createdAt: new Date().toISOString()
    });
    // Reserve before enqueueing: a concurrent worker cannot both consume the
    // final included slot. The same run id makes client retries idempotent.
    await billing.reserveRun({ orgId, runId, clientId, durationSec: config.targetDurationSec, usageRunCount: aggregateUsage(orgId, VVUGC_RUNS_DIR).runs.length });
    let job;
    try { job = await jobStore.enqueue(orgId, clientId, config, idempotencyKey); }
    catch (error) { await billing.releaseReservation({ orgId, runId }); throw error; }
    res.status(job.status === "queued" ? 202 : 200).json({ job });
  });

  app.get("/accounts/jobs/:id", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await jobStore.get(resolveOrgId(account), id);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({ job });
  });

  app.delete("/accounts/jobs/:id", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("jobs.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Distinguish "no such job in your org" (404) from "your job, but it can't be
    // cancelled in its current state" (409) — without the pre-check, another tenant's
    // job id would answer 409 and reveal that an id exists somewhere in the store.
    const job = await jobStore.get(resolveOrgId(account), id);
    if (!job) {
      return res.status(404).json({ error: "job not found" });
    }
    if (!await jobStore.cancel(resolveOrgId(account), id)) return res.status(409).json({ error: "job cannot be cancelled" });
    if (job.status === "queued") await billing.releaseReservation({ orgId: resolveOrgId(account), runId: job.config.runId });
    res.status(204).end();
  });

  app.post("/accounts/jobs/:id/replay", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("jobs.manage")(req, res);
    if (!account) return;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Same 404-vs-409 split as DELETE above — another tenant's job must read as
    // "not found", not "exists but isn't replayable".
    if (!await jobStore.get(resolveOrgId(account), id)) {
      return res.status(404).json({ error: "job not found" });
    }
    const job = await jobStore.replay(resolveOrgId(account), id);
    if (!job) return res.status(409).json({ error: "only a dead-letter job can be replayed" });
    res.json({ job });
  });

  app.post("/accounts/clients", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ClientInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    res.status(201).json({ client: await tenantProfiles.clientCreate(resolveOrgId(account), parsed.data as AgencyClientInput) });
  });

  app.put("/accounts/clients/:clientId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ClientInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    }
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    const client = await tenantProfiles.clientUpdate(resolveOrgId(account), clientId, parsed.data as AgencyClientInput);
    if (!client) return res.status(404).json({ error: "client not found" });
    res.json({ client });
  });

  app.delete("/accounts/clients/:clientId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const clientId = Array.isArray(req.params.clientId) ? req.params.clientId[0] : req.params.clientId;
    if (!await tenantProfiles.clientArchive(resolveOrgId(account), clientId)) {
      return res.status(404).json({ error: "client not found" });
    }
    res.status(204).end();
  });

  // Product profiles are reusable, tenant-scoped inputs to the content pipeline.
  app.get("/accounts/products", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    if (clientId && !await tenantProfiles.clientGet(resolveOrgId(account), clientId)) return res.status(404).json({ error: "client not found" });
    res.json({ products: (await tenantProfiles.productList(resolveOrgId(account), clientId)).map(publicProduct) });
  });

  app.get("/accounts/products/:productId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    const product = await tenantProfiles.productGet(resolveOrgId(account), productId);
    if (!product) return res.status(404).json({ error: "product not found" });
    res.json({ product: publicProduct(product) });
  });

  app.post("/accounts/products", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    const orgId = resolveOrgId(account);
    if (parsed.data.clientId && !await tenantProfiles.clientGet(orgId, parsed.data.clientId)) return res.status(404).json({ error: "client not found" });
    res.status(201).json({ product: publicProduct(await tenantProfiles.productCreate(orgId, parsed.data)) });
  });

  app.put("/accounts/products/:productId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const parsed = ProductInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    const orgId = resolveOrgId(account);
    if (parsed.data.clientId && !await tenantProfiles.clientGet(orgId, parsed.data.clientId)) return res.status(404).json({ error: "client not found" });
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    const product = await tenantProfiles.productUpdate(orgId, productId, parsed.data);
    if (!product) return res.status(404).json({ error: "product not found" });
    res.json({ product: publicProduct(product) });
  });

  app.delete("/accounts/products/:productId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    if (!await tenantProfiles.productArchive(resolveOrgId(account), productId)) return res.status(404).json({ error: "product not found" });
    res.status(204).end();
  });

  app.post("/accounts/products/ingest-url", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl.trim() : "";
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl is required" });
    const orgId = resolveOrgId(account);
    if (clientId && !await tenantProfiles.clientGet(orgId, clientId)) return res.status(404).json({ error: "client not found" });
    try {
      const page = await fetchExternalBytes(sourceUrl, MAX_PRODUCT_HTML_BYTES, (contentType) => contentType === "text/html" || contentType === "application/xhtml+xml");
      const fields = extractProductFields(page.bytes.toString("utf8"), page.finalUrl);
      const product = await tenantProfiles.productCreate(orgId, {
        name: fields.name ?? new URL(page.finalUrl).hostname,
        canonicalUrl: page.finalUrl,
        clientId,
        description: fields.description ?? "",
        shortDescription: fields.shortDescription ?? "",
        productCategory: "",
        targetCustomer: fields.targetCustomer ?? "",
        customerPain: "",
        primaryBenefits: fields.primaryBenefits ?? [],
        features: [],
        claims: fields.claims ?? [],
        forbiddenClaims: [],
        differentiators: [],
        callToAction: fields.callToAction ?? "Learn more",
        extractedSourceText: fields.extractedSourceText,
        extractedImageUrls: fields.extractedImageUrls ?? [],
        extractionStatus: "complete"
      });
      res.status(201).json({ product: publicProduct(product) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "product URL ingestion failed" });
    }
  }));

  app.post("/accounts/products/:productId/images", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    const product = await tenantProfiles.productGet(resolveOrgId(account), productId);
    if (!product) return res.status(404).json({ error: "product not found" });
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 160) : "product-image";
    const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType : "";
    const data = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64 : "";
    const extension = PRODUCT_IMAGE_MIME.get(mimeType);
    if (!extension || !data) return res.status(400).json({ error: "a JPEG, PNG, or WebP dataBase64 image is required" });
    let bytes: Buffer;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return res.status(400).json({ error: "invalid base64 image" });
    try { bytes = Buffer.from(data, "base64"); } catch { return res.status(400).json({ error: "invalid base64 image" }); }
    if (bytes.length === 0 || bytes.length > MAX_PRODUCT_IMAGE_BYTES) return res.status(400).json({ error: "image must be between 1 byte and 2MB" });
    const magicOk = (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) || (mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || (mimeType === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
    if (!magicOk) return res.status(400).json({ error: "image bytes do not match the declared MIME type" });
    const imageId = randomUUID();
    const relativePath = join("product-assets", resolveOrgId(account), productId, `${imageId}${extension}`);
    const absolutePath = join(VVUGC_RUNS_DIR, relativePath);
    mkdirSync(join(VVUGC_RUNS_DIR, "product-assets", resolveOrgId(account), productId), { recursive: true });
    writeFileSync(absolutePath, bytes, { mode: 0o600 });
    const image = ProductImageSchema.parse({ id: imageId, fileName: fileName || `product-image${extension}`, mimeType, filePath: relativePath, createdAt: new Date().toISOString() });
    const updated = await tenantProfiles.productAddImage(resolveOrgId(account), productId, image);
    if (!updated) { unlinkSync(absolutePath); return res.status(409).json({ error: "product has reached its image limit" }); }
    res.status(201).json({ product: publicProduct(updated) });
  });

  app.delete("/accounts/products/:productId/images/:imageId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res);
    if (!account) return;
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    const imageId = Array.isArray(req.params.imageId) ? req.params.imageId[0] : req.params.imageId;
    const removed = await tenantProfiles.productRemoveImage(resolveOrgId(account), productId, imageId);
    if (!removed) return res.status(404).json({ error: "image not found" });
    const absolutePath = join(VVUGC_RUNS_DIR, removed.filePath);
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
    res.status(204).end();
  });

  app.get("/accounts/products/:productId/images/:imageId", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
    const imageId = Array.isArray(req.params.imageId) ? req.params.imageId[0] : req.params.imageId;
    const product = await tenantProfiles.productGet(resolveOrgId(account), productId);
    const image = product?.productImages.find((entry) => entry.id === imageId);
    if (!image) return res.status(404).end();
    const absolutePath = join(VVUGC_RUNS_DIR, image.filePath);
    if (!existsSync(absolutePath)) return res.status(404).end();
    res.type(image.mimeType).set("Content-Disposition", "inline").sendFile(absolutePath);
  });

  app.get("/accounts/creators", requireSession, async (req: AuthedRequest, res: Response) => { const account = requireAccount(req, res); if (!account) return; const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined; res.json({ creators: (await tenantProfiles.creatorList(resolveOrgId(account), clientId)).map(publicCreator) }); });
  app.post("/accounts/creators", requireSession, async (req: AuthedRequest, res: Response) => { const account = requirePermission("clients.manage")(req, res); if (!account) return; const parsed = CreatorInputSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.message }); const orgId = resolveOrgId(account); if (parsed.data.clientId && !await tenantProfiles.clientGet(orgId, parsed.data.clientId)) return res.status(404).json({ error: "client not found" }); if (parsed.data.avatarMode !== "none" && !parsed.data.consentConfirmed) return res.status(400).json({ error: "explicit consent is required for reference images" }); const consent = parsed.data.consentConfirmed ? { consentConfirmedAt: new Date().toISOString(), consentConfirmedBy: req.auditActor ?? `account:${account.id}` } : {}; res.status(201).json({ creator: publicCreator(await tenantProfiles.creatorCreate(orgId, { ...parsed.data, ...consent })) }); });
  app.get("/accounts/creators/:creatorId", requireSession, async (req: AuthedRequest, res: Response) => { const account = requireAccount(req, res); if (!account) return; const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const creator = await tenantProfiles.creatorGet(resolveOrgId(account), id); if (!creator) return res.status(404).json({ error: "creator not found" }); res.json({ creator: publicCreator(creator) }); });
  app.get("/accounts/creators/:creatorId/preflight", requireSession, async (req: AuthedRequest, res: Response) => { const account = requireAccount(req, res); if (!account) return; const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const creator = await tenantProfiles.creatorGet(resolveOrgId(account), id); if (!creator) return res.status(404).json({ error: "creator not found" }); const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined; const client = clientId ? await tenantProfiles.clientGet(resolveOrgId(account), clientId) : undefined; if (clientId && !client) return res.status(404).json({ error: "client not found" }); const videoVendor = typeof req.query.videoVendor === "string" ? req.query.videoVendor : client?.videoVendor ?? "higgsfield"; const result = creatorPreflight(creator, videoVendor); res.json({ creatorId: creator.id, ...result }); });
  app.put("/accounts/creators/:creatorId", requireSession, async (req: AuthedRequest, res: Response) => { const account = requirePermission("clients.manage")(req, res); if (!account) return; const parsed = CreatorInputSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.message }); const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const existing = await tenantProfiles.creatorGet(resolveOrgId(account), id); if (!existing) return res.status(404).json({ error: "creator not found" }); if ((parsed.data.avatarMode !== "none" || existing.referenceImages.length > 0) && !parsed.data.consentConfirmed) return res.status(400).json({ error: "explicit consent is required for reference images" }); const consent = parsed.data.consentConfirmed ? { consentConfirmedAt: new Date().toISOString(), consentConfirmedBy: req.auditActor ?? `account:${account.id}` } : {}; const creator = await tenantProfiles.creatorUpdate(resolveOrgId(account), id, { ...parsed.data, ...consent }); if (!creator) return res.status(404).json({ error: "creator not found" }); res.json({ creator: publicCreator(creator) }); });
  app.delete("/accounts/creators/:creatorId", requireSession, async (req: AuthedRequest, res: Response) => { const account = requirePermission("clients.manage")(req, res); if (!account) return; const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; if (!await tenantProfiles.creatorArchive(resolveOrgId(account), id)) return res.status(404).json({ error: "creator not found" }); res.status(204).end(); });
  app.post("/accounts/creators/:creatorId/images", requireSession, async (req: AuthedRequest, res: Response) => { const account = requirePermission("clients.manage")(req, res); if (!account) return; const orgId = resolveOrgId(account); const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const existingCreator = await tenantProfiles.creatorGet(orgId, id); if (!existingCreator) return res.status(404).json({ error: "creator not found" }); if (!existingCreator.consentConfirmed || !existingCreator.consentConfirmedAt || !existingCreator.consentConfirmedBy) return res.status(400).json({ error: "audited explicit consent is required before uploading reference images" }); const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType : ""; const data = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64 : ""; const extension = PRODUCT_IMAGE_MIME.get(mimeType); if (!extension || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return res.status(400).json({ error: "valid JPEG, PNG, or WebP base64 image required" }); const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > MAX_PRODUCT_IMAGE_BYTES) return res.status(400).json({ error: "image too large" }); const magicOk = (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) || (mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || (mimeType === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"); if (!magicOk) return res.status(400).json({ error: "image signature mismatch" }); const imageId = randomUUID(); const relativePath = join("creator-assets", orgId, id, `${imageId}${extension}`); mkdirSync(join(VVUGC_RUNS_DIR, "creator-assets", orgId, id), { recursive: true }); writeFileSync(join(VVUGC_RUNS_DIR, relativePath), bytes, { mode: 0o600 }); const image = CreatorReferenceImageSchema.parse({ id: imageId, fileName: typeof req.body?.fileName === "string" ? req.body.fileName.slice(0, 160) || "reference-image" : "reference-image", mimeType, filePath: relativePath, createdAt: new Date().toISOString() }); const creator = await tenantProfiles.creatorAddImage(orgId, id, image); if (!creator) { unlinkSync(join(VVUGC_RUNS_DIR, relativePath)); return res.status(409).json({ error: "reference image limit reached" }); } res.status(201).json({ creator: publicCreator(creator) }); });
  app.delete("/accounts/creators/:creatorId/images/:imageId", requireSession, async (req: AuthedRequest, res: Response) => { const account = requirePermission("clients.manage")(req, res); if (!account) return; const orgId = resolveOrgId(account); const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const imageId = Array.isArray(req.params.imageId) ? req.params.imageId[0] : req.params.imageId; const removed = await tenantProfiles.creatorRemoveImage(orgId, id, imageId); if (!removed) return res.status(404).end(); const path = join(VVUGC_RUNS_DIR, removed.filePath); if (existsSync(path)) unlinkSync(path); res.status(204).end(); });
  app.get("/accounts/creators/:creatorId/images/:imageId", requireSession, async (req: AuthedRequest, res: Response) => { const account = requireAccount(req, res); if (!account) return; const id = Array.isArray(req.params.creatorId) ? req.params.creatorId[0] : req.params.creatorId; const imageId = Array.isArray(req.params.imageId) ? req.params.imageId[0] : req.params.imageId; const image = (await tenantProfiles.creatorGet(resolveOrgId(account), id))?.referenceImages.find((v) => v.id === imageId); if (!image) return res.status(404).end(); const path = join(VVUGC_RUNS_DIR, image.filePath); if (!existsSync(path)) return res.status(404).end(); res.type(image.mimeType).set("Content-Disposition", "inline").sendFile(path); });

  // Character Builder — "generate a person from scratch," a standalone flow separate from
  // the main discover->script->video pipeline (see mcp-video-gen/src/character-builder.ts's
  // own doc comment). Stateless: doesn't touch the creator store at all, just returns
  // candidate portrait images for the client to preview; the client then hands its chosen
  // one(s) to the EXISTING POST /accounts/creators + POST /accounts/creators/:id/images
  // routes above, same as if the user had uploaded their own photo. Gated on the same
  // "clients.manage" permission as creator mutation, since this is real Gemini API spend.
  app.post("/accounts/character-builder/generate", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("clients.manage")(req, res); if (!account) return;
    const parsed = CharacterAttributesSchema.safeParse(req.body?.attributes);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const count = typeof req.body?.count === "number" ? req.body.count : undefined;
    try {
      const portraits = await generateCharacterPortraitBatch(parsed.data, { count });
      res.json({ portraits: portraits.map((p) => ({ index: p.index, prompt: p.prompt, mimeType: p.mimeType, dataBase64: p.imageBytes.toString("base64") })) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "character generation failed" });
    }
  });

  app.get(
    "/accounts/review-items",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
      if (clientId && !await tenantProfiles.clientGet(resolveOrgId(account), clientId)) {
        return res.status(404).json({ error: "client not found" });
      }
      const dryRunRaw = req.query.dryRun;
      const dryRun = dryRunRaw === "true" ? true : dryRunRaw === "false" ? false : undefined;
      res.json({
        items: await listReviewItems({
          orgId: resolveOrgId(account),
          clientId,
          dryRun
        })
      });
    })
  );

  app.get(
    "/accounts/review-items/:id",
    requireSession,
    asyncHandler<{ id: string }>(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const itemId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const item = await getReviewItem(itemId);
      if (!item || item.orgId !== resolveOrgId(account)) return res.status(404).json({ error: "review item not found" });
      res.json({ item });
    })
  );

  for (const status of ["approved", "rejected"] as const) {
    app.post(
      `/accounts/review-items/:id/${status === "approved" ? "approve" : "reject"}`,
      requireSession,
      asyncHandler<{ id: string }>(async (req: AuthedRequest, res: Response) => {
        const account = requirePermission("review.manage")(req, res);
        if (!account) return;
        const itemId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const item = await getReviewItem(itemId);
        if (!item || item.orgId !== resolveOrgId(account)) {
          return res.status(404).json({ error: "review item not found" });
        }
        await setReviewItemStatus(item.id, status);
        res.json({ id: item.id, status });
      })
    );
  }

  // Self-service "Run now" — builds a RunConfig from the org's saved settings and runs
  // the real pipeline (discovery -> transcript -> script -> video-gen -> assembly -> QA ->
  // review queue), tagged with the org's id so it shows up in every member's usage view
  // and review items are attributable to the org, not just whichever member clicked
  // the button. Defaults to --dry-run (safe, no vendor credentials needed) unless the
  // caller explicitly asks for a live run — mirrors the CLI's own default posture.
  app.post(
    "/accounts/run/quote",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requirePermission("pipeline.run.live")(req, res);
      if (!account) return;
      const parsed = LiveRunQuoteInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });

      const orgId = resolveOrgId(account);
      // clientGet is tenant-scoped, so an ID from another org is intentionally
      // indistinguishable from an unknown ID.
      const client = await tenantProfiles.clientGet(orgId, parsed.data.clientId);
      if (!client) return res.status(404).json({ error: "client not found" });
      if (!client.active) return res.status(409).json({ error: "client is archived" });

      let template;
      try { template = resolveTemplate(parsed.data.templateId); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "invalid template" }); }

      // The live pipeline reads vendor selections from the persisted client.
      // Deliberately do the same here: a caller cannot receive a quote for a
      // transient selection that /accounts/run would ignore.
      const videoVendor = client.videoVendor as CostVendor;
      const voiceVendor = client.voiceVendor;
      // Freeform scripts produce hook + 2--4 points + CTA. Templates declare
      // their exact beat count and therefore their exact clips per platform.
      const clipsPerCandidate = template ? template.scriptStructure.length : 4;
      const maximumClipsPerCandidate = template ? clipsPerCandidate : 6;
      const platformCount = client.platforms.length;
      const minimumVideoVendorSpendUsd = estimateCostUsd(videoVendor, "clip", clipsPerCandidate * platformCount);
      const maximumVideoVendorSpendUsd = estimateCostUsd(videoVendor, "clip", maximumClipsPerCandidate * MAX_PLATFORM_VIDEOS_PER_FLOW);

      res.json(LiveRunQuoteResponseSchema.parse({
        currency: "USD",
        videoVendor,
        minimumVideoVendorSpendUsd,
        maximumVideoVendorSpendUsd,
        clipsPerCandidate,
        maximumClipsPerCandidate,
        platformCount,
        minimumCandidateCount: 1,
        maximumPlatformVideosPerFlow: MAX_PLATFORM_VIDEOS_PER_FLOW,
        voiceover: voiceVendor ? { vendor: voiceVendor, cost: "variable" } : { cost: "not_selected" },
        notes: [
          "Minimum covers one generated candidate across the selected platforms.",
          `The pipeline caps platform videos at ${MAX_PLATFORM_VIDEOS_PER_FLOW}; the maximum uses that cap and ${maximumClipsPerCandidate} clips per platform video.`,
          "Voiceover cost is variable until captions determine the character count.",
          "This is estimated vendor spend only; subscription overages are separate."
        ]
      }));
    })
  );

  app.post(
    "/accounts/run",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const account = requirePermission("pipeline.run")(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);
      const requestedClientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
      const client = requestedClientId ? await tenantProfiles.clientGet(orgId, requestedClientId) : undefined;
      if (requestedClientId && !client) return res.status(404).json({ error: "client not found" });
      if (client && !client.active) return res.status(409).json({ error: "client is archived" });
      const legacySettings = await tenantProfiles.settingsGet(orgId);
      const settings = client ?? legacySettings;
      if (!settings.niche) return res.status(400).json({ error: "create a client before running" });
      let productProfile: ProductProfile | undefined;
      let creatorProfile: CreatorProfile | undefined;
      let template;
      try {
        productProfile = await resolveProductForRun(orgId, req.body?.productProfileId, client?.id);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "invalid product profile" });
      }
      try { creatorProfile = await resolveCreatorForRun(orgId, req.body?.creatorProfileId, client?.id, settings.videoVendor); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "invalid creator profile" }); }
      try { template = resolveTemplate(req.body?.templateId); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "invalid template" }); }
      // Allow dry-runs without a product profile; only block live runs that use a template requiring one.
      if (template?.requiredInputs.includes("productProfile") && !productProfile && !req.body?.dryRun) return res.status(400).json({ error: `${template.name} requires a product profile for live runs` });
      const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
      // Hybrid billing: past the tier's included runs, allow the run and record a
      // consumption-overage charge rather than hard-blocking with a 402.
      let isOverage = false;

      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        niche: settings.niche,
        platforms: settings.platforms,
        brandVoice: settings.brandVoice,
        targetDurationSec: settings.targetDurationSec,
        videoVendor: settings.videoVendor,
        voiceVendor: settings.voiceVendor,
        accountId: orgId,
        orgId,
        clientId: client?.id,
        productProfileId: productProfile?.id,
        productProfile,
        creatorProfileId: creatorProfile?.id,
        creatorProfile,
        templateId: template?.id,
        template,
        locale: client?.locale ?? "en",
        dryRun: !isRealRun(req),
        createdAt: new Date().toISOString()
      });

      const reservation = await billing.reserveRun({ orgId, runId: config.runId, clientId: client?.id, durationSec: config.targetDurationSec, usageRunCount: usage.runs.length });
      isOverage = reservation.kind === "overage";
      const onProgress = createProgressCallback(config.runId);
      let result;
      try { result = await runCycle(config, { onProgress }); }
      catch (error) { await billing.settleReservation({ orgId, runId: config.runId }); throw error; }
      completeRun(config.runId, true, { candidatesFound: result.candidatesFound, reviewItemsCreated: result.reviewItemsCreated });

      await billing.settleReservation({ orgId, runId: config.runId, estimatedVendorCostUsd: result.estimatedCostUsd });
      res.json({ ...result, templateId: template?.id, overage: isOverage ? { priceUsdPerRun: reservation.amountCents / 100 } : null });
    })
  );

  // ── First run (30-second happy path) ──────────────────────────────────────
  // POST /accounts/start builds a RunConfig from the org's client (auto-creating a
  // default one if the org has none) and ENQUEUES it for the background worker,
  // returning 202 with a runId + progressUrl so the SPA can land on
  // /app/studio/runs/:runId and watch live SSE. sourceUrl provided -> remix (skip
  // discovery); omitted -> discovery. Dry-run is the default; live needs the
  // pipeline.run.live permission.
  app.post(
    "/accounts/start",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const live = req.body?.live === true
      const account = live
        ? requirePermission("pipeline.run.live")(req, res)
        : requirePermission("pipeline.run")(req, res)
      if (!account) return
      const orgId = resolveOrgId(account)

      const niche = typeof req.body?.niche === "string" ? req.body.niche.trim() : ""
      const platformRaw = typeof req.body?.platform === "string" ? req.body.platform : undefined
      const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl : undefined
      if (sourceUrl && !parseSourceUrl(sourceUrl)) {
        return res.status(400).json({ error: "sourceUrl must be a TikTok, YouTube, or Instagram (Reels) link" })
      }
      // Optional riffed brief from the discovery panel. Typed loosely here; the
      // config stores it verbatim so the Studio can surface it on the run page.
      const briefRaw = req.body?.brief
      const brief = briefRaw && typeof briefRaw === "object" && !Array.isArray(briefRaw) ? briefRaw : undefined
      const validPlatforms = ["tiktok", "youtube_shorts", "instagram_reels"] as const
      const platforms =
        platformRaw && (validPlatforms as readonly string[]).includes(platformRaw)
          ? [platformRaw as (typeof validPlatforms)[number]]
          : undefined

      // Resolve or auto-create a default client so the first run needs zero setup.
      const existing = (await tenantProfiles.clientList(orgId))
      const fallbackPlatforms = existing[0]?.platforms
      const requestedClientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined
      const preClient = requestedClientId ? await tenantProfiles.clientGet(orgId, requestedClientId) : existing[0]
      const client = preClient ?? await tenantProfiles.clientCreate(orgId, {
        name: "Default Client",
        active: true,
        niche: niche || "general",
        brandVoice:
          typeof req.body?.brandVoice === "string" && req.body.brandVoice.trim()
            ? req.body.brandVoice
            : "Conversational, energetic, direct to camera",
        locale: "en",
        platforms: platforms ?? fallbackPlatforms ?? ["tiktok"],
        targetDurationSec: 30,
        videoVendor: "kling",
        voiceVendor: "elevenlabs",
        cadence: "weekly"
      })
      let productProfile: ProductProfile | undefined
      let creatorProfile: CreatorProfile | undefined
      let template
      try { template = resolveTemplate(req.body?.templateId) } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "invalid template" }) }
      try {
        productProfile = await resolveProductForRun(orgId, req.body?.productProfileId, client.id)
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "invalid product profile" })
      }
      try { creatorProfile = await resolveCreatorForRun(orgId, req.body?.creatorProfileId, client.id, client.videoVendor) } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "invalid creator profile" }) }
      // Downgraded: allow running without product profile (script-agent uses niche text as fallback)
      // if (template?.requiredInputs.includes("productProfile") && !productProfile) return res.status(400).json({ error: `${template.name} requires a product profile` })

      const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR)

      const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : randomUUID()
      const runId = runIdForIdempotency(orgId, idempotencyKey)
      const config = RunConfigSchema.parse({
        runId,
        orgId,
        accountId: orgId,
        clientId: client.id,
        niche: client.niche,
        platforms: client.platforms,
        brandVoice: client.brandVoice,
        targetDurationSec: client.targetDurationSec,
        videoVendor: client.videoVendor,
        voiceVendor: client.voiceVendor,
        locale: client.locale,
        brandKit: client.brandKit,
        productProfileId: productProfile?.id,
        productProfile,
        creatorProfileId: creatorProfile?.id,
        creatorProfile,
        templateId: template?.id,
        template,
        sourceUrl: sourceUrl ?? undefined,
        discoveryBrief: brief ?? null,
        dryRun: !(live && isLLMLive()),
        createdAt: new Date().toISOString()
      })

      await billing.reserveRun({ orgId, runId, clientId: client.id, durationSec: config.targetDurationSec, usageRunCount: usage.runs.length })
      let job
      try { job = await jobStore.enqueue(orgId, client.id, config, idempotencyKey) }
      catch (error) { await billing.releaseReservation({ orgId, runId }); throw error }
      res.status(202).json({
        job: { id: job.id, status: job.status },
        runId,
        progressUrl: `/api/accounts/run-progress/${runId}`,
        brief: config.discoveryBrief ?? undefined
      })
    })
  );

  // ── Discovery "what's working" + brief ─────────────────────────────────────
  // Finds viral videos in a niche, explains WHY each works from its metrics, and
  // synthesizes a riff-able brief the SPA can turn into a run. External discovery
  // can fail or return empty (no API keys, rate limits, offline) — that must
  // NEVER 500: we catch and fall back to a 200 with an empty video list and a
  // brief seeded from the niche text so the editor stays usable.
  app.post(
    "/accounts/discover",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const niche = typeof req.body?.niche === "string" ? req.body.niche.trim() : "";
      if (!niche) return res.status(400).json({ error: "niche required" });

      const validPlatforms = ["tiktok", "youtube_shorts", "instagram_reels"] as const;
      const platformRaw = typeof req.body?.platform === "string" ? req.body.platform : undefined;
      const platform = platformRaw && (validPlatforms as readonly string[]).includes(platformRaw)
        ? (platformRaw as (typeof validPlatforms)[number])
        : "tiktok";
      const limit = typeof req.body?.limit === "number" && Number.isFinite(req.body.limit) ? Math.min(Math.max(Math.trunc(req.body.limit), 1), 50) : 10;

      let candidates: CandidateVideo[] = [];
      // External discovery is OFF by default (governance): it only hits platform
      // APIs when VVUGC_DISCOVERY_LIVE=true. Otherwise we fall through to an empty
      // candidate list and the editor seeds a brief from the niche text — zero
      // external calls, zero 500s.
      if (isDiscoveryLive()) {
        try {
          candidates = await discoverPlatform(platform, niche, limit);
        } catch {
          candidates = [];
        }
      }
      if (!Array.isArray(candidates)) candidates = [];

      const payload = buildDiscoverResponse(candidates, niche);
      res.json(payload);
    })
  );

  // ── Trends (proactive discovery) ───────────────────────────────────────────
  // Aggregates niches + winning patterns from local history (clients + past run
  // manifests' riffed discovery briefs) so the Studio can proactively suggest
  // angles before the operator types anything. This is the offline stand-in for a
  // live trend API (Google Trends / platform signals) — those would upgrade
  // `source` to "live" and require external keys. Never 500s on missing data.
  app.get(
    "/accounts/trends",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);

      const niches = new Set<string>();
      for (const c of await tenantProfiles.clientList(orgId)) {
        if (c.niche && c.niche.trim()) niches.add(c.niche.trim());
      }

      const patternFreq = new Map<string, number>();
      const { VVUGC_RUNS_DIR } = loadEnv();
      if (existsSync(VVUGC_RUNS_DIR)) {
        for (const entry of readdirSync(VVUGC_RUNS_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const mp = join(VVUGC_RUNS_DIR, entry.name, "manifest.json");
          if (!existsSync(mp)) continue;
          try {
            const manifest = JSON.parse(readFileSync(mp, "utf-8"));
            const cfg = manifest?.config;
            if (cfg?.niche && typeof cfg.niche === "string") niches.add(cfg.niche.trim());
            const patterns = cfg?.discoveryBrief?.patterns;
            if (Array.isArray(patterns)) {
              for (const p of patterns) {
                if (typeof p === "string") patternFreq.set(p, (patternFreq.get(p) ?? 0) + 1);
              }
            }
          } catch {
            // malformed manifest — skip, never fatal
          }
        }
      }

      const suggestedNiches = [...niches].filter(Boolean).slice(0, 8);
      const suggestedAngles = [...patternFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([p]) => p);

      res.json({
        source: "local-history",
        suggestedNiches,
        suggestedAngles,
        note: "Local history only — connect a live trend source for real-time viral signals."
      });
    })
  );

  // ── Remix from URL ─────────────────────────────────────────────────────────
  // The "adapt a viral video to my niche" flow. The user pastes a TikTok / YouTube /
  // Instagram (Reels) link; we fetch its transcript, adapt it to the org's niche, and
  // (optionally) run the full pipeline on that single source. Two modes:
  //   previewOnly: true  → just the adapted script (one cheap LLM text call), so the
  //                        user can see the remix before committing to any video spend.
  //   previewOnly: false → full pipeline (captions → video → QA → review queue) from
  //                        that source, exactly one review item per target platform.
  // Reuses the exact same quota/overage billing as /accounts/run.
  app.post(
    "/accounts/remix",
    requireSession,
    runRateLimiter,
    asyncHandler<Record<string, string>>(async (req: AuthedRequest, res: Response) => {
      const account = requirePermission("pipeline.run")(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);

      const sourceUrl = req.body?.sourceUrl;
      if (typeof sourceUrl !== "string" || !parseSourceUrl(sourceUrl)) {
        return res.status(400).json({ error: "sourceUrl must be a TikTok, YouTube, or Instagram (Reels) link" });
      }

      const requestedClientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
      const client = requestedClientId ? await tenantProfiles.clientGet(orgId, requestedClientId) : undefined;
      if (requestedClientId && !client) return res.status(404).json({ error: "client not found" });
      if (client && !client.active) return res.status(409).json({ error: "client is archived" });
      const legacySettings = await tenantProfiles.settingsGet(orgId);
      const settings = client ?? legacySettings;
      if (!settings.niche) return res.status(400).json({ error: "create a client before running" });

      const niche = (typeof req.body?.niche === "string" && req.body.niche.trim()) || settings.niche;
      const brandVoice = (typeof req.body?.brandVoice === "string" && req.body.brandVoice.trim()) || settings.brandVoice;
      const platforms = Array.isArray(req.body?.platforms) && req.body.platforms.length ? req.body.platforms : settings.platforms;
      const targetDurationSec = typeof req.body?.targetDurationSec === "number" ? req.body.targetDurationSec : settings.targetDurationSec;
      const locale = (typeof req.body?.locale === "string" && req.body.locale.trim()) || (client?.locale ?? "en");
      const previewOnly = req.body?.previewOnly === true;

      if (previewOnly) {
        const { transcript, script } = await previewRemix({
          sourceUrl,
          niche,
          brandVoice,
          durationSec: targetDurationSec,
          platforms,
          locale,
          outDir: join(VVUGC_RUNS_DIR, "remix-sources", randomUUID())
        });
        return res.json({ transcript, script, previewOnly: true });
      }

      // Full run — fetch the source transcript and embed it so runCycle starts from the
      // user's pasted video rather than auto-discovery.
      const tmpOutDir = join(VVUGC_RUNS_DIR, "remix-sources", randomUUID());
      const { transcript } = await fetchRemixTranscript(sourceUrl, tmpOutDir, niche);

      const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
      let isOverage = false;

      const config = RunConfigSchema.parse({
        runId: randomUUID(),
        niche,
        platforms,
        brandVoice,
        targetDurationSec,
        videoVendor: settings.videoVendor,
        voiceVendor: settings.voiceVendor,
        accountId: orgId,
        orgId,
        clientId: client?.id,
        locale,
        sourceUrl,
        sourceTranscript: transcript,
        dryRun: !isRealRun(req),
        createdAt: new Date().toISOString()
      });

      const reservation = await billing.reserveRun({ orgId, runId: config.runId, clientId: client?.id, durationSec: config.targetDurationSec, usageRunCount: usage.runs.length });
      isOverage = reservation.kind === "overage";
      const onProgressRemix = createProgressCallback(config.runId);
      let result;
      try { result = await runCycle(config, { onProgress: onProgressRemix }); }
      catch (error) { await billing.settleReservation({ orgId, runId: config.runId }); throw error; }
      completeRun(config.runId, true, { candidatesFound: result.candidatesFound, reviewItemsCreated: result.reviewItemsCreated });

      await billing.settleReservation({ orgId, runId: config.runId, estimatedVendorCostUsd: result.estimatedCostUsd });
      res.json({ ...result, overage: isOverage ? { priceUsdPerRun: reservation.amountCents / 100 } : null });
    })
  );

  app.get("/accounts/members", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    res.json({
      members: (await identity.listByOrg(resolveOrgId(account))).map(toPublicAccount),
      role: account.role,
      // Server-computed so the UI can't drift from the actual permission map — the
      // routes still enforce with roleHasPermission regardless of what the page shows.
      canManageTeam: roleHasPermission(account.role, "team.manage")
    });
  }));

  // team.manage holders (owner + admins) can invite — a member hitting this directly
  // gets a real 403, not just a hidden button.
  app.post("/accounts/invite", requireSession, accountRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const { email, role } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    // The owner role is not grantable via invite — an org has exactly one owner (the
    // original signup), and transferring ownership is a deliberate separate flow.
    const requestedRole = role === undefined ? "editor" : role;
    if (!ACCOUNT_ROLES.includes(requestedRole as AccountRole) || requestedRole === "owner") {
      return res.status(400).json({ error: `role must be one of: ${ACCOUNT_ROLES.filter((r) => r !== "owner").join(", ")}` });
    }

    const orgId = resolveOrgId(account);
    const invite = await tenantProfiles.inviteCreate(orgId, email, account.id, requestedRole as AccountRole);
    writeSecurityEvent({
      type: "invite.sent",
      actorAccountId: account.id,
      orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: undefined,
      detail: `invited ${email} as ${requestedRole}`
    });
    // No email-sending infrastructure exists in this repo (see marketing-site's
    // WAITLIST_WEBHOOK_URL for the one place that does send anything externally) —
    // the invite link is returned directly for the owner to copy/send themselves,
    // same "no fake integration" posture as everywhere else unbuilt in this project.
    res.status(201).json({ inviteToken: invite.token, expiresAt: invite.expiresAt });
  }));

  app.post("/accounts/invite/accept", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "token and a password (8+ characters) are required" });
    }

    const invite = await tenantProfiles.inviteVerify(token);
    if (!invite) return res.status(400).json({ error: "invite is invalid or has expired" });

    let account;
    try {
      account = await identity.acceptInvite(invite, password);
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
    if (!account) return res.status(400).json({ error: "invite is invalid or has expired" });
    // The PostgreSQL identity adapter has consumed this inside the account +
    // membership transaction. The local adapter retains legacy behavior, so it
    // consumes after the local membership has been created.
    if (!(identity instanceof PostgresIdentityRepository)) await tenantProfiles.inviteConsume(token);
    writeSecurityEvent({
      type: "invite.accepted",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: `role: ${invite.role}`
    });

    const session = await identity.createSession(account.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(session.token, 30 * 24 * 60 * 60));
    res.status(201).json({ account: toPublicAccount(account) });
  }));

  // Self-service password change. Every session (including this one) is revoked so a
  // stolen or shared session can't survive a password reset — the client clears the
  // cookie and the user re-authenticates with the new password.
  app.post("/accounts/password", requireSession, accountRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    if (!await identity.authenticate(account.email, currentPassword)) {
      writeSecurityEvent({
        type: "password.change_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req),
        detail: "incorrect current password"
      });
      return res.status(403).json({ error: "current password is incorrect" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "new password must differ from the current password" });
    }
    await identity.updatePassword(account.id, newPassword);
    await identity.revokeAllSessions(account.id);
    writeSecurityEvent({
      type: "password.changed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "all sessions revoked"
    });
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  }));

  // Re-role a member (team.manage). The target's sessions are revoked so the new
  // permission set actually takes effect instead of lingering on an old session.
  app.put("/accounts/members/:id/role", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const role = req.body?.role;
    if (!ACCOUNT_ROLES.includes(role as AccountRole) || role === "owner") {
      return res.status(400).json({ error: `role must be one of: ${ACCOUNT_ROLES.filter((r) => r !== "owner").join(", ")}` });
    }
    const target = await identity.findById(targetId);
    if (!target || target.orgId !== account.orgId) {
      return res.status(404).json({ error: "member not found" });
    }
    const updated = await identity.setRole(account.orgId, targetId, role as AccountRole);
    // setRole refuses the org's owner — the owner role is not reassignable.
    if (!updated) return res.status(409).json({ error: "the org owner's role cannot be changed" });
    await identity.revokeAllSessions(targetId);
    writeSecurityEvent({
      type: "member.role_changed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: targetId,
      detail: `role: ${target.role} -> ${role}`
    });
    res.json({ member: toPublicAccount(updated) });
  }));

  // Remove a member (team.manage). Sessions are revoked so a removed member's existing
  // logins can't keep using org data through a still-valid cookie.
  app.delete("/accounts/members/:id", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const targetId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const target = await identity.findById(targetId);
    if (!target || target.orgId !== account.orgId) {
      return res.status(404).json({ error: "member not found" });
    }
    if (!await identity.removeMember(account.orgId, targetId)) {
      // removeMember refuses the owner — an org must keep its owner.
      return res.status(409).json({ error: "the org owner cannot be removed" });
    }
    await identity.revokeAllSessions(targetId);
    writeSecurityEvent({
      type: "member.removed",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      targetAccountId: targetId,
      detail: `removed ${target.email}`
    });
    res.status(204).end();
  }));

  // Security audit view for the account page — team.manage holders see the whole org's
  // events; every other member sees only events tied to their own account (login history,
  // their own password change, the invite that brought them in, etc.).
  app.get("/accounts/security-events", requireSession, (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const orgId = resolveOrgId(account);
    const canSeeOrg = roleHasPermission(account.role, "team.manage");
    const requested = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 50;
    const events = listSecurityEvents().filter((event) => {
      if (canSeeOrg && event.orgId === orgId) return true;
      return event.actorAccountId === account.id || event.targetAccountId === account.id;
    });
    res.json({ events: events.slice(0, limit) });
  });

  // ── Two-factor authentication (TOTP) ────────────────────────────────────────
  // Enrollment is gated to team.manage (owner + admin) per the Phase 7 scope —
  // the roles whose compromise does the most damage. The LOGIN challenge itself
  // is role-agnostic (it gates whatever account has MFA enabled); this gate only
  // controls who can turn MFA on/off for their own account.

  // Starts enrollment: generates a fresh TOTP secret and stores it as PENDING
  // (no confirmedAt — doesn't gate login yet). The secret is returned once for
  // the user to scan/enter into their authenticator app; re-enrolling after a
  // refresh simply regenerates it.
  app.post("/accounts/mfa/enroll", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const existing = await identity.getMfa(account.id);
    if (existing?.confirmedAt) {
      return res.status(409).json({ error: "two-factor authentication is already enabled" });
    }
    const secret = generateTotpSecret();
    await identity.putMfa({
      accountId: account.id,
      secret,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    });
    writeSecurityEvent({
      type: "mfa.enrolled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "pending confirmation"
    });
    res.json({ secret, otpauthUrl: otpauthTotpUrl(account.email, secret) });
  }));

  // Confirms a pending enrollment with the current TOTP code — the moment the
  // account becomes MFA-protected and login starts requiring the second factor.
  app.post("/accounts/mfa/verify", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const code = req.body?.code;
    if (typeof code !== "string") return res.status(400).json({ error: "code is required" });
    const pending = await identity.getMfa(account.id);
    if (!pending || pending.confirmedAt) {
      return res.status(409).json({ error: "no pending two-factor enrollment to confirm" });
    }
    if (!verifyTotpCode(pending.secret, code)) {
      return res.status(401).json({ error: "invalid authentication code" });
    }
    await identity.putMfa({ ...pending, confirmedAt: new Date().toISOString() });
    writeSecurityEvent({
      type: "mfa.enabled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ enabled: true });
  }));

  // Disables MFA. Requires the account's CURRENT valid TOTP code — proving the
  // person disabling it still holds the authenticator, so a stolen session can't
  // silently strip the second factor off a protected account.
  app.post("/accounts/mfa/disable", requireSession, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requirePermission("team.manage")(req, res);
    if (!account) return;
    const code = req.body?.code;
    if (typeof code !== "string") return res.status(400).json({ error: "code is required" });
    const mfa = await identity.getMfa(account.id);
    if (!mfa?.confirmedAt) return res.status(409).json({ error: "two-factor authentication is not enabled" });
    if (!verifyTotpCode(mfa.secret, code)) {
      return res.status(401).json({ error: "invalid authentication code" });
    }
    await identity.removeMfa(account.id);
    writeSecurityEvent({
      type: "mfa.disabled",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    res.json({ enabled: false });
  }));

  // ── Data export (GDPR-style access request) ─────────────────────────────────
  // Downloads everything the org has stored as one JSON bundle. Social
  // connection records are metadata-only — the encrypted tokens are intentionally
  // NOT exported (they're credentials, not user data, and exporting decrypted
  // credentials would create a whole second secret-management problem).
  app.get(
    "/accounts/export",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);
      const bundle = {
        generatedAt: new Date().toISOString(),
        orgId,
        account: toPublicAccount(account),
        members: (await identity.listByOrg(orgId)).map(toPublicAccount),
        settings: await tenantProfiles.settingsGet(orgId),
        clients: await tenantProfiles.clientList(orgId),
        // Profile image file paths are infrastructure locations rather than user
        // data; preserve the established API/export safety boundary by exporting
        // their metadata without exposing local object paths.
        products: (await tenantProfiles.productList(orgId)).map(publicProduct),
        creators: (await tenantProfiles.creatorList(orgId)).map(publicCreator),
        socialConnections: await tenantProfiles.socialList(orgId),
        plan: await billing.getPlan(orgId),
        usage: aggregateUsage(orgId, VVUGC_RUNS_DIR),
        reviewItems: await listReviewItems({ orgId }),
        jobs: await jobStore.list(orgId),
        securityEvents: listSecurityEvents().filter((event) => event.orgId === orgId)
      };
      res.setHeader("Content-Disposition", `attachment; filename="vvugc-export-${orgId}.json"`);
      res.type("application/json").send(JSON.stringify(bundle, null, 2));
    })
  );

  // ── DSR (Data Subject Rights) Request Endpoint ──────────────────────────────
  // Persists a formal DSR request server-side. The frontend's LegalModals.tsx
  // submits here instead of generating a fake case ID client-side.
  // P1 FIX: DSR must be a real backend workflow, not merely a modal.
  const DSR_TYPES = ["access", "rectification", "erasure", "restriction", "portability", "objection"] as const;

  app.post(
    "/accounts/dsr-requests",
    requireSession,
    (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);

      const { type } = req.body ?? {};
      if (!type || !DSR_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Invalid DSR type. Must be one of: ${DSR_TYPES.join(", ")}`
        });
      }

      const dsrRequest = {
        id: randomUUID(),
        orgId,
        requesterAccountId: account.id,
        requesterEmail: account.email,
        type: type as (typeof DSR_TYPES)[number],
        status: "pending_verification" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null as string | null
      };

      // Persist to DSR log (append-only NDJSON for audit trail)
      const dsrLogPath = join(VVUGC_RUNS_DIR, "dsr-requests.ndjson");
      mkdirSync(dirname(dsrLogPath), { recursive: true });
      appendFileSync(dsrLogPath, JSON.stringify(dsrRequest) + "\n");

      writeSecurityEvent({
        type: "dsr.request.created",
        actorAccountId: account.id,
        orgId,
        detail: `DSR ${type} request created: ${dsrRequest.id}`
      });

      res.status(201).json({
        id: dsrRequest.id,
        type: dsrRequest.type,
        status: dsrRequest.status,
        createdAt: dsrRequest.createdAt,
        message: "Your data subject request has been recorded. You will receive a confirmation within 72 hours."
      });
    }
  );

  // List DSR requests for the current user's org
  app.get(
    "/accounts/dsr-requests",
    requireSession,
    (req: AuthedRequest, res: Response) => {
      const account = requireAccount(req, res);
      if (!account) return;
      const orgId = resolveOrgId(account);

      const dsrLogPath = join(VVUGC_RUNS_DIR, "dsr-requests.ndjson");
      if (!existsSync(dsrLogPath)) return res.json({ requests: [] });

      const lines = readFileSync(dsrLogPath, "utf-8").trim().split("\n").filter(Boolean);
      const requests = lines
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.orgId === orgId);

      res.json({ requests });
    }
  );

  // ── Account deletion ────────────────────────────────────────────────────────
  // Self-service, confirmed with the password (re-authenticates the person making
  // the request, same posture as the password-change route). A member deletes
  // only their own account; the OWNER deleting their account deletes the entire
  // org — its members, settings, clients, runs, review items, jobs, billing state
  // and audit trail — since an org without its owner is meaningless.
  app.post("/accounts/delete-account", requireSession, accountRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const { confirm, password } = req.body ?? {};
    if (confirm !== "DELETE") {
      return res.status(400).json({ error: 'type "DELETE" to confirm account deletion' });
    }
    if (typeof password !== "string" || !await identity.authenticate(account.email, password)) {
      writeSecurityEvent({
        type: "account.delete_failed",
        actorAccountId: account.id,
        orgId: account.orgId,
        email: account.email,
        ip: clientIp(req),
        detail: "incorrect password"
      });
      return res.status(403).json({ error: "password is incorrect" });
    }

    const orgId = resolveOrgId(account);
    const isOwner = account.role === "owner";

    // Record the deletion BEFORE wiping data — after this point the event would
    // have nowhere to live.
    writeSecurityEvent({
      type: isOwner ? "org.deleted" : "account.deleted",
      actorAccountId: account.id,
      orgId,
      email: account.email,
      ip: clientIp(req),
      detail: isOwner ? "owner deleted the whole organization" : "member self-removed"
    });

    if (isOwner) {
      const memberIds = (await identity.listByOrg(orgId)).map((member) => member.id);
      for (const memberId of memberIds) {
        await identity.revokeAllSessions(memberId);
        await identity.removeMfa(memberId);
      }
      await identity.deleteOrg(orgId);
      await tenantProfiles.deleteOrg(orgId);
      const productAssetRoot = join(VVUGC_RUNS_DIR, "product-assets", orgId);
      if (existsSync(productAssetRoot)) rmSync(productAssetRoot, { recursive: true, force: true });
      const creatorAssetRoot = join(VVUGC_RUNS_DIR, "creator-assets", orgId);
      if (existsSync(creatorAssetRoot)) rmSync(creatorAssetRoot, { recursive: true, force: true });
      await billing.deletePlan(orgId);
      void jobStore.deleteOrg(orgId);
      productEvents.deleteOrg(orgId);
      void deleteReviewItemsByOrg(orgId);
      deleteSecurityEventsForOrg(orgId);
      purgeOrgRuns(orgId);
    } else {
      await identity.deleteAccount(account.id);
      await identity.revokeAllSessions(account.id);
      await tenantProfiles.inviteDeleteByEmail(account.email);
      await identity.removeMfa(account.id);
      deleteSecurityEventsForAccount(account.id);
    }

    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  }));

  // Self-service password recovery. Because the app has no email provider wired
  // up, the reset token is written to the server log (out-of-band — the operator
  // hands it to the user), NOT returned in the response: a password-reset token
  // must never be displayed in the app UI, where it could be shoulder-surfed or
  // captured. The response never leaks whether an email exists: it always returns
  // 200 with resetToken always null, so an attacker can't enumerate accounts.
  app.post("/accounts/password/forgot", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "a valid email is required" });
    }
    const account = await identity.findByEmail(email);
    if (!account) {
      // Uniform response whether or not the account exists (see note above).
      return res.json({ resetToken: null });
    }
    const reset = await identity.createReset(account.id, account.email);
    writeSecurityEvent({
      type: "password.reset_requested",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req)
    });
    // Deliver the token out-of-band. In production this is an email; with no
    // email provider the operator reads it from the server log to pass along.
    deps?.logger?.info(
      { email: account.email, resetToken: reset.token, expiresAt: reset.expiresAt },
      "password reset token issued — hand to the user out-of-band, do not display in the UI"
    );
    res.json({ resetToken: null, expiresAt: reset.expiresAt });
  }));

  app.post("/accounts/password/reset", accountRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ error: "token is required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    const reset = await identity.consumeReset(token);
    if (!reset) {
      return res.status(400).json({ error: "reset token is invalid or has expired" });
    }
    const account = await identity.findByEmail(reset.email);
    if (!account) {
      // Token was valid but its account is gone — treat as consumed already.
      return res.status(400).json({ error: "reset token is invalid or has expired" });
    }
    await identity.updatePassword(account.id, newPassword);
    await identity.revokeAllSessions(account.id);
    writeSecurityEvent({
      type: "password.reset",
      actorAccountId: account.id,
      orgId: account.orgId,
      email: account.email,
      ip: clientIp(req),
      detail: "all sessions revoked"
    });
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    res.status(204).end();
  }));

  return { requireSession, verifySessionRequest, identity };
}
