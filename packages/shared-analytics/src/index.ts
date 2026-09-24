/**
 * @vvugc/shared-analytics — Self-learning pipeline intelligence
 *
 * This package closes the feedback loop between content creation and
 * real-world performance, enabling the pipeline to learn from every
 * job and improve over time.
 *
 * Modules:
 * - feedback-loop: Post-publish metric ingestion from TikTok/Meta/YouTube
 * - hook-registry: Self-expanding hook pattern library ranked by performance
 * - growth-memory: Persistent intelligence that forecasts what will work
 * - adaptive-prompt: Injects learned context into the script agent's prompts
 * - concurrency-cap: Rate limiting, cost caps, and max 8 videos/flow
 */

export {
  // Feedback Loop
  PlatformMetricsSnapshotSchema,
  PerformanceRecordSchema,
  computeViralityScore,
  TikTokMetricsFetcher,
  MetaMetricsFetcher,
  YouTubeMetricsFetcher,
  itemsDueForSnapshot,
  assessPerformance,
  DEFAULT_FEEDBACK_CONFIG,
  type PlatformMetricsSnapshot,
  type PerformanceRecord,
  type ViralityFactors,
  type PlatformMetricsFetcher,
  type FeedbackCollectorConfig,
} from "./feedback-loop.js";

export {
  // Hook Registry
  HOOK_CATEGORIES,
  HookEntrySchema,
  HookRegistrySchema,
  classifyHook,
  registerHook,
  recordDecision,
  recordPerformance,
  importFromDiscovery,
  getTopHooks,
  suggestCategories,
  type HookCategory,
  type HookEntry,
  type HookRegistry,
} from "./hook-registry.js";

export {
  // Growth Memory
  NicheInsightSchema,
  TrendSignalSchema,
  GrowthMemorySchema,
  createGrowthMemory,
  learnFromJob,
  forecast,
  pruneMemory,
  type NicheInsight,
  type TrendSignal,
  type GrowthMemory,
  type ForecastResult,
  type ForecastRecommendation,
} from "./growth-memory.js";

export {
  // Adaptive Prompt
  buildAdaptivePrompt,
  getDiversityTargets,
  type AdaptiveContext,
  type DiversityTarget,
} from "./adaptive-prompt.js";

export {
  // Concurrency Cap
  Semaphore,
  CostCap,
  CostCapExceededError,
  FlowLimiter,
  throttledExec,
  executeCapped,
  DEFAULT_CAP_CONFIG,
  type ConcurrencyCapConfig,
} from "./concurrency-cap.js";
