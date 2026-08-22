/**
 * Cinema Controls — Vendor Parameter Mapping (Atom B)
 *
 * Maps VisualDirection to:
 * - Kling-specific camera_control API params
 * - Seedance/fal.ai motion params
 * - Prompt enrichment text (for all other vendors)
 */

export interface VisualDirection {
  cameraMovement?: string;
  lens?: string;
  lighting?: string;
  colorPalette?: string;
  tempo?: string;
  filmGrain?: string;
  era?: string;
}

// ---------------------------------------------------------------------------
// Kling — native camera_control param
// ---------------------------------------------------------------------------

const KLING_CAMERA_MAP: Record<string, string> = {
  pan_left: "pan_left",
  pan_right: "pan_right",
  tilt_up: "tilt_up",
  tilt_down: "tilt_down",
  tracking: "move_forward",
  dolly_in: "zoom_in",
  dolly_out: "zoom_out",
  orbit: "around_cw",
  handheld: "shake",
  drone: "rise_up",
  helicopter: "rise_up",
  pov: "move_forward",
};

export function mapToKlingParams(dir: VisualDirection): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (dir.cameraMovement && dir.cameraMovement !== "static") {
    const mapped = KLING_CAMERA_MAP[dir.cameraMovement];
    if (mapped) {
      params.camera_control = { type: "predefined", config: { name: mapped } };
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Seedance — fal.ai motion/camera params
// ---------------------------------------------------------------------------

const SEEDANCE_MOTION_MAP: Record<string, string> = {
  pan_left: "pan_left",
  pan_right: "pan_right",
  tilt_up: "tilt_up",
  tilt_down: "tilt_down",
  tracking: "push_in",
  dolly_in: "push_in",
  dolly_out: "pull_out",
  orbit: "orbit_left",
  handheld: "handheld",
  drone: "crane_up",
  helicopter: "crane_up",
  pov: "push_in",
};

const TEMPO_MAP: Record<string, string> = {
  calm: "slow",
  dynamic: "normal",
  chaotic: "fast",
  single_shot: "slow",
};

export function mapToSeedanceParams(dir: VisualDirection): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (dir.cameraMovement && dir.cameraMovement !== "static") {
    const mapped = SEEDANCE_MOTION_MAP[dir.cameraMovement];
    if (mapped) params.camera_control = mapped;
  }
  if (dir.tempo) {
    params.motion_mode = TEMPO_MAP[dir.tempo] ?? "normal";
  }
  return params;
}

// ---------------------------------------------------------------------------
// Prompt Enrichment — for vendors without native cinema controls
// ---------------------------------------------------------------------------

const CAMERA_LABELS: Record<string, string> = {
  static: "static locked-off camera",
  pan_left: "smooth pan left",
  pan_right: "smooth pan right",
  tilt_up: "slow tilt up",
  tilt_down: "slow tilt down",
  tracking: "cinematic tracking shot",
  dolly_in: "smooth dolly in",
  dolly_out: "slow dolly out",
  orbit: "orbital camera movement around subject",
  handheld: "handheld camera with natural shake",
  drone: "aerial drone shot",
  helicopter: "helicopter aerial establishing shot",
  pov: "first-person POV camera",
};

const LENS_LABELS: Record<string, string> = {
  wide: "wide-angle lens",
  normal: "50mm standard lens",
  telephoto: "telephoto compression",
  macro: "macro close-up",
  anamorphic: "anamorphic widescreen lens with horizontal flares",
  fisheye: "fisheye distortion",
};

const LIGHT_LABELS: Record<string, string> = {
  natural: "natural ambient light",
  golden_hour: "warm golden hour sunlight",
  blue_hour: "cool blue hour twilight",
  studio: "controlled studio lighting",
  silhouette: "backlit silhouette",
  neon: "neon-lit urban atmosphere",
  overcast: "soft overcast diffused light",
  dramatic: "dramatic high-contrast lighting",
  soft: "soft diffused flattering light",
};

const COLOR_LABELS: Record<string, string> = {
  neutral: "neutral color grading",
  warm: "warm color tones",
  cool: "cool blue-shifted tones",
  desaturated: "desaturated muted palette",
  high_contrast: "high contrast bold colors",
  pastel: "soft pastel color palette",
  noir: "black and white noir",
  vintage: "vintage faded film colors",
};

const ERA_LABELS: Record<string, string> = {
  "90s": "1990s visual aesthetic",
  "80s": "1980s retro look",
  "70s": "1970s film style",
  film_noir: "classic film noir style",
};

const TEMPO_LABELS: Record<string, string> = {
  calm: "slow calm pacing",
  dynamic: "dynamic energetic movement",
  chaotic: "chaotic fast cuts",
  single_shot: "continuous single take",
};

export function mapToPromptEnrichment(dir: VisualDirection): string {
  const parts: string[] = [];

  if (dir.cameraMovement) {
    parts.push(CAMERA_LABELS[dir.cameraMovement] ?? dir.cameraMovement);
  }
  if (dir.lens) {
    parts.push(LENS_LABELS[dir.lens] ?? dir.lens);
  }
  if (dir.lighting) {
    parts.push(LIGHT_LABELS[dir.lighting] ?? dir.lighting);
  }
  if (dir.colorPalette) {
    parts.push(COLOR_LABELS[dir.colorPalette] ?? dir.colorPalette);
  }
  if (dir.filmGrain && dir.filmGrain !== "none") {
    parts.push(dir.filmGrain === "heavy" ? "heavy film grain texture" : "subtle film grain");
  }
  if (dir.era && dir.era !== "modern") {
    parts.push(ERA_LABELS[dir.era] ?? dir.era);
  }
  if (dir.tempo) {
    parts.push(TEMPO_LABELS[dir.tempo] ?? dir.tempo);
  }

  return parts.join(", ");
}
