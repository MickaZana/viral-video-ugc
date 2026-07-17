import Stripe from "stripe";
import { requireEnvVar } from "@vvugc/shared-config";
import { getTier } from "./tiers.js";

let cachedClient: Stripe | undefined;

/** Lazily constructed (not at module load) so importing this package never requires
 *  STRIPE_SECRET_KEY to be set — only actually calling into Stripe does. Matches the
 *  rest of this repo's "requireEnvVar at the point of use, not at startup" convention
 *  (see @vvugc/shared-config), which is what keeps --dry-run runnable with zero keys. */
function getStripeClient(): Stripe {
  if (!cachedClient) {
    cachedClient = new Stripe(requireEnvVar("STRIPE_SECRET_KEY"));
  }
  return cachedClient;
}

/** Test-only: clears the cached client so a test can swap STRIPE_SECRET_KEY/mock fetch
 *  between cases without a stale client instance carrying over. */
export function resetStripeClientForTests(): void {
  cachedClient = undefined;
}

export interface CreateCheckoutSessionInput {
  accountId: string;
  email: string;
  tierId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Creates a Stripe Checkout session for a subscription to the given tier. The tier's
 * real Stripe Price ID must already be configured (see tiers.ts's stripePriceIdEnvVar) —
 * this deliberately does NOT fall back to a hardcoded price, so a misconfigured
 * deployment fails loudly here rather than accidentally charging the placeholder amount.
 * `client_reference_id` encodes both accountId and tierId (colon-separated) so the
 * webhook handler can attribute the resulting subscription without a second lookup.
 */
export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ url: string }> {
  const tier = getTier(input.tierId);
  if (!tier) throw new Error(`Unknown pricing tier: "${input.tierId}"`);

  const priceId = process.env[tier.stripePriceIdEnvVar];
  if (!priceId) {
    throw new Error(
      `${tier.stripePriceIdEnvVar} is not set — configure it with the real Stripe Price ID for the ` +
        `"${tier.name}" tier before enabling checkout (see .env.example).`
    );
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: input.email,
    client_reference_id: `${input.accountId}::${input.tierId}`,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl
  });

  if (!session.url) throw new Error("Stripe created a checkout session but returned no redirect URL");
  return { url: session.url };
}

/** Verifies and parses a raw webhook payload — must receive the RAW (unparsed) request
 *  body, not JSON-parsed, or Stripe's HMAC signature check fails. See accounts.ts's
 *  webhook route for why this route is registered ahead of the global express.json(). */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const webhookSecret = requireEnvVar("STRIPE_WEBHOOK_SECRET");
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/** Parses the `accountId::tierId` client_reference_id this package's own
 *  createCheckoutSession encodes — returns undefined for anything else (e.g. a
 *  checkout session created outside this flow), so the webhook handler can skip it
 *  rather than crash on an unexpected shape. */
export function parseClientReferenceId(value: string | null | undefined): { accountId: string; tierId: string } | undefined {
  if (!value) return undefined;
  const [accountId, tierId] = value.split("::");
  if (!accountId || !tierId) return undefined;
  return { accountId, tierId };
}
