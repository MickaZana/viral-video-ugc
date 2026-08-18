import type { CandidateVideo } from "@vvugc/shared-schema";

export interface DiscoverVideoMetrics {
  views: number;
  likes: number;
  comments: number;
  velocityScore: number;
}

export interface DiscoverWhy {
  hook: string[];
  format: string[];
  pattern: string[];
}

export interface DiscoverVideo {
  id: string;
  platform: string;
  url: string;
  author: string;
  thumbnail?: string;
  metrics: DiscoverVideoMetrics;
  whyItWorks: DiscoverWhy;
  patterns: string[];
}

export interface DiscoverBrief {
  angle: string;
  hookTemplate: string;
  structure: string[];
  patterns: string[];
  dos: string[];
  donts: string[];
}

export interface DiscoverResponse {
  videos: DiscoverVideo[];
  brief: DiscoverBrief;
}

const HIGH_VELOCITY = 1000;
const STRONG_ENGAGEMENT = 0.08;
const CONVERSATION = 0.01;
const VIRAL_VIEWS = 500_000;

function deriveAuthor(url: string, platform: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (platform === "tiktok") {
      const at = segs.find((s) => s.startsWith("@"));
      if (at) return at;
    }
    if (segs.length > 0) return segs[segs.length - 1];
    return u.hostname;
  } catch {
    return platform;
  }
}

/**
 * Pure analyzer: turns raw discovery candidates into per-video "why they work"
 * signals plus recurring pattern tags, derived concretely from the metrics.
 */
export function analyzeVideos(candidates: CandidateVideo[]): DiscoverVideo[] {
  return candidates.map((c) => {
    const m = c.metrics;
    const views = m.views ?? 0;
    const likes = m.likes ?? 0;
    const comments = m.comments ?? 0;
    const velocity = m.velocityScore ?? 0;
    const why: DiscoverWhy = { hook: [], format: [], pattern: [] };
    const patterns: string[] = [];

    if (velocity >= HIGH_VELOCITY) {
      why.hook.push("Opens with an immediate, fast-moving payoff that rewards attention in the first second");
      why.format.push("High-energy vertical clip with quick cuts");
      patterns.push("Early momentum");
    }
    const likeRatio = views > 0 ? likes / views : 0;
    if (likeRatio >= STRONG_ENGAGEMENT) {
      why.hook.push("Hook lands — strong like-to-view ratio means people watch to the end");
      why.format.push("Front-loaded single-take or text-hook opener");
      patterns.push("Strong hook retention");
    }
    const commentRatio = views > 0 ? comments / views : 0;
    if (commentRatio >= CONVERSATION) {
      why.hook.push("Poses a question or invites a take, driving comments and saves");
      why.format.push("Comment-bait structure — on-screen question plus a caption ask");
      patterns.push("Conversation driver");
    }
    if (views >= VIRAL_VIEWS) {
      why.format.push("Format that travels — trending audio or a universal situation");
      patterns.push("Broad format appeal");
    }
    if (patterns.length === 0) {
      why.hook.push("Leads with a clear, self-contained promise the viewer gets instantly");
      why.format.push("Repeatable single-concept template");
      patterns.push("Reliable template");
    }

    return {
      id: c.id,
      platform: c.platform,
      url: c.url,
      author: deriveAuthor(c.url, c.platform),
      metrics: { views, likes, comments, velocityScore: velocity },
      whyItWorks: why,
      patterns
    };
  });
}

const DEFAULT_STRUCTURE = [
  "Hook: open with the pattern-interrupt that stops the scroll in the first 1.5s",
  "Point: deliver one concrete, contrarian proof point the viewer can use",
  "CTA: a low-friction ask that invites a comment or save"
];

function seedBrief(niche: string): DiscoverBrief {
  const n = niche?.trim() || "your niche";
  return {
    angle: `Lead ${n} with proof, not promises — short, high-velocity clips that make the viewer the hero.`,
    hookTemplate: `You think [common belief about ${n}]? Here's what actually works.`,
    structure: DEFAULT_STRUCTURE,
    patterns: ["Lead with a scroll-stopping hook", "One clear proof point", "Explicit save / comment CTA"],
    dos: [
      "Open with the payoff, not the context",
      "Keep it under 30s and front-load the hook",
      "End every video with a single, specific ask"
    ],
    donts: [
      "Don't bury the lead behind a long intro",
      "Don't use generic stock footage as the hook",
      "Don't ask for a like-and-subscribe wall of text"
    ]
  };
}

/**
 * Synthesizes a riff-able brief from the AGGREGATE of analyzed videos. The top
 * recurring patterns across the set become the brief's patterns; without videos
 * the brief is seeded from the niche text so the editor is never empty.
 */
export function synthesizeBrief(videos: DiscoverVideo[], niche: string): DiscoverBrief {
  if (videos.length === 0) return seedBrief(niche);

  const freq = new Map<string, number>();
  for (const v of videos) {
    for (const p of v.patterns) freq.set(p, (freq.get(p) ?? 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const topPatterns = ranked.slice(0, 4).length ? ranked.slice(0, 4) : ["Strong hook retention"];

  const n = niche?.trim() || "your niche";
  const leadPattern = topPatterns[0];

  return {
    angle: `Win ${n} by leaning into "${leadPattern}" — short, high-velocity clips that prove the point instead of stating it.`,
    hookTemplate: `You think [common belief about ${n}]? Here's what actually [outcome].`,
    structure: DEFAULT_STRUCTURE,
    patterns: topPatterns,
    dos: [
      `Engineer for "${leadPattern}" from the first frame`,
      "Front-load the hook in the first 1.5 seconds",
      "Give one concrete, reusable takeaway per video"
    ],
    donts: [
      "Don't open with branding or a slow build-up",
      "Don't dilute the hook with multiple competing claims",
      "Don't end without a specific comment/save ask"
    ]
  };
}

export function buildDiscoverResponse(candidates: CandidateVideo[], niche: string): DiscoverResponse {
  const videos = analyzeVideos(candidates);
  return { videos, brief: synthesizeBrief(videos, niche) };
}
