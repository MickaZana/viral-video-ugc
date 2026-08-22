import type { VideoGenRequest } from "./adapters/VideoGenAdapter.js";
export const VIDEO_VENDOR_CAPABILITIES = {
  higgsfield: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: true },
  kling: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  runway: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  pika: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: false, externalMcp: false },
  gemini: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: false, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  replicate: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  seedance: { imageReferences: true, multipleReferences: false, persistentCharacterIds: false, imageToVideo: true, textToVideo: true, wardrobeStyleHints: true, productReferences: true, externalMcp: false },
  grok_video: { imageReferences: false, multipleReferences: false, persistentCharacterIds: false, imageToVideo: false, textToVideo: true, wardrobeStyleHints: true, productReferences: false, externalMcp: false }
} as const;
export function creatorCapabilityWarnings(vendor: keyof typeof VIDEO_VENDOR_CAPABILITIES, request: VideoGenRequest): string[] { const c = VIDEO_VENDOR_CAPABILITIES[vendor]; const warnings: string[] = []; if (request.creatorProfile?.avatarMode === "vendor_avatar" && !c.persistentCharacterIds) warnings.push(`${vendor} does not provide persistent character IDs; identity consistency is not guaranteed`); if (request.referenceImageDataUri && !c.imageReferences) warnings.push(`${vendor} does not support creator image references`); return warnings; }
