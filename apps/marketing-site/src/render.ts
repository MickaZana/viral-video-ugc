import { PRICING_TIERS, type PricingTier } from "@vvugc/shared-billing";

export interface VideoEntry {
  id: string;
  type: "product-demo" | "ugc-review";
  niche: string;
  platform: string;
  aspectRatio: string;
  hook: string;
  points: string[];
  cta: string;
  creatorHandle?: string;
  viralityScore: number | null;
  videoPath: string | null;
  posterPath: string;
  status: "placeholder" | "ready";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderVideoCard(entry: VideoEntry): string {
  const media =
    entry.status === "ready" && entry.videoPath
      ? `<video poster="${entry.posterPath}" muted loop playsinline preload="none">
           <source src="${entry.videoPath}" type="video/mp4" />
         </video>
         <button class="play-btn" aria-label="Play video">▶</button>`
      : `<img src="${entry.posterPath}" alt="${escapeHtml(entry.hook)}" loading="lazy" />`;

  const scoreBadge =
    entry.viralityScore != null ? `<span class="badge badge-score">🔥 ${entry.viralityScore}</span>` : "";
  const handle = entry.creatorHandle
    ? `<p class="video-card-handle">${escapeHtml(entry.creatorHandle)}</p>`
    : "";

  return `
    <article class="video-card" data-id="${entry.id}" data-status="${entry.status}">
      <div class="video-card-media">${media}</div>
      <div class="video-card-meta">
        <span class="badge badge-niche">${escapeHtml(entry.niche)}</span>
        ${scoreBadge}
      </div>
      <p class="video-card-caption">"${escapeHtml(entry.hook)}"</p>
      ${handle}
    </article>`;
}

/**
 * Real tier data from @vvugc/shared-billing (the same source /account's billing
 * panel and the Stripe checkout flow read from) — previously the public site's
 * "Pricing" nav link only led to a feature-comparison table with no actual
 * dollar amounts for this product, while the real numbers only ever surfaced
 * behind a signup+login wall. One source of truth now; edit tiers.ts, both
 * surfaces update.
 */
export function renderPricingGrid(tiers: PricingTier[] = PRICING_TIERS): string {
  const highlightIndex = Math.floor((tiers.length - 1) / 2);
  return tiers
    .map((tier, i) => {
      const highlighted = tiers.length > 1 && i === highlightIndex;
      return `
    <article class="price-card${highlighted ? " price-card-highlight" : ""}">
      ${highlighted ? `<span class="price-badge">Most popular</span>` : ""}
      <h3>${escapeHtml(tier.name)}</h3>
      <p class="price-amount"><span class="price-num">$${tier.priceUsdPerMonth}</span><span class="price-period">/mo</span></p>
      <p class="price-limit">${tier.monthlyRunLimit} client runs / month</p>
      <a class="btn ${highlighted ? "btn-primary" : "btn-ghost"} price-cta" href="#cta">Start with ${escapeHtml(tier.name)}</a>
    </article>`;
    })
    .join("\n");
}

export function renderHeroBlock(entry: VideoEntry | undefined): string {
  if (!entry) return `<div class="phone-frame"></div>`;
  const media =
    entry.status === "ready" && entry.videoPath
      ? `<video poster="${entry.posterPath}" autoplay muted loop playsinline>
           <source src="${entry.videoPath}" type="video/mp4" />
         </video>`
      : `<img src="${entry.posterPath}" alt="${escapeHtml(entry.hook)}" />`;
  return `<div class="phone-frame">${media}</div>`;
}

/**
 * Pure: takes the manifest and HTML template as data rather than reading files
 * itself, so it's testable without touching the filesystem.
 *
 * `baseUrl` (no trailing slash, e.g. "https://example.com") fills in {{BASE_URL}}
 * tokens — used for og:url/og:image/twitter:image, which the spec requires as
 * absolute URLs, not the path-only ones a relative `src`/`href` can get away
 * with. Defaults to "" (producing bare "/videos/..." paths) for callers that
 * don't have a real origin yet — see server.ts for how the real server picks
 * PUBLIC_BASE_URL or the incoming request's own origin.
 */
export function renderPage(manifest: VideoEntry[], template: string, baseUrl = ""): string {
  const hero = manifest.find((e) => e.id === "hero-reel");
  const gallery = manifest.filter((e) => e.type === "product-demo" && e.id !== "hero-reel");
  const ugcWall = manifest.filter((e) => e.type === "ugc-review");

  return template
    .replace("{{HERO_BLOCK}}", renderHeroBlock(hero))
    .replace("{{GALLERY_GRID}}", gallery.map(renderVideoCard).join("\n"))
    .replace("{{UGC_WALL_GRID}}", ugcWall.map(renderVideoCard).join("\n"))
    .replace("{{PRICING_GRID}}", renderPricingGrid())
    .replaceAll("{{BASE_URL}}", baseUrl);
}
