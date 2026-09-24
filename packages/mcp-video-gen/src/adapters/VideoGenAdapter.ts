import type { RawClip } from "@vvugc/shared-schema";

export interface VideoGenRequest {
  /** Stable queue idempotency key, forwarded by workers to adapters that support it. */
  idempotencyKey?: string;
  scriptSegmentIndex: number;
  prompt: string;
  durationSec: number;
  aspectRatio: "9:16" | "1:1" | "16:9";
  referenceImageUrl?: string;
  /** Inline image transport for uploaded tenant assets (data:image/... URI). */
  referenceImageDataUri?: string;
  /** Soul ID: persistent face identity reference for character-consistent generation.
   *  When present, adapters that support face references inject the primary image
   *  (and additional images where supported) into the generation call automatically.
   *  Adapters that don't support references (e.g., Gemini) gracefully ignore this. */
  identityRef?: {
    primaryImageUrl: string;
    additionalImageUrls: string[];
    mode: "reference_images" | "vendor_avatar";
  };
  /**
   * Image-to-video: an already-generated starting frame to animate (e.g. from
   * Nano Banana), distinct from identityRef — identityRef says "keep this face
   * consistent," startingFrame says "animate exactly this image." A request can
   * carry both (an identity-consistent character animated from a specific
   * generated pose/scene). Every adapter that accepts a single image input
   * field applies precedence startingFrame > identityRef.primaryImageUrl >
   * referenceImageUrl — the most specific intent wins the one image slot most
   * vendor APIs expose; adapters with a genuinely separate multi-image
   * mechanism (Higgsfield's medias[]) can honor both at once instead.
   */
  startingFrame?: { imageUrl?: string; imageDataUri?: string };
  creatorProfile?: { displayName: string; tone: string; wardrobe: string; visualStyle: string; ageRange?: string; language: string; prohibitedDepictions: string[]; avatarMode: "reference_images" | "vendor_avatar" | "none" };
  /** Cinema Controls: visual direction applied at generation time. */
  visualDirection?: {
    cameraMovement?: "static" | "pan_left" | "pan_right" | "tilt_up" | "tilt_down" | "tracking" | "dolly_in" | "dolly_out" | "orbit" | "handheld" | "drone" | "helicopter" | "pov";
    lens?: "wide" | "normal" | "telephoto" | "macro" | "anamorphic" | "fisheye";
    lighting?: "natural" | "golden_hour" | "blue_hour" | "studio" | "silhouette" | "neon" | "overcast" | "dramatic" | "soft";
    colorPalette?: "neutral" | "warm" | "cool" | "desaturated" | "high_contrast" | "pastel" | "noir" | "vintage";
    tempo?: "calm" | "dynamic" | "chaotic" | "single_shot";
    filmGrain?: "none" | "subtle" | "heavy";
    era?: "modern" | "90s" | "80s" | "70s" | "film_noir";
    /** Cinema Studio 4.0: cinematic genre preset that biases overall aesthetics. */
    genre?: "general" | "action" | "epic" | "drama" | "comedy" | "horror" | "noir" | "sci_fi" | "documentary";
    /** Cinema Studio 4.0: emotional tone guiding expression/atmosphere. */
    emotion?: "joy" | "anger" | "fear" | "sadness" | "surprise" | "trust" | "hope" | "tension" | "nostalgia";
    /** Cinema Studio 4.0: camera hardware emulation affecting texture/bokeh/grain. */
    cameraType?: "modern" | "35mm_film" | "8mm_film" | "dv_camcorder" | "iphone" | "dslr";
  };
}

export interface VideoGenAdapter {
  readonly vendor: RawClip["vendor"];
  generate(req: VideoGenRequest): Promise<RawClip>;
}

/**
 * Higgsfield's tools are only reachable through the MCP connection a Claude
 * Agent SDK session already has (this environment's `HiggsfieldAi` MCP
 * server) — there is no separate public REST API for a standalone Node
 * process to call directly. Adapters for MCP-only vendors take a
 * `callMcpTool` callback the conductor supplies at runtime, rather than
 * making their own HTTP calls, so the same VideoGenAdapter interface covers
 * both "direct REST vendor" (Kling, Runway, Pika) and "MCP-only vendor"
 * (Higgsfield) cases.
 */
export type McpToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
