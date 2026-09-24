import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCreatorProfileStore } from "./creators.js";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
describe("creator profiles", () => { it("persists tenant-scoped profiles and reference images", () => { const dir = mkdtempSync(join(tmpdir(), "vvugc-creators-")); dirs.push(dir); const store = createCreatorProfileStore(join(dir, "creators.json")); const creator = store.create("org-a", { displayName: "Ava", description: "", referenceImages: [], faceEmbeddingStatus: "none", avatarMode: "reference_images", compatibleVendors: ["gemini"], speechStyle: "warm", tone: "calm", wardrobe: "casual", visualStyle: "natural", language: "en", prohibitedDepictions: [], lipSyncVendor: "none", consentConfirmed: true, active: true }); expect(store.listByOrg("org-a")).toHaveLength(1); expect(store.listByOrg("org-b")).toHaveLength(0); expect(store.archive("org-a", creator.id)).toBe(true); expect(store.getForOrg("org-a", creator.id)?.active).toBe(false); }); });
