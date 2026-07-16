import { jaccardSimilarityPct, ngrams, splitSentences, tokenize } from "./text.js";

export interface OriginalityResult {
  /** 0-100, higher = more original (less copied). What ships to reviewers as "the originality score". */
  originalityScore: number;
  /** Token-overlap similarity (5-word n-gram Jaccard) — catches near-verbatim wording reuse,
   *  independent of how the piece is structured. */
  wordingSimilarityPct: number;
  /** How similar the *shape* (sentence count, average sentence length) is — independent of the
   *  actual words used. High structural + low wording similarity is expected and fine: it means
   *  the rewrite kept a similar pacing/format while using genuinely different language. */
  structuralSimilarityPct: number;
  /** Exact 6+ word phrases found verbatim in both texts — concrete evidence for a reviewer,
   *  not just a score. Empty when no verbatim reuse was found. */
  phraseOverlaps: string[];
  flags: string[];
}

const WORDING_NGRAM_SIZE = 5;
const PHRASE_OVERLAP_NGRAM_SIZE = 6;
const WORDING_SIMILARITY_FLAG_THRESHOLD = 40;
const ORIGINALITY_REVIEW_THRESHOLD = 50;
const PHRASE_OVERLAP_PENALTY = 10;
const MAX_PHRASE_OVERLAP_PENALTY = 40;

function ratioCloseness(a: number, b: number): number {
  const denom = Math.max(a, b, 1);
  return 1 - Math.abs(a - b) / denom;
}

/**
 * Compares a rewritten script against its source transcript — the "trend-informed but
 * original" check: structural similarity (kept the same pacing/format — expected and fine)
 * separate from wording similarity (reused the same phrasing — the actual copying risk),
 * plus a list of any exact phrases long enough to be non-coincidental. Purely algorithmic
 * (no LLM call) so it's free and deterministic to run on every script, not just a
 * judgment call gated behind vendor cost like qa-agent.ts's scoring.
 */
export function scoreOriginality(sourceText: string, generatedText: string): OriginalityResult {
  const sourceTokens = tokenize(sourceText);
  const generatedTokens = tokenize(generatedText);

  const wordingSimilarityPct = jaccardSimilarityPct(
    ngrams(sourceTokens, WORDING_NGRAM_SIZE),
    ngrams(generatedTokens, WORDING_NGRAM_SIZE)
  );

  const sourceSentences = splitSentences(sourceText);
  const generatedSentences = splitSentences(generatedText);
  const avgLen = (sentences: string[]) =>
    sentences.length === 0 ? 0 : sentences.reduce((sum, s) => sum + tokenize(s).length, 0) / sentences.length;

  const structuralSimilarityPct =
    (ratioCloseness(sourceSentences.length, generatedSentences.length) +
      ratioCloseness(avgLen(sourceSentences), avgLen(generatedSentences))) *
    50; // average of two 0-1 ratios, scaled to 0-100

  const sourcePhrases = new Set(ngrams(sourceTokens, PHRASE_OVERLAP_NGRAM_SIZE));
  const phraseOverlaps = [...new Set(ngrams(generatedTokens, PHRASE_OVERLAP_NGRAM_SIZE).filter((p) => sourcePhrases.has(p)))];

  const phrasePenalty = Math.min(phraseOverlaps.length * PHRASE_OVERLAP_PENALTY, MAX_PHRASE_OVERLAP_PENALTY);
  const originalityScore = Math.max(0, Math.min(100, 100 - wordingSimilarityPct - phrasePenalty));

  const flags: string[] = [];
  if (wordingSimilarityPct > WORDING_SIMILARITY_FLAG_THRESHOLD) flags.push("high_wording_similarity");
  if (phraseOverlaps.length > 0) flags.push("verbatim_phrase_reuse");
  if (originalityScore < ORIGINALITY_REVIEW_THRESHOLD) flags.push("requires_originality_review");

  return {
    originalityScore: Number(originalityScore.toFixed(2)),
    wordingSimilarityPct: Number(wordingSimilarityPct.toFixed(2)),
    structuralSimilarityPct: Number(structuralSimilarityPct.toFixed(2)),
    phraseOverlaps,
    flags
  };
}
