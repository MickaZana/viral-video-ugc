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

export type VideoVendor = 'higgsfield' | 'kling' | 'runway' | 'pika' | 'gemini' | 'replicate' | 'seedance' | 'grok_video' | 'wan' | 'nvidia'
export type VoiceVendor = 'elevenlabs' | 'grok'
export type ClientCadence = 'weekly' | 'manual'

export type AppMode = 'standard' | 'curriculum'

/** The org's workspace settings, as returned by GET /accounts/settings.
 *  `appMode` toggles between the standard viral/UGC workflow and Curriculum Mode. */
export interface AccountSettings {
  accountId: string
  appMode: AppMode
  niche: string
  brandVoice: string
  platforms: Platform[]
  targetDurationSec: number
  videoVendor: VideoVendor
  voiceVendor?: VoiceVendor
  cadence: ClientCadence
  updatedAt: string
}

/** Body for PUT /accounts/settings — the full settings shape minus server-managed fields. */
export type UpdateAccountSettings = Omit<AccountSettings, 'accountId' | 'updatedAt'>

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

// Product/UX usage events — mirrors packages/shared-product-analytics/src/events.ts's
// PRODUCT_EVENT_TYPES. Duplicated here rather than imported: that package's barrel
// index re-exports event-store.ts, which pulls in node:fs/node:crypto — not safe to
// bundle into a browser app — keep both in sync by hand if the event vocabulary changes.
export const PRODUCT_EVENT_TYPES = [
  'discovery_viewed',
  'remix_started',
  'run_started',
  'batch_planned',
  'batch_enqueued',
  'review_item_approved',
  'review_item_rejected',
  'brand_product_created',
  'brand_creator_created',
  'settings_viewed',
  'billing_viewed'
] as const
export type ProductEventType = typeof PRODUCT_EVENT_TYPES[number]

// Character Builder — mirrors packages/mcp-video-gen/src/character-builder.ts's
// CharacterAttributesSchema/CHARACTER_ATTRIBUTE_OPTIONS. Duplicated here rather than
// imported: that package pulls in ffmpeg-static/node:fs, which isn't safe to bundle into
// a browser app — keep both in sync by hand if the backend schema changes.
export interface CharacterAttributes {
  characterType?: 'human' | 'stylized_illustration' | 'anime'
  gender: 'woman' | 'man' | 'non_binary_presenting'
  ageRange: 'early_20s' | 'late_20s' | '30s' | '40s' | '50_plus'
  bodyType?: 'slim' | 'athletic' | 'average' | 'curvy' | 'muscular' | 'plus_size'
  hairStyle?: 'long_straight' | 'long_wavy' | 'long_curly' | 'shoulder_length' | 'short_bob' | 'pixie_cut' | 'buzz_cut' | 'braids' | 'ponytail' | 'bald'
  hairColor?: 'black' | 'dark_brown' | 'light_brown' | 'blonde' | 'red' | 'auburn' | 'gray' | 'silver' | 'dyed_vivid'
  skinTone?: 'very_fair' | 'fair' | 'light_medium' | 'medium' | 'tan' | 'deep' | 'very_deep'
  eyeColor?: 'brown' | 'dark_brown' | 'hazel' | 'green' | 'blue' | 'gray' | 'amber'
  style?: 'casual_everyday' | 'athletic_activewear' | 'business_professional' | 'streetwear' | 'elegant_formal' | 'cozy_homewear' | 'outdoorsy'
  renderingStyle?: 'photorealistic' | 'cinematic_photo' | 'editorial_fashion_photo'
  additionalDetails?: string
}
export const CHARACTER_ATTRIBUTE_OPTIONS: { [K in keyof Required<Omit<CharacterAttributes, 'additionalDetails'>>]: string[] } = {
  characterType: ['human', 'stylized_illustration', 'anime'],
  gender: ['woman', 'man', 'non_binary_presenting'],
  ageRange: ['early_20s', 'late_20s', '30s', '40s', '50_plus'],
  bodyType: ['slim', 'athletic', 'average', 'curvy', 'muscular', 'plus_size'],
  hairStyle: ['long_straight', 'long_wavy', 'long_curly', 'shoulder_length', 'short_bob', 'pixie_cut', 'buzz_cut', 'braids', 'ponytail', 'bald'],
  hairColor: ['black', 'dark_brown', 'light_brown', 'blonde', 'red', 'auburn', 'gray', 'silver', 'dyed_vivid'],
  skinTone: ['very_fair', 'fair', 'light_medium', 'medium', 'tan', 'deep', 'very_deep'],
  eyeColor: ['brown', 'dark_brown', 'hazel', 'green', 'blue', 'gray', 'amber'],
  style: ['casual_everyday', 'athletic_activewear', 'business_professional', 'streetwear', 'elegant_formal', 'cozy_homewear', 'outdoorsy'],
  renderingStyle: ['photorealistic', 'cinematic_photo', 'editorial_fashion_photo']
}
export interface CharacterPortrait { index: number; prompt: string; mimeType: string; dataBase64: string }


