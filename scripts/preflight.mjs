#!/usr/bin/env node
/**
 * VVUGC preflight — answers one question: what still stands between this
 * checkout and a real, generated video?
 *
 *   node scripts/preflight.mjs            # check the cheapest live path
 *   node scripts/preflight.mjs --vendor replicate
 *   node scripts/preflight.mjs --json
 *
 * Reads .env the same way the app does (dotenv-style, no expansion) and never
 * prints a secret value — only whether each key is present.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const vendorArg = (() => {
  const i = argv.indexOf("--vendor");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "gemini";
})();

/* ------------------------------------------------------------------ env --- */

function parseEnvFile(path) {
  const out = new Map();
  const seen = new Map(); // key -> Set of distinct values
  if (!existsSync(path)) return { out, conflicting: [], harmlessDupes: [], missingFile: true };
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(val);
    out.set(key, val);
  }
  // A key defined twice with the SAME value is untidy. Defined twice with
  // DIFFERENT values is a live bug: which one wins depends on loader precedence,
  // and the loser is silently ignored — including a key you think is in use.
  const conflicting = [...seen].filter(([, v]) => v.size > 1).map(([k]) => k);
  const harmlessDupes = [];
  return { out, conflicting, harmlessDupes, missingFile: false };
}

const { out: fileEnv, conflicting, missingFile } = parseEnvFile(join(ROOT, ".env"));

/** Process env wins, mirroring how the app is actually run in a container. */
function get(key) {
  const v = process.env[key] ?? fileEnv.get(key);
  return v === undefined || v === "" ? undefined : v;
}
const has = (key) => get(key) !== undefined;
const isTrue = (key) => String(get(key) ?? "").toLowerCase() === "true";

/* -------------------------------------------------------------- vendors --- */

