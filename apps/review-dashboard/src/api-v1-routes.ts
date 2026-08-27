/**
 * API v1 Route Stubs — Section 18, 39, 40
 *
 * Future public API routes live under /v1/.
 * Separated from internal dashboard routes (/queue, /accounts, etc.)
 * so future API evolution doesn't break the dashboard.
 *
 * ALL ROUTES ARE DISABLED by default (VVUGC_API_ENABLED=false).
 * When disabled, every route returns 404 — indistinguishable from non-existent.
 *
 * When enabled in development (VVUGC_API_ENABLED=true):
 *   - Routes become reachable
 *   - Currently return 501 Not Implemented
 *   - Future: full implementation with auth, quota, idempotency
 */

import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";

// Feature flag check — inline since we can't depend on shared-platform
// at the Express route level without adding the dependency to review-dashboard.
// This mirrors the logic in shared-platform/src/feature-flags.ts.
function isApiEnabled(): boolean {
  const value = process.env.VVUGC_API_ENABLED;
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

export const v1Router: RouterType = Router();

// --------------------------------------------------------------------------
// Feature gate — all /v1 routes return 404 when API is disabled
// --------------------------------------------------------------------------
v1Router.use((_req: Request, res: Response, next) => {
  if (!isApiEnabled()) {
    return res.status(404).json({ error: "not found" });
  }
  next();
});

// --------------------------------------------------------------------------
// Future API routes (Section 18) — stubs returning 501
// --------------------------------------------------------------------------

/** POST /v1/scripts — Generate a script from a niche/topic */
v1Router.post("/scripts", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Script generation API is not yet available", requestId: "" }
  });
});

/** POST /v1/runs — Start a full video generation run */
v1Router.post("/runs", (_req: Request, res: Response) => {
  // Future: authenticate via API key, check quota, check idempotency
  res.status(501).json({
    error: { code: "not_implemented", message: "Run creation API is not yet available", requestId: "" }
  });
});

/** GET /v1/runs/:id — Get run details */
v1Router.get("/runs/:id", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Run retrieval API is not yet available", requestId: "" }
  });
});

/** GET /v1/runs/:id/status — Get run status */
v1Router.get("/runs/:id/status", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Run status API is not yet available", requestId: "" }
  });
});

/** POST /v1/voiceovers — Generate a voiceover */
v1Router.post("/voiceovers", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Voiceover API is not yet available", requestId: "" }
  });
});

/** POST /v1/publish — Publish approved content */
v1Router.post("/publish", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Publishing API is not yet available", requestId: "" }
  });
});

/** POST /v1/videos — Generate a video */
v1Router.post("/videos", (_req: Request, res: Response) => {
  res.status(501).json({
    error: { code: "not_implemented", message: "Video generation API is not yet available", requestId: "" }
  });
});
