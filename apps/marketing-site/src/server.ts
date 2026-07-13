import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const manifestPath = join(__dirname, "..", "content", "video-manifest.json");

interface VideoEntry {
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

function loadManifest(): VideoEntry[] {
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderVideoCard(entry: VideoEntry): string {
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

function renderHeroBlock(entry: VideoEntry | undefined): string {
  if (!entry) return `<div class="phone-frame"></div>`;
  const media =
    entry.status === "ready" && entry.videoPath
      ? `<video poster="${entry.posterPath}" autoplay muted loop playsinline>
           <source src="${entry.videoPath}" type="video/mp4" />
         </video>`
      : `<img src="${entry.posterPath}" alt="${escapeHtml(entry.hook)}" />`;
  return `<div class="phone-frame">${media}</div>`;
}

function renderPage(): string {
  const manifest = loadManifest();
  const template = readFileSync(join(publicDir, "index.html"), "utf-8");

  const hero = manifest.find((e) => e.id === "hero-reel");
  const gallery = manifest.filter((e) => e.type === "product-demo" && e.id !== "hero-reel");
  const ugcWall = manifest.filter((e) => e.type === "ugc-review");

  return template
    .replace("{{HERO_BLOCK}}", renderHeroBlock(hero))
    .replace("{{GALLERY_GRID}}", gallery.map(renderVideoCard).join("\n"))
    .replace("{{UGC_WALL_GRID}}", ugcWall.map(renderVideoCard).join("\n"));
}

const app = express();
app.use(express.static(publicDir, { index: false }));

app.get("/", (_req, res) => {
  res.type("html").send(renderPage());
});

app.get("/api/manifest", (_req, res) => {
  res.json(loadManifest());
});

const port = Number(process.env.PORT ?? 4320);
app.listen(port, () => {
  console.log(`Viral Video UGC marketing site listening on http://localhost:${port}`);
});
