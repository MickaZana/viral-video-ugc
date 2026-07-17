export interface PricingTier {
  id: string;
  name: string;
  /** PLACEHOLDER pricing — these numbers were never provided by the product owner and
   *  must be replaced with real figures (and matched to a real Stripe Price object via
   *  the env var below) before this is used to actually charge anyone. Kept here only
   *  so the metering/checkout/webhook plumbing has something concrete to wire against. */
  priceUsdPerMonth: number;
  monthlyRunLimit: number;
  /** Which env var holds the *real* Stripe Price ID for this tier — see .env.example. */
  stripePriceIdEnvVar: string;
}

export const PRICING_TIERS: PricingTier[] = [
  { id: "starter", name: "Starter", priceUsdPerMonth: 49, monthlyRunLimit: 4, stripePriceIdEnvVar: "STRIPE_PRICE_ID_STARTER" },
  { id: "growth", name: "Growth", priceUsdPerMonth: 149, monthlyRunLimit: 20, stripePriceIdEnvVar: "STRIPE_PRICE_ID_GROWTH" },
  { id: "agency", name: "Agency", priceUsdPerMonth: 399, monthlyRunLimit: 100, stripePriceIdEnvVar: "STRIPE_PRICE_ID_AGENCY" }
];

export function getTier(id: string): PricingTier | undefined {
  return PRICING_TIERS.find((t) => t.id === id);
}
