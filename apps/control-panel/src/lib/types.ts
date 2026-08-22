/**
 * Types mirroring the real backend contracts (@vvugc/shared-schema plus the
 * review-dashboard's own responses). Kept as plain interfaces — not re-exporting
 * the zod schemas — so the SPA stays decoupled from the workspace packages and
 * only ever talks to the backend over HTTP. Nothing here is fabricated data; it
 * describes what the backend actually returns.
 */

export type Platform = 'tiktok' | 'youtube_shorts' | 'instagram_reels' | 'facebook'
export type UGCTemplateId = 'testimonial' | 'unboxing' | 'tutorial' | 'problem_solution' | 'comparison' | 'before_after' | 'founder_story'
export interface UGCTemplate { id: UGCTemplateId; version: string; name: string; description: string; category: string; targetPlatforms: Platform[]; recommendedDurationSec: number; scriptStructure: string[]; hookPatterns: string[]; requiredInputs: string[]; optionalInputs: string[]; visualDirection: string; cameraDirection: string; creatorDirection: string; productPlacementDirection: string; captionStyle: 'clean'|'bold'|'minimal'; ctaPatterns: string[]; forbiddenPatterns: string[]; qaRubric: string[]; defaultVariants: string[]; active: boolean; createdAt: string; updatedAt: string }
export type ReviewItemStatus = 'pending' | 'approved' | 'rejected'

export interface RewrittenScript {
  videoId: string
  hook: string
  points: string[]
  cta: string
  durationSec: number
  brandVoice: string
  locale: string
  trendingPhrases: string[]
  platformNotes?: Partial<Record<Platform, string>>
}

export interface CaptionCue {
  startSec: number
  endSec: number
  text: string
}

export interface RawClip {
  id: string
  scriptSegmentIndex: number
  vendor: string
  filePath: string
  durationSec: number
}

export interface ReviewItem {
  id: string
  runId: string
  orgId?: string
  clientId?: string
  niche: string
  templateId?: UGCTemplateId
  template?: UGCTemplate
  videoPath: string
  platform: Platform
  script: RewrittenScript
  score: number
  structuralScore?: number
  flags: string[]
  originalityScore?: number
  clips?: RawClip[]
  captions?: CaptionCue[]
  voiceoverPath?: string
  sourceTranscriptText?: string
  publishedPostId?: string
  publishedUrl?: string
  publishedAt?: string
  status: ReviewItemStatus
  createdAt: string
  /** True when the item was produced by a dry-run (mock) pipeline run — it has no
   *  real rendered asset and must be regenerated live (VVUGC_LLM_LIVE=true) before
   *  it can be published. Always surfaced with a MOCK badge and never publishable. */
  dryRun?: boolean
}

export interface RunFailure {
  candidateId: string
  platform?: string
  reason: string
}

export interface RunSummary {
  runId: string
  niche: string
  platforms: string[]
  candidatesFound: number
  reviewItemsCreated: number
  createdAt?: string
  estimatedCostUsd?: number
  candidatesFailed?: number
  platformsFailed?: number
  failures?: RunFailure[]
  /** Operator's riffed discovery brief, when the run was started from the Spy panel.
   *  Lets the Studio run page show "your brief" after a hard refresh. */
  discoveryBrief?: DiscoverBrief | null
}

export interface Stats {
  pending: number
  approved: number
  rejected: number
  estimatedCostUsd: number
  /** True when the dashboard is running with VVUGC_LLM_LIVE=true — i.e. publish
   *  and live regeneration are actually possible. When false/absent, the UI
   *  disables those live-only actions. */
  isLLMLive?: boolean
}

/**
 * A creator entity derived from real discovery candidates recorded in run
 * manifests (the `chosen` array each run persists). This is real data — actual
 * discovered viral posts with their platform, title, publishedAt and metrics —
 * aggregated/derived server-side; it is not fabricated.
 */
export interface TrackedCreator {
  sourceId: string
  label: string
  platform: Platform
  niche: string
  url?: string
  views: number
  likes: number
  velocityScore: number
  publishedAt?: string
  runs: string[]
}

export interface CreatorsResponse {
  creators: TrackedCreator[]
}

/** A pricing tier as returned by the backend /accounts/billing. */
export interface PricingTier {
  id: string
  name: string
  /** Matches the backend's tier shape (priceUsdPerMonth), which sends the raw
   *  PRICING_TIERS from @vvugc/shared-billing. */
  priceUsdPerMonth: number
  monthlyRunLimit: number
  overagePriceUsdPerRun: number
}

export interface BillingPlan {
  tierId: string | null
  status: string
}

export interface BillingOverage {
  priceUsdPerRun: number
  overageRunsThisMonth: number
  chargedThisMonth: number
  totalUsdThisMonth: number
}

export interface BillingResponse {
  tiers: PricingTier[]
  plan: BillingPlan
  runsUsedThisMonth: number
  monthlyRunLimit?: number
  overage: BillingOverage
}

/** A model the pipeline can invoke, from the backend /models catalog. */
export interface ModelOption {
  id: string
  kind: 'text' | 'image' | 'video' | 'voiceover'
  result: string
  vendor: string
  model: string
  description: string
  unit: string
  priceUsdPerUnit: number
  note?: string
}

export type ModelKind = ModelOption['kind']

export interface ModelsResponse {
  models: ModelOption[]
  grouped: Record<ModelKind, ModelOption[]>
}

/** A source transcript resolved from a pasted viral video URL. */
export interface SourceTranscript {
  videoId: string
  source: 'platform_captions' | 'whisper' | 'claude_audio'
  text: string
  segments: { startSec: number; endSec: number; text: string }[]
}

