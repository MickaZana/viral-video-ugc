import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInviteStore } from "./invites.js";

describe("createInviteStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "invites-"));
    return createInviteStore(join(dir, "invites.json"));
  }

  it("creates an invite and verifies it back with the same orgId/email", () => {
    const store = freshStore();
    const invite = store.create("org-1", "New.Teammate@Example.com", "owner-1");
    const verified = store.verify(invite.token);
    expect(verified?.orgId).toBe("org-1");
    expect(verified?.email).toBe("new.teammate@example.com"); // normalized
  });

  it("returns undefined for an unknown token", () => {
    const store = freshStore();
    expect(store.verify("not-a-real-token")).toBeUndefined();
  });

  it("treats an expired invite as absent", () => {
    const store = freshStore();
    const invite = store.create("org-1", "x@example.com", "owner-1", -1000);
    expect(store.verify(invite.token)).toBeUndefined();
  });

  it("consume removes the invite so it can't be reused", () => {
    const store = freshStore();
    const invite = store.create("org-1", "x@example.com", "owner-1");
    expect(store.verify(invite.token)).toBeDefined();
    store.consume(invite.token);
    expect(store.verify(invite.token)).toBeUndefined();
  });

  it("issues a different token for each invite, even to the same email", () => {
    const store = freshStore();
    const a = store.create("org-1", "x@example.com", "owner-1");
    const b = store.create("org-1", "x@example.com", "owner-1");
    expect(a.token).not.toBe(b.token);
  });
});
