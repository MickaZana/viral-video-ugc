import { describe, expect, it } from "vitest";
import type { PricingTier } from "@vvugc/shared-billing";
import { escapeHtml, renderHeroBlock, renderPage, renderPricingGrid, renderVideoCard, type VideoEntry } from "./render.js";

function makeEntry(overrides: Partial<VideoEntry> = {}): VideoEntry {
  return {
    id: "demo-fitness",
    type: "product-demo",
    niche: "fitness",
    platform: "tiktok",
    aspectRatio: "9:16",
    hook: "Wait for it",
    points: ["p1"],
    cta: "Follow",
    viralityScore: null,
    videoPath: null,
    posterPath: "/videos/demo-fitness.svg",
    status: "placeholder",
    ...overrides
  };
}

describe("escapeHtml", () => {
  it("escapes &, <, >, and \" but leaves other characters alone", () => {
    expect(escapeHtml(`<b>Tom & "Jerry"</b>`)).toBe("&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;");
  });
});

describe("renderVideoCard", () => {
  it("renders a placeholder card as an <img>, never a broken <video> tag", () => {
    const html = renderVideoCard(makeEntry({ status: "placeholder", videoPath: null }));
    expect(html).toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).toContain('data-status="placeholder"');
  });

  it("renders a ready card as a <video> with a play button, using videoPath/posterPath", () => {
    const html = renderVideoCard(
      makeEntry({ status: "ready", videoPath: "/videos/demo-fitness.mp4", posterPath: "/videos/demo-fitness.jpg" })
    );
    expect(html).toContain("<video");
    expect(html).toContain('src="/videos/demo-fitness.mp4"');
    expect(html).toContain('poster="/videos/demo-fitness.jpg"');
    expect(html).toContain("play-btn");
  });

  it("shows the virality score badge only when non-null", () => {
    expect(renderVideoCard(makeEntry({ viralityScore: 87 }))).toContain("🔥 87");
    expect(renderVideoCard(makeEntry({ viralityScore: null }))).not.toContain("badge-score");
  });

  it("shows the creator handle only for UGC-review entries that have one", () => {
    expect(renderVideoCard(makeEntry({ creatorHandle: "@jordan.creates" }))).toContain("@jordan.creates");
    expect(renderVideoCard(makeEntry({ creatorHandle: undefined }))).not.toContain("video-card-handle");
  });

  it("HTML-escapes the hook and niche so manifest content can't break out of markup", () => {
    const html = renderVideoCard(makeEntry({ hook: `<script>alert(1)</script>`, niche: `fit & healthy` }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("fit &amp; healthy");
  });
});

describe("renderHeroBlock", () => {
  it("renders an empty phone-frame when there's no hero entry", () => {
    expect(renderHeroBlock(undefined)).toBe('<div class="phone-frame"></div>');
  });

  it("renders a poster image for a placeholder hero", () => {
    const html = renderHeroBlock(makeEntry({ status: "placeholder" }));
    expect(html).toContain("<img");
    expect(html).not.toContain("<video");
  });

  it("renders an autoplay/muted/loop video for a ready hero", () => {
    const html = renderHeroBlock(makeEntry({ status: "ready", videoPath: "/videos/hero.mp4" }));
    expect(html).toContain("autoplay");
    expect(html).toContain("muted");
    expect(html).toContain("loop");
    expect(html).toContain('src="/videos/hero.mp4"');
  });
});

describe("renderPricingGrid", () => {
  const tiers: PricingTier[] = [
    { id: "starter", name: "Starter", priceUsdPerMonth: 39, monthlyRunLimit: 4, overagePriceUsdPerRun: 6, stripePriceIdEnvVar: "STRIPE_PRICE_ID_STARTER" },
    { id: "growth", name: "Growth", priceUsdPerMonth: 99, monthlyRunLimit: 15, overagePriceUsdPerRun: 5, stripePriceIdEnvVar: "STRIPE_PRICE_ID_GROWTH" },
    { id: "agency", name: "Agency", priceUsdPerMonth: 249, monthlyRunLimit: 60, overagePriceUsdPerRun: 4, stripePriceIdEnvVar: "STRIPE_PRICE_ID_AGENCY" }
  ];

  it("renders one card per tier with its real name, price, and run limit", () => {
    const html = renderPricingGrid(tiers);
    for (const tier of tiers) {
      expect(html).toContain(`<h3>${tier.name}</h3>`);
      expect(html).toContain(`$${tier.priceUsdPerMonth}`);
      expect(html).toContain(`${tier.monthlyRunLimit} client runs / month`);
    }
  });

  it("highlights exactly the middle tier of an odd-length list as 'Most popular'", () => {
    const html = renderPricingGrid(tiers);
    expect(html).toContain("price-badge");
    expect((html.match(/price-badge/g) ?? []).length).toBe(1);
    const growthStart = html.indexOf("Growth");
    const badgeStart = html.indexOf("price-badge");
    const starterStart = html.indexOf("Starter");
    expect(badgeStart).toBeLessThan(growthStart);
    expect(badgeStart).toBeGreaterThan(starterStart);
  });

  it("defaults to the real @vvugc/shared-billing tiers when called with no argument", () => {
    const html = renderPricingGrid();
    expect(html).toContain("Starter");
    expect(html).toContain("Growth");
    expect(html).toContain("Agency");
  });
});

describe("renderPage", () => {
  const template = `<div class="hero">{{HERO_BLOCK}}</div><div class="gallery">{{GALLERY_GRID}}</div><div class="wall">{{UGC_WALL_GRID}}</div>`;

  it("splits the manifest into hero / gallery / UGC-wall sections by id and type", () => {
    const manifest: VideoEntry[] = [
      makeEntry({ id: "hero-reel", type: "product-demo" }),
      makeEntry({ id: "demo-a", type: "product-demo" }),
      makeEntry({ id: "ugc-a", type: "ugc-review", creatorHandle: "@a" })
    ];
    const html = renderPage(manifest, template);
    expect(html).not.toContain("{{");
    expect(html).toContain('data-id="demo-a"');
    expect(html).toContain('data-id="ugc-a"');
    expect(html).toContain("@a");
  });

  it("leaves no unreplaced template tokens even with an empty manifest", () => {
    const html = renderPage([], template);
    expect(html).not.toContain("{{HERO_BLOCK}}");
    expect(html).not.toContain("{{GALLERY_GRID}}");
    expect(html).not.toContain("{{UGC_WALL_GRID}}");
  });

  it("excludes the hero-reel entry from the gallery grid", () => {
    const manifest: VideoEntry[] = [
      makeEntry({ id: "hero-reel", type: "product-demo" }),
      makeEntry({ id: "demo-a", type: "product-demo" })
    ];
    const html = renderPage(manifest, template);
    const galleryStart = html.indexOf('class="gallery"');
    const wallStart = html.indexOf('class="wall"');
    const gallerySection = html.slice(galleryStart, wallStart);
    expect(gallerySection).toContain('data-id="demo-a"');
    expect(gallerySection).not.toContain('data-id="hero-reel"');
  });

  describe("{{BASE_URL}} substitution", () => {
    const ogTemplate = `<meta property="og:url" content="{{BASE_URL}}/" /><meta property="og:image" content="{{BASE_URL}}/videos/hero-reel.svg" /><meta name="twitter:image" content="{{BASE_URL}}/videos/hero-reel.svg" />${template}`;

    it("replaces every {{BASE_URL}} occurrence with the given absolute origin", () => {
      const html = renderPage([], ogTemplate, "https://example.com");
      expect(html).not.toContain("{{BASE_URL}}");
      expect(html).toContain('content="https://example.com/"');
      expect(html).toContain('content="https://example.com/videos/hero-reel.svg"');
    });

    it("defaults to an empty string, leaving path-relative URLs, when no baseUrl is given", () => {
      const html = renderPage([], ogTemplate);
      expect(html).not.toContain("{{BASE_URL}}");
      expect(html).toContain('content="/"');
      expect(html).toContain('content="/videos/hero-reel.svg"');
    });
  });
});