// ---- Curriculum Mode v2 ----
// Mirrors packages/curriculum-engine/src/schema.ts — keep in sync by hand. Not
// imported from that package: its barrel pulls in node:crypto and store code that
// isn't safe to bundle into a browser app (same rule as PRODUCT_EVENT_TYPES /
// CharacterAttributes above). Field names and shapes track the backend contracts
// exactly — the zod schemas in schema.ts and the response shapes in
// apps/review-dashboard/src/curriculum-routes.ts.

/** Lifecycle of a whole course, from first draft to archived. */
export type CurriculumStatus =
  | 'draft'
  | 'planning'
  | 'planned'
  | 'producing'
  | 'active'
  | 'completed'
  | 'archived'

/** Content pipeline state shared by lessons and projects. */
export type ContentStatus =
  | 'draft'
  | 'approved'
  | 'scripted'
  | 'queued'
  | 'generated'
  | 'review'
  | 'published'

/** Coarser lifecycle for a module (a batch of lessons + its long-form video). */
export type ModuleStatus = 'draft' | 'approved' | 'producing' | 'completed'

/** Kind of artifact produced for a course/module/lesson/project. */
export type AssetType =
  | 'short_video'
  | 'long_video'
  | 'script'
  | 'thumbnail'
  | 'caption'
  | 'quiz'
  | 'worksheet'
  | 'code'
  | 'pdf'
  | 'ebook_section'
  | 'newsletter'

/** Generation/review state of a single asset. */
export type AssetStatus =
  | 'planned'
  | 'scripted'
  | 'queued'
  | 'generated'
  | 'review'
  | 'approved'
  | 'published'
  | 'failed'

/** A course: the top-level unit of Curriculum Mode. */
export interface CurriculumCourse {
  id: string
  orgId: string
  title: string
  slug: string
  topic: string
  description?: string
  audience: string
  startingKnowledge: string[]
  endGoal: string
  language: string
  status: CurriculumStatus
  moduleCount: number
  lessonsPerModule: number
  shortDurationSec: number
  longFormTargetMin: number
  /** null = no spend cap. */
  maxGenerationSpendUsd: number | null
  /** Points at the locked CurriculumVersion currently in production; null while planning. */
  activeVersion: number | null
  createdAt: string
  updatedAt: string
}

/** A module groups `lessonsPerModule` lessons and owns one long-form video script. */
export interface CurriculumModule {
  id: string
  orgId: string
  courseId: string
  order: number
  title: string
  description: string
  goal: string
  prerequisites: string[]
  learningObjectives: string[]
  concepts: string[]
  status: ModuleStatus
  longFormScript?: string
  longFormScriptStatus: ContentStatus
  createdAt: string
  updatedAt: string
}

/** A module row as returned by GET .../modules — the base module plus the
 *  per-module lesson count and capstone-project flag that route computes. */
export interface CurriculumModuleWithCounts extends CurriculumModule {
  lessonCount: number
  hasProject: boolean
}

/** One ordered step of a module's hands-on project. */
export interface CurriculumProjectStep {
  order: number
  title: string
  detail: string
}

