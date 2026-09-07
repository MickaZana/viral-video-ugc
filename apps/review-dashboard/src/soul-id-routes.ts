/**
 * Soul ID Routes — Persistent Character Identity Training & Status
 *
 * POST /accounts/creators/:id/train — validates images, selects primary, sets faceEmbeddingStatus
 * GET /accounts/creators/:id/identity — returns identity status and primary image URL
 * PUT /accounts/creators/:id/identity/primary — override the selected primary reference image
 */

import type { Express, Response, RequestHandler } from "express";
import pino from "pino";
import { resolveOrgId } from "@vvugc/shared-auth";
import type { AuthedRequest } from "./accounts.js";
import type { CreatorProfile } from "@vvugc/shared-schema";
import type { CreatorProfileInput, TenantProfileRepository } from "./tenant-profile-postgres.js";

const logger = pino({ name: "soul-id" });

/**
 * `creatorUpdate` takes a full `CreatorProfileInput`, not a patch — this builds
 * one from the fetched profile (dropping the fields the store manages itself)
 * and overrides only the fields actually changing. Shared by the train and
 * primary-override handlers below.
 */
function creatorProfileInputWithOverrides(
  creator: CreatorProfile,
  overrides: Partial<CreatorProfileInput>
): CreatorProfileInput {
  const { id: _id, orgId: _orgId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = creator;
  return { ...rest, ...overrides };
}

/**
 * `CreatorProfileSchema.primaryReferenceImageUrl` requires a fully-qualified
 * URL (`z.string().url()`) — a reference image's stored `filePath` is a
 * repo-relative path (e.g. "creator-assets/<org>/<creator>/<id>.png"), not a
 * URL, and would fail schema validation on write. Point at this app's own
 * existing session-authed image route (the same one that already serves
 * these bytes for the control panel) so the stored value is always a real,
 * fetchable, schema-valid absolute URL.
 */
function creatorImageUrl(req: AuthedRequest, creatorId: string, imageId: string): string {
  return `${req.protocol}://${req.get("host")}/accounts/creators/${creatorId}/images/${imageId}`;
}

/**
 * Register Soul ID routes. Called from server.ts after other route registrations.
 * `requireSession` is the same auth middleware returned by registerAccountRoutes
 * (accounts.ts) — it populates req.account, which is what org-id resolution below
 * relies on.
 */
export function registerSoulIdRoutes(
  app: Express,
  deps: { tenantProfiles: TenantProfileRepository },
  requireSession: RequestHandler
): void {

  /**
   * POST /accounts/creators/:id/train
   *
   * Validates reference images, selects primary, sets faceEmbeddingStatus to "ready".
   */
  app.post(
    "/accounts/creators/:id/train",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const account = req.account;
        if (!account) return res.status(401).json({ error: "not authenticated" });
        const orgId = resolveOrgId(account);
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

        if (!creatorId) {
          return res.status(400).json({ error: "Missing creator ID" });
        }

        const creator = await deps.tenantProfiles.creatorGet(orgId, creatorId);
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
        const primaryUrl = creatorImageUrl(req, creatorId, primaryImage.id); // Served via the media route

        // Update the creator profile
        const updated = await deps.tenantProfiles.creatorUpdate(
          orgId,
          creatorId,
          creatorProfileInputWithOverrides(creator, {
            faceEmbeddingStatus: "ready",
            primaryReferenceImageUrl: primaryUrl,
          })
        );

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
    async (req: AuthedRequest, res: Response) => {
      try {
        const account = req.account;
        if (!account) return res.status(401).json({ error: "not authenticated" });
        const orgId = resolveOrgId(account);
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

        if (!creatorId) {
          return res.status(400).json({ error: "Missing creator ID" });
        }

        const creator = await deps.tenantProfiles.creatorGet(orgId, creatorId);
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
    async (req: AuthedRequest, res: Response) => {
      try {
        const account = req.account;
        if (!account) return res.status(401).json({ error: "not authenticated" });
        const orgId = resolveOrgId(account);
        const creatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const { imageId } = req.body as { imageId?: string };

        if (!creatorId || !imageId) {
          return res.status(400).json({ error: "Missing creator ID or imageId in body" });
        }

        const creator = await deps.tenantProfiles.creatorGet(orgId, creatorId);
        if (!creator) {
          return res.status(404).json({ error: "Creator profile not found" });
        }

        const targetImage = (creator.referenceImages ?? []).find((img) => img.id === imageId);
        if (!targetImage) {
          return res.status(404).json({ error: "Image not found in creator's reference images" });
        }

        const primaryUrl = creatorImageUrl(req, creatorId, targetImage.id);
        const updated = await deps.tenantProfiles.creatorUpdate(
          orgId,
          creatorId,
          creatorProfileInputWithOverrides(creator, {
            primaryReferenceImageUrl: primaryUrl,
          })
        );

        if (!updated) {
          return res.status(500).json({ error: "Failed to update primary image" });
        }

        return res.json({
          primaryReferenceImageUrl: primaryUrl,
          faceEmbeddingStatus: updated.faceEmbeddingStatus ?? "none",
        });
      } catch (err) {
        logger.error({ err }, "Soul ID primary update failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );
}