/** Response from POST /accounts/remix with previewOnly:true — the adapted script,
 *  produced with a single cheap LLM call and no video spend. */
export interface RemixPreviewResponse {
  transcript: SourceTranscript
  script: RewrittenScript
  previewOnly: true
}

export type RemixRequest = {
  sourceUrl: string
  clientId?: string
  niche?: string
  brandVoice?: string
  platforms?: Platform[]
  targetDurationSec?: number
  locale?: string
  dryRun?: boolean
}

// ---- Agency clients & pipeline runs ----
// A client is the entity that owns a run's configuration (niche, platforms,
// vendors). It is exactly what the backend's POST /accounts/run builds the
// RunConfig from — see @vvugc/shared-auth's AgencyClient and the review
// dashboard's ClientInputSchema. Nothing here is fabricated.

export type VideoVendor = 'higgsfield' | 'kling' | 'runway' | 'pika' | 'gemini' | 'replicate'
export type VoiceVendor = 'elevenlabs' | 'grok'
export type ClientCadence = 'weekly' | 'manual'

export interface AgencyClient {
  id: string
  orgId: string
  name: string
  niche: string
  brandVoice: string
  brandKit?: unknown
  locale: string
  platforms: Platform[]
  targetDurationSec: number
  videoVendor: VideoVendor
  voiceVendor?: VoiceVendor
  cadence: ClientCadence
  active: boolean
  nextRunAt?: string
  lastScheduledRunAt?: string
  createdAt: string
  updatedAt: string
}

export interface ClientsResponse {
  clients: AgencyClient[]
}

/** Body for POST /accounts/clients and PUT /accounts/clients/:id. */
export interface CreateClientInput {
  name: string
  niche: string
  brandVoice: string
  brandKit?: unknown
  locale?: string
  platforms: Platform[]
  targetDurationSec: number
  videoVendor: VideoVendor
  voiceVendor?: VoiceVendor
  cadence: ClientCadence
  active?: boolean
}

/** Response from POST /accounts/run — the pipeline's RunResult plus the org's
 *  overage state (null when the run is inside the plan's included runs). */
export interface RunResponse {
  runId: string;
  accountId?: string;
  orgId?: string;
  clientId?: string;
  niche: string;
  candidatesFound: number;
  reviewItemsCreated: number;
  manifestPath: string;
  completedAt: string;
  costLedgerPath?: string;
  estimatedCostUsd?: number;
  candidatesFailed?: number;
  platformsFailed?: number;
  overage: { priceUsdPerRun: number } | null;
}

// ---- Discovery ("what's working" + brief) ----
// Mirrors POST /accounts/discover. The backend wraps external discovery in
// try/catch, so even an empty/erroring fetch returns 200 with a seeded brief.

export interface DiscoverVideoMetrics {
  views: number
  likes: number
  comments: number
  velocityScore: number
}

export interface DiscoverWhy {
  hook: string[]
  format: string[]
  pattern: string[]
}

export interface DiscoverVideo {
  id: string
  platform: Platform
  url: string
  author: string
  thumbnail?: string
  metrics: DiscoverVideoMetrics
  whyItWorks: DiscoverWhy
  patterns: string[]
}

export interface DiscoverBrief {
  angle: string
  hookTemplate: string
  structure: string[]
  patterns: string[]
  dos: string[]
  donts: string[]
}

export interface DiscoverResponse {
  videos: DiscoverVideo[]
  brief: DiscoverBrief
}

export interface DiscoverRequest {
  niche: string
  platform?: string
  limit?: number
}

/** Response from GET /accounts/trends — proactive discovery suggestions aggregated
 *  from local history (clients + past run manifests). `source: "local-history"`
 *  means no live trend API is connected; a live source would set it to "live". */
export interface TrendsResponse {
  source: 'local-history' | 'live'
  suggestedNiches: string[]
  suggestedAngles: string[]
  note?: string
}

export interface ProductImage {
  id: string
  fileName: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  filePath: string
  createdAt: string
}

export interface ProductProfile {
  id: string
  orgId: string
  clientId?: string
  name: string
  canonicalUrl?: string
  description: string
  shortDescription: string
  productCategory: string
  targetCustomer: string
  customerPain: string
  primaryBenefits: string[]
  features: string[]
  claims: string[]
  forbiddenClaims: string[]
  differentiators: string[]
  price?: string
  callToAction: string
  brandTone?: string
  productImages: ProductImage[]
  extractedImageUrls: string[]
  extractedSourceText?: string
  extractionStatus: 'manual' | 'pending' | 'complete' | 'failed'
  extractionError?: string
  createdAt: string
  updatedAt: string
}

export interface ProductsResponse { products: ProductProfile[] }
export interface CreatorReferenceImage { id: string; fileName: string; mimeType: string; createdAt: string }
export interface CreatorProfile { id: string; clientId?: string; displayName: string; description: string; referenceImages: CreatorReferenceImage[]; avatarMode: 'reference_images' | 'vendor_avatar' | 'none'; preferredVideoVendor?: string; compatibleVendors: string[]; voiceVendor?: 'elevenlabs' | 'grok'; voiceId?: string; speechStyle: string; tone: string; wardrobe: string; visualStyle: string; ageRange?: string; language: string; accent?: string; prohibitedDepictions: string[]; defaultLocation?: string; consentConfirmed: boolean; consentConfirmedAt?: string; consentConfirmedBy?: string; active: boolean; createdAt: string; updatedAt: string }

