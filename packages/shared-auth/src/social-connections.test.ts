import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSocialConnectionStore, rotateSocialConnectionEncryptionKey } from "./social-connections.js";

describe("social connection encryption and rotation", () => {
  it("keeps tokens encrypted and preserves them across key rotation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vvugc-social-")), "connections.json");
    const oldKey = "old-social-token-key-at-least-32-characters";
    const newKey = "new-social-token-key-at-least-32-characters";
    const oldStore = createSocialConnectionStore(path, oldKey);
    const connection = oldStore.connect("org-1", {
      clientId: "client-1",
      platform: "youtube_shorts",
      accountLabel: "Channel",
      accessToken: "access-secret",
      refreshToken: "refresh-secret"
    });
    expect(readFileSync(path, "utf8")).not.toContain("access-secret");
    expect(rotateSocialConnectionEncryptionKey(path, oldKey, newKey)).toBe(1);
    const newStore = createSocialConnectionStore(path, newKey);
    expect(newStore.getSecrets("org-1", connection.id)).toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret"
    });
    expect(() => oldStore.getSecrets("org-1", connection.id)).toThrow();
  });
});
