/**
 * adaptive-prompt.ts — Injects performance intelligence into the script agent
 *
 * This is the bridge between the analytics brain and the LLM creative agent.
 * It builds dynamic prompt sections from the hook registry and growth memory,
 * giving the script agent context about what has worked, what to avoid, and
 * what trends to capitalize on.
 *
 * The key insight: the script agent's prompt is no longer static. It evolves
 * with every run, incorporating real-world feedback into creative direction.
 */
import type { HookEntry, HookRegistry } from "./hook-registry.js";
import { getTopHooks, suggestCategories } from "./hook-registry.js";
import type { GrowthMemory, ForecastResult } from "./growth-memory.js";
import { forecast } from "./growth-memory.js";
import type { HookCategory } from "./hook-registry.js";

// ─── Adaptive Prompt Builder ────────────────────────────────────────────────

export interface AdaptiveContext {
  /** Dynamic few-shot hook examples from top performers */
  hookExamples: string;
  /** What to avoid based on learned failures */
  avoidanceDirectives: string;
  /** Trend-aligned suggestions */
  trendDirectives: string;
  /** Performance-based creative direction */
  creativeDirection: string;
  /** Full assembled prompt section to inject after the static system prompt */
  fullInjection: string;
}

/**
 * Build the adaptive prompt injection for the script agent.
 * This is called before each script rewrite to give the LLM
 * real performance data to work with.
 */
export function buildAdaptivePrompt(
  registry: HookRegistry,
  memory: GrowthMemory,
  context: {
    niche: string;
    platform: string;
    recentlyUsedCategories?: HookCategory[];
  }
): AdaptiveContext {
  // Get forecast for this niche + platform
  const forecastResult = forecast(memory, {
    niche: context.niche,
    platform: context.platform,
  });

  // Get top-performing hooks as few-shot examples
  const topHooks = getTopHooks(registry, {
    platform: context.platform,
    niche: context.niche,
    limit: 5,
    minConfidence: 50,
  });

  // Get category suggestions for variety
  const categories = suggestCategories(
    registry,
    context.recentlyUsedCategories ?? [],
    4
  );

  // Build each section
  const hookExamples = buildHookExamplesSection(topHooks);
  const avoidanceDirectives = buildAvoidanceSection(forecastResult);
  const trendDirectives = buildTrendSection(forecastResult);
  const creativeDirection = buildCreativeDirectionSection(forecastResult, categories);

  // Assemble the full injection
  const fullInjection = assembleFullInjection({
    hookExamples,
    avoidanceDirectives,
    trendDirectives,
    creativeDirection,
    forecastResult,
  });

  return {
    hookExamples,
    avoidanceDirectives,
    trendDirectives,
    creativeDirection,
    fullInjection,
  };
}

/**
 * Get diversity targets for a batch run — ensures the pipeline produces
 * varied content across multiple angles instead of repeating the same winning formula.
 */
export function getDiversityTargets(
  registry: HookRegistry,
  memory: GrowthMemory,
  context: {
    niche: string;
    platforms: string[];
    batchSize: number;
  }
): DiversityTarget[] {
  const targets: DiversityTarget[] = [];
  const { batchSize } = context;

  // For each slot in the batch, assign a different angle/category
  const categories = suggestCategories(registry, [], Math.min(batchSize, 8));

  for (let i = 0; i < Math.min(batchSize, 8); i++) {
    const cat = categories[i % categories.length];
    const platform = context.platforms[i % context.platforms.length];

    // Get platform-specific forecast
    const platformForecast = forecast(memory, {
      niche: context.niche,
      platform,
    });

    // Find a winning angle to suggest (different from previous slots)
    const usedAngles = targets.map((t) => t.suggestedAngle).filter(Boolean);
    const availableAngles = platformForecast.recommendations
      .filter((r) => r.type === "angle" && !usedAngles.includes(r.suggestion))
      .map((r) => r.suggestion);

    targets.push({
      slotIndex: i,
      platform,
      hookCategory: cat.category,
      categoryReason: cat.reason,
      suggestedAngle: availableAngles[0],
      avoidAngles: platformForecast.recommendations
        .filter((r) => r.type === "avoid")
        .map((r) => r.suggestion),
    });
  }

  return targets;
}

