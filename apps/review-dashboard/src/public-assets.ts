import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { loadEnv } from "@vvugc/shared-config";

// Ephemeral per-process secret when ASSET_SIGNING_SECRET is unset — same posture
// as auth.ts's auto-generated dashboard credentials. Fine here because a signed
// URL only needs to stay valid for one publish attempt within this process's
// lifetime, not across restarts.
let ephemeralSecret: Buffer | undefined;
function signingSecret(): Buffer {
  const { ASSET_SIGNING_SECRET } = loadEnv();
  if (ASSET_SIGNING_SECRET) return Buffer.from(ASSET_SIGNING_SECRET, "utf8");
  if (!ephemeralSecret) ephemeralSecret = randomBytes(32);
  return ephemeralSecret;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface PublicAssetUrl {
  url: string;
  expiresAt: string;
}

/**
 * Signs a short-lived, single-file public URL for a local video so it can be
 * handed to a vendor API that fetches the video itself rather than accepting
 * uploaded bytes (Instagram Reels' Content Publishing API) — this pipeline has
 * no other public asset host. Requires PUBLIC_BASE_URL to be set to this
 * dashboard's publicly reachable origin; nothing here can supply that
 * automatically (a localhost/private-network dashboard can't produce a URL
 * Meta's servers can actually fetch).
 */
export function createPublicAssetUrl(videoPath: string, ttlMs = 15 * 60 * 1000): PublicAssetUrl {
  const { PUBLIC_BASE_URL, VVUGC_RUNS_DIR } = loadEnv();
  if (!PUBLIC_BASE_URL) {
    throw new Error(
      "PUBLIC_BASE_URL must be set to this dashboard's publicly reachable origin to publish " +
        "Instagram Reels — Meta's Content Publishing API fetches video_url itself and can't reach a private host."
    );
  }

  const absPath = resolve(videoPath);
  const runsRoot = resolve(VVUGC_RUNS_DIR);
  if (!absPath.startsWith(runsRoot + sep)) {
    throw new Error(`refusing to serve a video outside VVUGC_RUNS_DIR: ${videoPath}`);
  }
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    throw new Error(`video file not found: ${videoPath}`);
  }

  const exp = Date.now() + ttlMs;
  const payload = base64Url(JSON.stringify({ p: absPath, exp }));
  const sig = base64Url(createHmac("sha256", signingSecret()).update(payload).digest());

  return {
    url: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/public/assets/${payload}.${sig}`,
    expiresAt: new Date(exp).toISOString()
  };
}

function verifyToken(token: string): string | undefined {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return undefined;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = base64Url(createHmac("sha256", signingSecret()).update(payload).digest());
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return undefined;

  let decoded: { p: string; exp: number };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof decoded.p !== "string" || typeof decoded.exp !== "number" || Date.now() > decoded.exp) {
    return undefined;
  }
  return decoded.p;
}

const publicAssetRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests" }
});

/**
 * Public (no operator Basic Auth) route serving a single video file per
 * signed, time-limited token — registered before the Basic Auth gate in
 * server.ts, same reasoning as /account and /accounts/*. Only files under
 * VVUGC_RUNS_DIR, matching a validly signed and non-expired token, are ever
 * served — this is not a general-purpose static file server, and a token
 * that fails verification (forged, expired, or path-traversal-tampered)
 * gets an indistinguishable 404, not a 403 that would confirm its shape.
 */
export function registerPublicAssetRoute(app: Express): void {
  app.get("/public/assets/:token", publicAssetRateLimiter, (req: Request, res: Response) => {
    const token = req.params.token;
    const absPath = typeof token === "string" ? verifyToken(token) : undefined;
    if (!absPath || !existsSync(absPath) || !statSync(absPath).isFile()) {
      return res.status(404).json({ error: "not found or expired" });
    }
    const stat = statSync(absPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.sendFile(absPath, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });
}