/** The capstone project attached to a module. */
export interface CurriculumProject {
  id: string
  orgId: string
  courseId: string
  moduleId: string
  title: string
  objective: string
  outcome: string
  requirements: string[]
  steps: CurriculumProjectStep[]
  technologies: string[]
  longFormScript?: string
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

/** A single knowledge-check question on a lesson. `answerIndex` null unless `options` apply. */
export interface KnowledgeCheckQuestion {
  kind: 'mcq' | 'concept' | 'coding'
  prompt: string
  options: string[]
  answerIndex: number | null
  rationale?: string
}

/** A lesson: one short-form video's worth of teaching. */
export interface CurriculumLesson {
  id: string
  orgId: string
  courseId: string
  moduleId: string
  moduleOrder: number
  lessonOrder: number
  globalOrder: number
  title: string
  learningObjective: string
  prerequisites: string[]
  concepts: string[]
  explanation?: string
  example?: string
  exercise?: string
  keyTakeaway?: string
  nextLessonHook?: string
  shortScript?: string
  visualPlan?: string
  codeExample?: string
  knowledgeCheck: KnowledgeCheckQuestion[]
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

/** A produced (or planned) artifact, linked to at most one of module/lesson/project. */
export interface CurriculumAsset {
  id: string
  orgId: string
  courseId: string
  moduleId?: string
  lessonId?: string
  projectId?: string
  assetType: AssetType
  status: AssetStatus
  generationRunId?: string
  reviewItemId?: string
  storagePath?: string
  /** Genuine JSON boundary — an opaque record, never `any`. */
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** An immutable snapshot of a course plan taken when a version is locked for production. */
export interface CurriculumVersion {
  id: string
  orgId: string
  courseId: string
  version: number
  createdAt: string
  createdByAccountId: string
  reason: string
  /** JSON snapshot of the whole plan at lock time — opaque here. */
  snapshot: unknown
}

/** A learner finishing a lesson (and, optionally, their knowledge-check score). */
export interface LessonCompletion {
  orgId: string
  courseId: string
  lessonId: string
  accountId: string
  completedAt: string
  knowledgeCheckScore?: number
}

// ---- Curriculum response wrappers (review-dashboard route shapes) ----

/** GET /accounts/curricula/:courseId */
export interface CurriculumCourseDetail {
  course: CurriculumCourse
  counts: { modules: number; lessons: number; projects: number }
}

/** GET /accounts/curricula/:courseId/modules/:moduleId */
export interface CurriculumModuleDetail {
  module: CurriculumModule
  lessons: CurriculumLesson[]
  project: CurriculumProject | null
}

/** Mirrors CurriculumQaIssue in packages/curriculum-engine/src/qa.ts — the exact
 *  shape `runCurriculumQa` emits, returned verbatim by generate-plan. */
export type CurriculumQaSeverity = 'error' | 'warning'
export interface CurriculumQaIssue {
  code: string
  severity: CurriculumQaSeverity
  message: string
  moduleOrder?: number
  lessonGlobalOrder?: number
}
export interface CurriculumQaReport {
  errors: CurriculumQaIssue[]
  warnings: CurriculumQaIssue[]
  ok: boolean
}

/** POST /accounts/curricula/:courseId/generate-plan */
export interface GeneratePlanResult {
  course: CurriculumCourse
  counts: { modules: number; lessons: number; projects: number }
  qa: CurriculumQaReport
}

/** POST /accounts/curricula/:courseId/lessons/:lessonId/script */
export interface LessonScriptResult {
  lesson: CurriculumLesson
  similarity: { maxPct: number; nearestLessonGlobalOrder: number | null; flagged: boolean }
}

/** POST /accounts/curricula/:courseId/lessons/:lessonId/produce */
export interface LessonProduceResult {
  asset: CurriculumAsset
  run: { runId: string; reviewItemsCreated: number; manifestPath: string; dryRun: boolean }
}

/** GET /accounts/curricula/:courseId/progress — the F2 learn/produce/publish rollup. */
export interface CurriculumProgress {
  learning: {
    lessonsTotal: number
    lessonsCompleted: number
    pct: number
    modules: {
      moduleId: string
      order: number
      title: string
      lessonsTotal: number
      lessonsCompleted: number
      pct: number
    }[]
    nextLesson: { id: string; globalOrder: number; moduleId: string; title: string } | null
  }
  production: {
    lessonsScripted: number
    lessonsProduced: number
    assetsTotal: number
  }
  publishing: {
    assetsPublished: number
  }
}

/** One row of GET /accounts/curricula/today — a course with the caller's progress. */
export interface CurriculumTodayItem {
  courseId: string
  courseTitle: string
  courseSlug: string
  lessonsTotal: number
  lessonsCompleted: number
  pct: number
  nextLesson: { id: string; globalOrder: number; moduleId: string; title: string } | null
}

// ---- Curriculum input bodies (mirror the route zod schemas) ----

/** Body for POST /accounts/curricula. The defaulted knobs are optional client-side. */
export interface CreateCurriculumCourseInput {
  title: string
  topic: string
  description?: string
  audience: string
  startingKnowledge?: string[]
  endGoal: string
  language?: string
  moduleCount?: number
  lessonsPerModule?: number
  shortDurationSec?: number
  longFormTargetMin?: number
  maxGenerationSpendUsd?: number | null
}

/** Body for PUT /accounts/curricula/:courseId — every field optional (`.partial()`). */
export type UpdateCurriculumCourseInput = Partial<CreateCurriculumCourseInput>

/** Body for PUT /accounts/curricula/:courseId/modules/:moduleId — content-only,
 *  field-granular merge; `order` is structural and not accepted. */
export interface CurriculumModulePatch {
  title?: string
  description?: string
  goal?: string
  prerequisites?: string[]
  learningObjectives?: string[]
  concepts?: string[]
  status?: ModuleStatus
}

/** Body for PUT /accounts/curricula/:courseId/lessons/:lessonId — content-only,
 *  field-granular merge; structural keys (`moduleId`, `*Order`) are not accepted. */
export interface CurriculumLessonPatch {
  title?: string
  learningObjective?: string
  prerequisites?: string[]
  concepts?: string[]
  explanation?: string
  example?: string
  exercise?: string
  keyTakeaway?: string
  nextLessonHook?: string
  shortScript?: string
  visualPlan?: string
  codeExample?: string
  knowledgeCheck?: KnowledgeCheckQuestion[]
  status?: ContentStatus
}

// ---- Curriculum produce dashboard shapes (§27 — cost preview + batch queue) ----

/** POST /accounts/curricula/:courseId/cost-estimate — a pure-arithmetic list-price
 *  preview for a course / module / lesson. Every figure is an ESTIMATE. */
export interface CurriculumCostEstimate {
  scope: 'course' | 'module' | 'lesson'
  currency: string
  counts: { lessons: number; modules: number }
  lineItems: {
    scriptUsd: number
    videoUsd: number
    voiceUsd: number
    longFormScriptUsd: number
  }
  perLessonUsd: number
  totalUsd: number
  cap: {
    maxGenerationSpendUsd: number | null
    withinCap: boolean
    remainingUsd: number | null
  }
  assumptions: string[]
  disclaimer: string
}

/** POST .../modules/:moduleId/queue and POST .../queue-approved — a batch
 *  dry-run (or live) production pass over the in-scope scripted lessons. */
export interface CurriculumQueueResult {
  scope: 'course' | 'module'
  moduleId?: string
  dryRun: boolean
  eligible: number
  produced: { lessonId: string; assetId: string; runId: string; reviewItemsCreated: number }[]
  skipped: {
    lessonId: string
    reason: 'no-script' | 'already-produced' | 'stopped-by-cap' | 'error'
    /** Present only for `reason: 'error'` — the caught failure message. */
    error?: string
  }[]
  stoppedByCap: boolean
  estimatedSpendUsd: number
  maxConcurrent: number
  cap: { maxGenerationSpendUsd: number | null }
}

