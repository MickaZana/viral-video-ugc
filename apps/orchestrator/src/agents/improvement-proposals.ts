/**
 * Run-local, advisory improvement proposals derived only from this run's QA results.
 * This module cannot change prompts, code, settings, credentials, tools, schedules,
 * deployments, or launch runs. A human must review and explicitly apply any change.
 */
import { z } from "zod";

const MAX_PROPOSALS = 3;
const MAX_EVIDENCE = 180;

export const ImprovementProposalSetSchema = z.object({
  version: z.literal(1),
  status: z.enum(["proposals", "none"]),
  advisoryOnly: z.literal(true),
  requiresHumanApproval: z.literal(true),
  proposals: z.array(z.object({
    id: z.string().min(1).max(40),
    suggestion: z.string().min(1).max(120),
    evidence: z.string().min(1).max(MAX_EVIDENCE),
  })).max(MAX_PROPOSALS),
}).refine((value) => (value.status === "none") === (value.proposals.length === 0), {
  message: "status must be none exactly when proposals is empty",
});

export type QaObservation = {
  candidateId: string;
  platform: string;
  score: number;
  flags: string[];
};

const FLAG_SUGGESTIONS: Record<string, string> = {
  hook_too_long: "Review hook length against the platform's opening beat.",
  weak_hook: "Review the opening hook for a clearer curiosity gap.",
  missing_cta: "Review the script structure for a clear closing call to action.",
  weak_cta: "Review the closing call to action for a more specific next step.",
  duration_mismatch: "Review clip timing and target duration for this platform.",
  unsupported_claims: "Review product claims against the approved claims profile.",
  forbidden_product_claim: "Review the flagged product claim against the forbidden claims profile before publishing.",
  prohibited_creator_depiction: "Review the flagged creator depiction against the creator safety profile before publishing.",
  low_trending_phrase_density: "Review whether relevant trending phrases can be added without changing the script's meaning.",
  template_mismatch: "Review whether the selected template's required beats are present.",
  template_forbidden_pattern: "Review the script for the selected template's restricted patterns.",
  no_captions: "Review caption rendering for this platform.",
  few_hashtags: "Review platform metadata for an appropriate hashtag set.",
};

/** Creates no more than three reviewable suggestions from fixed QA signal mappings. */
export function createImprovementProposals(observations: readonly QaObservation[]) {
  const proposals: Array<{ id: string; suggestion: string; evidence: string }> = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    if (!Number.isFinite(observation.score) || observation.score < 0 || observation.score > 100) continue;
    for (const flag of observation.flags) {
      const suggestion = FLAG_SUGGESTIONS[flag];
      if (!suggestion || seen.has(flag)) continue;
      seen.add(flag);
      const candidateId = observation.candidateId.slice(0, 48);
      const platform = observation.platform.slice(0, 32);
      const evidence = `Run QA: ${flag}; score ${Math.round(observation.score)}/100; ${platform}; candidate ${candidateId}`
        .slice(0, MAX_EVIDENCE);
      proposals.push({ id: `qa-${flag}`.slice(0, 40), suggestion, evidence });
      if (proposals.length >= MAX_PROPOSALS) break;
    }
    if (proposals.length >= MAX_PROPOSALS) break;
  }

  return ImprovementProposalSetSchema.parse({
    version: 1,
    status: proposals.length ? "proposals" : "none",
    advisoryOnly: true,
    requiresHumanApproval: true,
    proposals,
  });
}
