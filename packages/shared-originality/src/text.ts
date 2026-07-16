/** Lowercase, strip punctuation, collapse whitespace, split into word tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Contiguous word n-grams, joined with a single space, e.g. ngrams(["a","b","c"], 2) -> ["a b", "b c"]. */
export function ngrams(tokens: string[], n: number): string[] {
  if (tokens.length < n) return [];
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(" "));
  }
  return result;
}

/** |A ∩ B| / |A ∪ B|, as a 0-100 percentage. Both empty is defined as 100 (nothing to compare, trivially "identical"). */
export function jaccardSimilarityPct(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 100;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 100 : (intersection / union) * 100;
}
