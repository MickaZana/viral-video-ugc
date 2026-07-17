import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateSession = vi.fn();
const mockConstructEvent = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCreateSession } },
    webhooks: { constructEvent: mockConstructEvent }
  }))
}));

const { createCheckoutSession, constructWebhookEvent, parseClientReferenceId, resetStripeClientForTests } = await import(
  "./stripe-client.js"
);

describe("createCheckoutSession", () => {
  beforeEach(() => {
    mockCreateSession.mockReset();
    resetStripeClientForTests();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PRICE_ID_GROWTH = "price_growth_123";
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_GROWTH;
  });

  it("creates a subscription checkout session with a composite client_reference_id", async () => {
    mockCreateSession.mockResolvedValue({ url: "https://checkout.stripe.com/session-abc" });

    const result = await createCheckoutSession({
      accountId: "account-1",
      email: "a@b.com",
      tierId: "growth",
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel"
    });

    expect(result.url).toBe("https://checkout.stripe.com/session-abc");
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        client_reference_id: "account-1::growth",
        line_items: [{ price: "price_growth_123", quantity: 1 }]
      })
    );
  });

  it("throws a clear error for an unknown tier, without calling Stripe", async () => {
    await expect(
      createCheckoutSession({ accountId: "a", email: "a@b.com", tierId: "not-a-real-tier", successUrl: "x", cancelUrl: "y" })
    ).rejects.toThrow(/Unknown pricing tier/);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("throws a clear, actionable error when the tier's Stripe Price ID env var isn't configured", async () => {
    delete process.env.STRIPE_PRICE_ID_GROWTH;
    await expect(
      createCheckoutSession({ accountId: "a", email: "a@b.com", tierId: "growth", successUrl: "x", cancelUrl: "y" })
    ).rejects.toThrow(/STRIPE_PRICE_ID_GROWTH/);
  });

  it("throws when Stripe creates a session but returns no URL", async () => {
    mockCreateSession.mockResolvedValue({ url: null });
    await expect(
      createCheckoutSession({ accountId: "a", email: "a@b.com", tierId: "growth", successUrl: "x", cancelUrl: "y" })
    ).rejects.toThrow(/no redirect URL/);
  });
});

describe("constructWebhookEvent", () => {
  beforeEach(() => {
    mockConstructEvent.mockReset();
    resetStripeClientForTests();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("passes the raw body and signature through to Stripe's own verification", () => {
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed" });
    const event = constructWebhookEvent(Buffer.from("raw body"), "sig_abc");
    expect(mockConstructEvent).toHaveBeenCalledWith(Buffer.from("raw body"), "sig_abc", "whsec_123");
    expect(event.type).toBe("checkout.session.completed");
  });
});

describe("parseClientReferenceId", () => {
  it("parses a valid accountId::tierId reference", () => {
    expect(parseClientReferenceId("account-1::growth")).toEqual({ accountId: "account-1", tierId: "growth" });
  });

  it("returns undefined for null, empty, or malformed values", () => {
    expect(parseClientReferenceId(null)).toBeUndefined();
    expect(parseClientReferenceId(undefined)).toBeUndefined();
    expect(parseClientReferenceId("")).toBeUndefined();
    expect(parseClientReferenceId("no-separator")).toBeUndefined();
  });
});