export interface DiversityTarget {
  slotIndex: number;
  platform: string;
  hookCategory: HookCategory;
  categoryReason: string;
  suggestedAngle?: string;
  avoidAngles: string[];
}

// ─── Section Builders ───────────────────────────────────────────────────────

function buildHookExamplesSection(hooks: HookEntry[]): string {
  if (hooks.length === 0) {
    return "No historical hook performance data available yet. Use your best creative judgment.";
  }

  const examples = hooks.map((h, i) =>
    `${i + 1}. [${h.category.toUpperCase()}] "${h.template}" — confidence: ${h.confidenceScore}/100, used ${h.timesUsed}x`
  ).join("\n");

  return `PROVEN HIGH-PERFORMING HOOKS (use as structural inspiration, not verbatim):
${examples}

These hooks have been tested and scored highly. Study their structure and emotional triggers,
then create ORIGINAL hooks that use similar mechanics but fresh angles.`;
}

function buildAvoidanceSection(forecast: ForecastResult): string {
  const avoidItems = forecast.recommendations.filter((r) => r.type === "avoid");
  if (avoidItems.length === 0) return "";

  const avoidList = avoidItems.map((a) =>
    `- AVOID: "${a.suggestion}" (${a.reason})`
  ).join("\n");

  return `LEARNED FAILURES — do NOT repeat these patterns:
${avoidList}

These approaches have been tested and consistently underperformed. Find different angles.`;
}

function buildTrendSection(forecast: ForecastResult): string {
  const trends = forecast.recommendations.filter((r) => r.type === "trend");
  if (trends.length === 0) return "";

  const trendList = trends.map((t) =>
    `- ${t.suggestion} (${t.reason}, confidence: ${t.confidence}%)`
  ).join("\n");

  return `CURRENT TRENDS TO CAPITALIZE ON:
${trendList}

Weave these signals naturally into the script when relevant to the niche. Don't force them.`;
}

function buildCreativeDirectionSection(
  forecast: ForecastResult,
  categories: Array<{ category: HookCategory; weight: number; reason: string }>
): string {
  const categoryDirectives = categories.map((c) =>
    `- ${c.category.toUpperCase()} (weight: ${(c.weight * 100).toFixed(0)}%): ${c.reason}`
  ).join("\n");

  const durationRec = forecast.recommendations.find((r) => r.type === "duration");

  let section = `CREATIVE DIRECTION (data-driven):
Predicted virality potential: ${forecast.predictedViralityScore}/100 (based on ${forecast.dataPointsUsed} historical jobs)

Recommended hook categories for this run:
${categoryDirectives}`;

  if (durationRec) {
    section += `\n\nOptimal duration: ${durationRec.suggestion} (${durationRec.reason})`;
  }

  return section;
}

function assembleFullInjection(parts: {
  hookExamples: string;
  avoidanceDirectives: string;
  trendDirectives: string;
  creativeDirection: string;
  forecastResult: ForecastResult;
}): string {
  // Only inject if we have meaningful data (avoid polluting the prompt with empty sections)
  if (parts.forecastResult.dataPointsUsed === 0) {
    return ""; // No historical data yet — let the base prompt handle it
  }

  const sections = [
    "═══ ADAPTIVE INTELLIGENCE (learned from pipeline performance) ═══",
    "",
    parts.creativeDirection,
    "",
    parts.hookExamples,
  ];

  if (parts.avoidanceDirectives) {
    sections.push("", parts.avoidanceDirectives);
  }
  if (parts.trendDirectives) {
    sections.push("", parts.trendDirectives);
  }

  sections.push(
    "",
    `Data confidence: ${parts.forecastResult.insightStrength}% (higher = more historical data for this niche)`,
    "═══════════════════════════════════════════════════════════════════"
  );

  return sections.join("\n");
}
