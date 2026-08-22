/**
 * Soul ID Routes — Persistent Character Identity Training & Status
 *
 * POST /accounts/creators/:id/train — validates images, selects primary, sets faceEmbeddingStatus
 * GET /accounts/creators/:id/identity — returns identity status and primary image URL
 */

import type { Express, Request, Response } from "express";
import pino from "pino";

const logger = pino({ name: "soul-id" });

/**
 * Minimal CreatorProfile shape needed by these routes.
 * The real type is richer — this covers the fields we read/write.
 */
interface CreatorProfileRecord {
  id: string;
  orgId: string;
  displayName: string;
  referenceImages: Array<{ id: string; filePath: string; fileName: string }>;
  avatarMode: "reference_images" | "vendor_avatar" | "none";
  faceEmbeddingStatus?: "none" | "training" | "ready" | "failed";
  primaryReferenceImageUrl?: string;
  [key: string]: unknown;
}

/**
 * Store interface — the review-dashboard already has a creator profile store
 * pattern (JSON file or Postgres). This interface abstracts it for the route.
 */
export interface CreatorProfileStore {
  get(orgId: string, id: string): CreatorProfileRecord | undefined;
  update(orgId: string, id: string, patch: Partial<CreatorProfileRecord>): CreatorProfileRecord | undefined;
}

/**
 * Register Soul ID routes. Called from server.ts after other route registrations.
 * `requireSession` is the same auth middleware used by /accounts/* routes.
 */
export function registerSoulIdRoutes(
  app: Express,
  store: CreatorProfileStore,
  requireSession: (req: Request, res: Response, next: () => void) => void
): void {

  /**
   * POST /accounts/creators/:id/train
   *
   * Validates reference images, selects primary, sets faceEmbeddingStatus to "ready".
   */
  app.post(
    "/accounts/creators/:id/train",
    requireSession,
    async (req: Request, res: Response) => {
      try {
        const orgId = (req as any).session?.orgId ?? (req as any).orgId ?? "";
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

        if (!creatorId) {
          return res.status(400).json({ error: "Missing creator ID" });
        }

        const creator = store.get(orgId, creatorId);
        if (!creator) {
          return res.status(404).json({ error: "Creator profile not found" });
        }

        // Validate avatar mode
        if (creator.avatarMode === "none") {
          return res.status(400).json({
            error: "Cannot train identity: creator avatarMode is 'none'. Set avatarMode to 'reference_images' first."
          });
        }

        // Validate minimum reference images
        const images = creator.referenceImages ?? [];
        if (images.length < 3) {
          return res.status(400).json({
            error: `At least 3 reference images are required for identity training. Currently have ${images.length}. Upload ${3 - images.length} more photo(s).`,
            referenceImageCount: images.length,
            minimumRequired: 3,
          });
        }

        // Select primary image (first image by default — user can override via PUT later)
        const primaryImage = images[0];
        const primaryUrl = primaryImage.filePath; // Served via the media route

        // Update the creator profile
        const updated = store.update(orgId, creatorId, {
          faceEmbeddingStatus: "ready",
          primaryReferenceImageUrl: primaryUrl,
        });

        if (!updated) {
          return res.status(500).json({ error: "Failed to update creator profile" });
        }

        // Do NOT log the image URL (face data is sensitive)
        logger.info(
          { creatorId, orgId, imageCount: images.length, status: "ready" },
          "Soul ID training completed"
        );

        return res.json({
          id: updated.id,
          faceEmbeddingStatus: "ready",
          primaryReferenceImageUrl: primaryUrl,
          referenceImageCount: images.length,
          avatarMode: updated.avatarMode,
          displayName: updated.displayName,
        });
      } catch (err) {
        logger.error({ err }, "Soul ID train failed");
        return res.status(500).json({ error: "Internal error during identity training" });
      }
    }
  );

  /**
   * GET /accounts/creators/:id/identity
   *
   * Returns identity status and primary image URL.
   */
  app.get(
    "/accounts/creators/:id/identity",
    requireSession,
    async (req: Request, res: Response) => {
      try {
        const orgId = (req as any).session?.orgId ?? (req as any).orgId ?? "";
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

        if (!creatorId) {
          return res.status(400).json({ error: "Missing creator ID" });
        }

        const creator = store.get(orgId, creatorId);
        if (!creator) {
          return res.status(404).json({ error: "Creator profile not found" });
        }

        return res.json({
          faceEmbeddingStatus: creator.faceEmbeddingStatus ?? "none",
          primaryReferenceImageUrl: creator.primaryReferenceImageUrl ?? null,
          referenceImageCount: (creator.referenceImages ?? []).length,
          avatarMode: creator.avatarMode,
        });
      } catch (err) {
        logger.error({ err }, "Soul ID identity query failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * PUT /accounts/creators/:id/identity/primary
   *
   * Override the primary reference image (user selects a different one).
   */
  app.put(
    "/accounts/creators/:id/identity/primary",
    requireSession,
    async (req: Request, res: Response) => {
      try {
        const orgId = (req as any).session?.orgId ?? (req as any).orgId ?? "";
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const { imageId } = req.body as { imageId?: string };

        if (!creatorId || !imageId) {
          return res.status(400).json({ error: "Missing creator ID or imageId in body" });
        }

        const creator = store.get(orgId, creatorId);
        if (!creator) {
          return res.status(404).json({ error: "Creator profile not found" });
        }

        const targetImage = (creator.referenceImages ?? []).find((img) => img.id === imageId);
        if (!targetImage) {
          return res.status(404).json({ error: "Image not found in creator's reference images" });
        }

        const updated = store.update(orgId, creatorId, {
          primaryReferenceImageUrl: targetImage.filePath,
        });

        if (!updated) {
          return res.status(500).json({ error: "Failed to update primary image" });
        }

        return res.json({
          primaryReferenceImageUrl: targetImage.filePath,
          faceEmbeddingStatus: updated.faceEmbeddingStatus ?? "none",
        });
      } catch (err) {
        logger.error({ err }, "Soul ID primary update failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );
}
