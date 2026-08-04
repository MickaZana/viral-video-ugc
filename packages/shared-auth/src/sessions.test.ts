import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionStore } from "./sessions.js";

describe("createSessionStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    return createSessionStore(join(dir, "sessions.json"));
  }

  it("creates a session and verifies it back with the same accountId", () => {
    const store = freshStore();
    const session = store.create("account-1");
    const verified = store.verify(session.token);
    expect(verified?.accountId).toBe("account-1");
  });

  it("issues a different token each time, even for the same account", () => {
    const store = freshStore();
    const a = store.create("account-1");
    const b = store.create("account-1");
    expect(a.token).not.toBe(b.token);
  });

  it("returns undefined for an unknown token", () => {
    const store = freshStore();
    expect(store.verify("not-a-real-token")).toBeUndefined();
  });

  it("treats an expired session as absent", () => {
    const store = freshStore();
    const session = store.create("account-1", -1000); // already expired
    expect(store.verify(session.token)).toBeUndefined();
  });

  it("revoke makes a previously-valid session unverifiable", () => {
    const store = freshStore();
    const session = store.create("account-1");
    expect(store.verify(session.token)).toBeDefined();
    store.revoke(session.token);
    expect(store.verify(session.token)).toBeUndefined();
  });

  it("revoking one session doesn't affect another session for the same account", () => {
    const store = freshStore();
    const a = store.create("account-1");
    const b = store.create("account-1");
    store.revoke(a.token);
    expect(store.verify(a.token)).toBeUndefined();
    expect(store.verify(b.token)).toBeDefined();
  });

  it("revokeAllForAccount revokes every session for one account but leaves other accounts alone", () => {
    const store = freshStore();
    const a1 = store.create("account-1");
    const a2 = store.create("account-1");
    const other = store.create("account-2");
    store.revokeAllForAccount("account-1");
    expect(store.verify(a1.token)).toBeUndefined();
    expect(store.verify(a2.token)).toBeUndefined();
    expect(store.verify(other.token)).toBeDefined();
  });
});