/** Video vendors and what each one needs to produce clips for real. */
const VENDORS = {
  gemini: { keys: ["GEMINI_API_KEY"], note: "stills + Ken Burns pan; cheapest live path, plain REST" },
  replicate: { keys: ["REPLICATE_API_TOKEN"], note: "many hosted text-to-video models behind one token" },
  kling: { keys: ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"], note: "signed JWT from an access/secret pair" },
  runway: { keys: ["RUNWAY_API_KEY"], note: "" },
  pika: { keys: ["FAL_KEY"], note: "served through fal.ai, not a Pika-specific key" },
  seedance: { keys: ["FAL_KEY"], note: "no standalone first-party API; served through fal.ai like pika" },
  grok_video: { keys: ["XAI_API_KEY"], note: "" },
  higgsfield: { keys: [], note: "needs a Claude Agent SDK session with the Higgsfield MCP server attached — not reachable from a plain CLI run" }
};

const VOICE = {
  elevenlabs: ["ELEVENLABS_API_KEY"],
  grok: ["XAI_API_KEY"]
};

/* --------------------------------------------------------------- checks --- */

const checks = [];
const add = (level, name, ok, detail, fix) =>
  checks.push({ level, name, ok, detail, fix });

// --- 1. LLM: hard-required, no substitute -----------------------------------
add(
  "blocker",
  "ANTHROPIC_API_KEY",
  has("ANTHROPIC_API_KEY"),
  has("ANTHROPIC_API_KEY")
    ? "present"
    : "absent — script, QA and caption agents all fail immediately",
  "generateWithFailover() calls requireEnvVar('ANTHROPIC_API_KEY') before it tries anything. " +
    "GEMINI_API_KEY is a failover for provider *outages*, deliberately not a substitute for a " +
    "missing key. Get one at https://console.anthropic.com/settings/keys"
);

// --- 2. Governance gates ----------------------------------------------------
add(
  "blocker",
  "VVUGC_LLM_LIVE",
  isTrue("VVUGC_LLM_LIVE"),
  isTrue("VVUGC_LLM_LIVE")
    ? "true — live LLM/vendor calls permitted"
    : "not 'true' — every run is forced to dry-run, mock output only",
  "Set VVUGC_LLM_LIVE=true. This is the environment half of the two-key lock; a client " +
    "sending live:true is not enough on its own."
);

add(
  "warn",
  "VVUGC_DISCOVERY_LIVE",
  isTrue("VVUGC_DISCOVERY_LIVE"),
  isTrue("VVUGC_DISCOVERY_LIVE")
    ? "true — real platform discovery enabled"
    : "not 'true' — discovery returns zero candidates and the brief is seeded from the niche text",
  "Not fatal: the pipeline still produces a video from a seeded brief. Set it to true to " +
    "source real trending videos."
);

add(
  "info",
  "SCHEDULED_RUNS_LIVE",
  isTrue("SCHEDULED_RUNS_LIVE"),
  isTrue("SCHEDULED_RUNS_LIVE")
    ? "true — cron runs may go live"
    : "not set — scheduled/cron runs stay in dry-run",
  "Only relevant once the weekly cadence is deployed. Requires VVUGC_LLM_LIVE too."
);

// --- 3. Discovery -----------------------------------------------------------
// YouTube, TikTok, and Instagram discovery are all implemented and tested in
// packages/mcp-discovery — none is a stub. What gates each one is platform
// approval for the credentials, not missing code, so all three are worth
// surfacing rather than singling out YouTube.
add(
  "warn",
  "YOUTUBE_API_KEY",
  has("YOUTUBE_API_KEY"),
  has("YOUTUBE_API_KEY") ? "present" : "absent",
  "Simplest to obtain of the three live discovery sources — a single API key, no approval process."
);
add(
  "info",
  "TIKTOK_CLIENT_KEY/SECRET",
  has("TIKTOK_CLIENT_KEY") && has("TIKTOK_CLIENT_SECRET"),
  has("TIKTOK_CLIENT_KEY") && has("TIKTOK_CLIENT_SECRET") ? "present" : "absent",
  "TikTok Research API, client-credentials OAuth. Gated behind TikTok's developer approval process, not missing code."
);
add(
  "info",
  "META_ACCESS_TOKEN",
  has("META_ACCESS_TOKEN") && has("META_IG_BUSINESS_ACCOUNT_ID"),
  has("META_ACCESS_TOKEN") && has("META_IG_BUSINESS_ACCOUNT_ID") ? "present" : "absent",
  "Instagram hashtag discovery, also needs META_IG_BUSINESS_ACCOUNT_ID. Gated behind Meta app review, not missing code."
);
if (!has("YOUTUBE_API_KEY") && !has("TIKTOK_CLIENT_KEY") && !has("META_ACCESS_TOKEN")) {
  add(
    "warn",
    "discovery: any source",
    false,
    "no discovery source configured — live discovery yields nothing",
    "Set up at least one of YOUTUBE_API_KEY, TIKTOK_CLIENT_KEY/SECRET, or META_ACCESS_TOKEN/META_IG_BUSINESS_ACCOUNT_ID."
  );
}

// --- 4. Video vendor --------------------------------------------------------
const vendor = VENDORS[vendorArg];
if (!vendor) {
  add("blocker", `--vendor ${vendorArg}`, false, "unknown vendor", `Known: ${Object.keys(VENDORS).join(", ")}`);
} else if (vendorArg === "higgsfield") {
  add(
    "blocker",
    "video vendor: higgsfield",
    false,
    "not runnable from a plain CLI run",
    vendor.note + ". Use --vendor gemini or --vendor replicate for a standalone run."
  );
} else {
  const missing = vendor.keys.filter((k) => !has(k));
  add(
    "blocker",
    `video vendor: ${vendorArg}`,
    missing.length === 0,
    missing.length === 0
      ? `ready (${vendor.keys.join(", ")})`
      : `missing ${missing.join(", ")}`,
    vendor.note
  );
}

// --- 5. Transcription -------------------------------------------------------
add(
  "info",
  "OPENAI_API_KEY",
  has("OPENAI_API_KEY"),
  has("OPENAI_API_KEY") ? "present — ASR fallback available" : "absent",
  "Only used when a candidate has no platform caption track. Needs python3 on the host " +
    "for yt-dlp audio extraction."
);

// --- 6. Voiceover (optional) ------------------------------------------------
for (const [name, keys] of Object.entries(VOICE)) {
  const missing = keys.filter((k) => !has(k));
  add(
    "info",
    `voiceover: ${name}`,
    missing.length === 0,
    missing.length === 0 ? "available" : `needs ${missing.join(", ")}`,
    "Optional. Omit --voice-vendor and videos stay silent / vendor-native audio."
  );
}

// --- 7. Bundled binaries, not system installs -------------------------------
const require_ = createRequire(import.meta.url);
for (const [label, mod] of [["ffmpeg", "ffmpeg-static"], ["ffprobe", "ffprobe-static"]]) {
  let ok = false;
  let detail = "not resolvable — run `pnpm install`";
  try {
    const resolved = require_.resolve(mod, { paths: [join(ROOT, "packages", "mcp-assembly"), ROOT] });
    ok = Boolean(resolved);
    detail = "bundled via " + mod + " (no system install needed)";
  } catch {
    /* leave defaults */
  }
  add("blocker", label, ok, detail, "Assembly cannot stitch clips without it.");
}

// --- 8. Python (yt-dlp) -----------------------------------------------------
add(
  "info",
  "python3",
  true,
  "required on the host only for the yt-dlp ASR fallback path",
  "Check with `python3 --version`. Not needed if every candidate has captions."
);

// --- 9. Build artifacts -----------------------------------------------------
const built = existsSync(join(ROOT, "apps", "orchestrator", "dist", "cli.js"));
add(
  "warn",
  "build",
  built,
  built ? "orchestrator dist present" : "orchestrator not built",
  "Run `pnpm install && pnpm build` (or use `pnpm cli` which runs from source via tsx)."
);

// --- 10. Hygiene ------------------------------------------------------------
if (missingFile) {
  add("blocker", ".env", false, "no .env at repo root", "cp .env.example .env");
}
if (conflicting.length) {
  add(
    "blocker",
    ".env conflicts",
    false,
    `defined twice with different values: ${conflicting.join(", ")}`,
    "Only one of the two is actually in use and which one depends on loader precedence — " +
      "so a key you believe is live may be silently ignored. Decide which value is correct, " +
      "delete the other line. Not something a script should guess for you."
  );
}

/* --------------------------------------------------------------- output --- */

const blockers = checks.filter((c) => c.level === "blocker" && !c.ok);
const warns = checks.filter((c) => c.level === "warn" && !c.ok);

if (asJson) {
  console.log(JSON.stringify({ vendor: vendorArg, ready: blockers.length === 0, checks }, null, 2));
  process.exit(blockers.length === 0 ? 0 : 1);
}

const C = process.stdout.isTTY
  ? { r: "\x1b[31m", y: "\x1b[33m", g: "\x1b[32m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" }
  : { r: "", y: "", g: "", d: "", b: "", x: "" };

const mark = (c) => (c.ok ? `${C.g}ok  ${C.x}` : c.level === "blocker" ? `${C.r}FAIL${C.x}` : c.level === "warn" ? `${C.y}warn${C.x}` : `${C.d}--  ${C.x}`);

console.log(`\n${C.b}VVUGC preflight${C.x} ${C.d}— video vendor: ${vendorArg}${C.x}\n`);
for (const c of checks) {
  console.log(`  ${mark(c)}  ${c.name.padEnd(24)} ${C.d}${c.detail}${C.x}`);
}

console.log("");
if (blockers.length === 0) {
  console.log(`  ${C.g}${C.b}Ready.${C.x} Nothing but credentials stands in the way. Try:\n`);
  console.log(`    pnpm cli run --niche=fitness --platforms=youtube_shorts \\`);
  console.log(`      --video-vendor=${vendorArg} --max-candidates=1\n`);
} else {
  console.log(`  ${C.r}${C.b}${blockers.length} blocker${blockers.length > 1 ? "s" : ""}:${C.x}\n`);
  for (const c of blockers) {
    console.log(`  ${C.b}${c.name}${C.x} — ${c.detail}`);
    if (c.fix) console.log(`    ${C.d}${c.fix}${C.x}`);
    console.log("");
  }
}
if (warns.length) {
  console.log(`  ${C.y}${warns.length} warning${warns.length > 1 ? "s" : ""}${C.x} ${C.d}(non-fatal)${C.x}`);
  for (const c of warns) console.log(`    ${C.d}${c.name}: ${c.detail}${C.x}`);
  console.log("");
}

process.exit(blockers.length === 0 ? 0 : 1);
