import express from "express";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage, type VideoEntry } from "./render.js";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const manifestPath = join(__dirname, "..", "content", "video-manifest.json");

function loadManifest(): VideoEntry[] {
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

const app = express();
app.use(express.static(publicDir, { index: false }));
// @vvugc/design-tokens is a workspace CSS-only package (no build step) — resolve it
// through node_modules symlinking rather than a hardcoded relative repo path, so this
// keeps working regardless of where in the workspace this app is invoked from.
app.get("/tokens.css", (_req, res) => {
  res.type("css").sendFile(require.resolve("@vvugc/design-tokens"));
});

app.get("/", (_req, res) => {
  const template = readFileSync(join(publicDir, "index.html"), "utf-8");
  res.type("html").send(renderPage(loadManifest(), template));
});

app.get("/api/manifest", (_req, res) => {
  res.json(loadManifest());
});

const port = Number(process.env.PORT ?? 4320);
app.listen(port, () => {
  console.log(`Viral Video UGC marketing site listening on http://localhost:${port}`);
});
