import { z } from "zod";

export const PlatformSchema = z.enum(["tiktok", "youtube_shorts", "instagram_reels", "facebook"]);
export type Platform = z.infer<typeof PlatformSchema>;
