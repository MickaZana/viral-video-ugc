import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountStore, EmailAlreadyRegisteredError, toPublicAccount } from "./accounts.js";

describe("createAccountStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "accounts-"));
    return createAccountStore(join(dir, "accounts.json"));
  }

  it("signs up and then authenticates with the correct password", () => {
    const store = freshStore();
    const created = store.signUp("Founder@Agency.com", "hunter2", "Acme Agency");

    expect(created.email).toBe("founder@agency.com"); // normalized
    expect(created.orgName).toBe("Acme Agency");

    const authenticated = store.authenticate("founder@agency.com", "hunter2");
    expect(authenticated?.id).toBe(created.id);
  });

  it("authentication is case-insensitive on email but not on password", () => {
    const store = freshStore();
    store.signUp("user@example.com", "correctpass");
    expect(store.authenticate("USER@example.com", "correctpass")).toBeDefined();
    expect(store.authenticate("user@example.com", "CORRECTPASS")).toBeUndefined();
  });

  it("rejects a second signup for the same (normalized) email", () => {
    const store = freshStore();
    store.signUp("dup@example.com", "pw1");
    expect(() => store.signUp("DUP@example.com", "pw2")).toThrow(EmailAlreadyRegisteredError);
  });

  it("returns undefined for a wrong password or unknown email, never throws", () => {
    const store = freshStore();
    store.signUp("real@example.com", "realpass");
    expect(store.authenticate("real@example.com", "wrongpass")).toBeUndefined();
    expect(store.authenticate("nobody@example.com", "anything")).toBeUndefined();
  });

  it("findById returns the account after signup, undefined for unknown ids", () => {
    const store = freshStore();
    const created = store.signUp("findme@example.com", "pw");
    expect(store.findById(created.id)?.email).toBe("findme@example.com");
    expect(store.findById("nonexistent-id")).toBeUndefined();
  });

  it("persists accounts across store instances pointed at the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "accounts-"));
    const dbPath = join(dir, "accounts.json");
    createAccountStore(dbPath).signUp("persisted@example.com", "pw");

    const reopened = createAccountStore(dbPath);
    expect(reopened.authenticate("persisted@example.com", "pw")).toBeDefined();
  });
});

describe("toPublicAccount", () => {
  it("strips passwordHash from the account shape", () => {
    const account = {
      id: "1",
      email: "a@b.com",
      passwordHash: "secret-hash-value",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const pub = toPublicAccount(account);
    expect(pub).not.toHaveProperty("passwordHash");
    expect(pub.email).toBe("a@b.com");
  });
});
