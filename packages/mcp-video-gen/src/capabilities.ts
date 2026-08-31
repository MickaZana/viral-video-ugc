import type { VideoGenRequest } from "./adapters/VideoGenAdapter.js";
export const VIDEO_VENDOR_CAPABILITIES = {
  higgsfield: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: true },
  kling: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  runway: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  pika: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: false, externalMcp: false },
  gemini: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: false, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  replicate: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  // multipleReferences: true as of the 2.5 upgrade — reference-to-video sends
  // identityRef's full primary+additional set (up to 50) as image_urls, not
  // just the primary image the way 2.0's single image_url slot could. See
  // seedance.ts's endpoint-selection comment for the exact routing logic.
  seedance: { imageReferences: true, multipleReferences: true, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  grok_video: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: false, textToVideo: true, wardrobeStyleHints: true, productReferences: false, externalMcp: false },
  // Confirmed live against Replicate's real input schema for alibaba/wan-3 (see
  // wan.ts's header comment): a single `image` field for image-to-video, no
  // dedicated multi-reference field on this adapter's request shape today even
  // though Wan 3.0 itself supports up to 10 references — multipleReferences
  // stays false until the adapter actually sends more than one image.
  wan: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false }
} as const;
export function creatorCapabilityWarnings(vendor: keyof typeof VIDEO_VENDOR_CAPABILITIES, request: VideoGenRequest): string[] { const c = VIDEO_VENDOR_CAPABILITIES[vendor]; const warnings: string[] = []; if (request.creatorProfile?.avatarMode === "vendor_avatar" && !c.persistentCharacterIds) warnings.push(`${vendor} does not provide persistent character IDs; identity consistency is not guaranteed`); if (request.referenceImageDataUri && !c.imageReferences) warnings.push(`${vendor} does not support creator image references`); return warnings; }
