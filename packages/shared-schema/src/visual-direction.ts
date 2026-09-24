/**
 * Cinema Controls — Visual Direction Schema
 * Atom A: Defines the VisualDirection type used across RunConfig, BatchRequest, and VideoGenRequest.
 */
import { z } from "zod";

export const CameraMovementSchema = z.enum([
  "static", "pan_left", "pan_right", "tilt_up", "tilt_down",
  "tracking", "dolly_in", "dolly_out", "orbit", "handheld",
  "drone", "helicopter", "pov"
]);
export type CameraMovement = z.infer<typeof CameraMovementSchema>;

export const LensSchema = z.enum(["wide", "normal", "telephoto", "macro", "anamorphic", "fisheye"]);
export type Lens = z.infer<typeof LensSchema>;

export const LightingSchema = z.enum([
  "natural", "golden_hour", "blue_hour", "studio", "silhouette",
  "neon", "overcast", "dramatic", "soft"
]);
export type Lighting = z.infer<typeof LightingSchema>;

export const ColorPaletteSchema = z.enum([
  "neutral", "warm", "cool", "desaturated", "high_contrast",
  "pastel", "noir", "vintage"
]);
export type ColorPalette = z.infer<typeof ColorPaletteSchema>;

export const TempoSchema = z.enum(["calm", "dynamic", "chaotic", "single_shot"]);
export type Tempo = z.infer<typeof TempoSchema>;

export const FilmGrainSchema = z.enum(["none", "subtle", "heavy"]);
export type FilmGrain = z.infer<typeof FilmGrainSchema>;

export const EraSchema = z.enum(["modern", "90s", "80s", "70s", "film_noir"]);
export type Era = z.infer<typeof EraSchema>;

export const VisualDirectionSchema = z.object({
  cameraMovement: CameraMovementSchema.optional(),
  lens: LensSchema.optional(),
  lighting: LightingSchema.optional(),
  colorPalette: ColorPaletteSchema.optional(),
  tempo: TempoSchema.optional(),
  filmGrain: FilmGrainSchema.optional(),
  era: EraSchema.optional(),
});

export type VisualDirection = z.infer<typeof VisualDirectionSchema>;
