import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "./settings.js";

describe("createSettingsStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "settings-"));
    return createSettingsStore(join(dir, "settings.json"));
  }

  it("returns sensible built-in defaults for an account that never saved settings", () => {
    const store = freshStore();
    const settings = store.get("account-1");
    expect(settings.accountId).toBe("account-1");
    expect(settings.cadence).toBe("manual");
    expect(settings.platforms).toEqual(["youtube_shorts"]);
  });

  it("upsert saves settings, get returns them back", () => {
    const store = freshStore();
    store.upsert("account-1", {
      niche: "fitness",
      brandVoice: "punchy, direct",
      platforms: ["tiktok", "youtube_shorts"],
      targetDurationSec: 30,
      videoVendor: "kling",
      voiceVendor: "elevenlabs",
      cadence: "weekly"
    });

    const settings = store.get("account-1");
    expect(settings.niche).toBe("fitness");
    expect(settings.platforms).toEqual(["tiktok", "youtube_shorts"]);
    expect(settings.cadence).toBe("weekly");
  });

  it("upsert overwrites previous settings for the same account entirely", () => {
    const store = freshStore();
    store.upsert("account-1", { ...store.get("account-1"), niche: "fitness", voiceVendor: "elevenlabs" });
    const updated = store.upsert("account-1", {
      niche: "finance",
      brandVoice: "calm, trustworthy",
      platforms: ["youtube_shorts"],
      targetDurationSec: 25,
      videoVendor: "higgsfield",
      cadence: "manual"
    });
    expect(updated.niche).toBe("finance");
    expect(updated.voiceVendor).toBeUndefined();
  });

  it("settings for different accounts don't collide", () => {
    const store = freshStore();
    store.upsert("account-1", { ...store.get("account-1"), niche: "fitness" });
    store.upsert("account-2", { ...store.get("account-2"), niche: "finance" });
    expect(store.get("account-1").niche).toBe("fitness");
    expect(store.get("account-2").niche).toBe("finance");
  });

  it("persists across store instances pointed at the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "settings-"));
    const dbPath = join(dir, "settings.json");
    createSettingsStore(dbPath).upsert("account-1", {
      niche: "beauty",
      brandVoice: "warm",
      platforms: ["instagram_reels"],
      targetDurationSec: 20,
      videoVendor: "pika",
      cadence: "weekly"
    });
    expect(createSettingsStore(dbPath).get("account-1").niche).toBe("beauty");
  });
});
