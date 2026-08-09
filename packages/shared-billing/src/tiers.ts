export interface PricingTier {
  id: string;
  name: string;
  /** Benchmarked against comparable AI-UGC tools, not invented in a vacuum — Yorby
   *  runs roughly $40-$300/mo (see apps/marketing-site/public/index.html's own
   *  comparison table), MakeUGC runs $59/$79/$149 across its three self-serve tiers
   *  plus custom Enterprise pricing. These sit at or below that range on purpose
   *  (a cheaper on-ramp at Starter, undercutting Yorby's ~$300 ceiling at Agency).
   *  Still not vetted against this pipeline's real per-run vendor cost (cost ledger
   *  data from a live run would be the next input) — treat as a market-anchored
   *  starting point, not a final decision, and revisit once real usage data exists. */
  priceUsdPerMonth: number;
  monthlyRunLimit: number;
  /** Billed per run above the monthlyRunLimit. This is the "consumption overage"
   *  model: the subscription includes a run allowance, and heavy users pay per run
   *  beyond it instead of being hard-blocked. Derived from the pipeline's real
   *  per-run vendor cost (roughly $1.50–3.50 for Claude tokens + a video vendor)
   *  plus a margin — a placeholder to revisit once real cost-ledger data exists. */
  overagePriceUsdPerRun: number;
  /** Which env var holds the *real* Stripe Price ID for this tier — see .env.example. */
  stripePriceIdEnvVar: string;
}

export const PRICING_TIERS: PricingTier[] = [
  { id: "starter", name: "Starter", priceUsdPerMonth: 39, monthlyRunLimit: 4, overagePriceUsdPerRun: 6, stripePriceIdEnvVar: "STRIPE_PRICE_ID_STARTER" },
  { id: "growth", name: "Growth", priceUsdPerMonth: 99, monthlyRunLimit: 15, overagePriceUsdPerRun: 5, stripePriceIdEnvVar: "STRIPE_PRICE_ID_GROWTH" },
  { id: "agency", name: "Agency", priceUsdPerMonth: 249, monthlyRunLimit: 60, overagePriceUsdPerRun: 4, stripePriceIdEnvVar: "STRIPE_PRICE_ID_AGENCY" }
];

export function getTier(id: string): PricingTier | undefined {
  return PRICING_TIERS.find((t) => t.id === id);
}
