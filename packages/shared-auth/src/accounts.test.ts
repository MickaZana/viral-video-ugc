import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAccountStore,
  EmailAlreadyRegisteredError,
  resolveOrgId,
  roleHasPermission,
  toPublicAccount
} from "./accounts.js";

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

  it("a solo signup is its own one-person org with role owner", () => {
    const store = freshStore();
    const account = store.signUp("solo@example.com", "hunter22");
    expect(account.role).toBe("owner");
    expect(resolveOrgId(account)).toBe(account.orgId);
  });

  it("signUpAsMember links a new account to an existing org as a member, not a new org", () => {
    const store = freshStore();
    const owner = store.signUp("owner@example.com", "hunter22");
    const member = store.signUpAsMember("member@example.com", "hunter22", owner.orgId);

    expect(member.role).toBe("editor"); // invites default to editor
    expect(member.orgId).toBe(owner.orgId);
    expect(member.orgId).not.toBe(member.id); // linked to the owner's org, not a fresh solo org
  });

  it("signUpAsMember honors an explicit invited role", () => {
    const store = freshStore();
    const owner = store.signUp("owner@example.com", "hunter22");
    expect(store.signUpAsMember("reviewer@example.com", "hunter22", owner.orgId, "reviewer").role).toBe("reviewer");
    expect(store.signUpAsMember("viewer@example.com", "hunter22", owner.orgId, "viewer").role).toBe("viewer");
  });

  it("listByOrg returns every account sharing an orgId, and only those", () => {
    const store = freshStore();
    const owner = store.signUp("owner2@example.com", "hunter22");
    store.signUpAsMember("member1@example.com", "hunter22", owner.orgId);
    store.signUpAsMember("member2@example.com", "hunter22", owner.orgId);
    store.signUp("unrelated@example.com", "hunter22"); // separate org entirely

    const members = store.listByOrg(owner.orgId);
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.email).sort()).toEqual(["member1@example.com", "member2@example.com", "owner2@example.com"]);
  });

  it("updatePassword re-hashes the password so the new one authenticates and the old one doesn't", () => {
    const store = freshStore();
    const account = store.signUp("pw@example.com", "oldpass1");
    expect(store.updatePassword(account.id, "newpass1")).toBe(true);
    expect(store.authenticate("pw@example.com", "oldpass1")).toBeUndefined();
    expect(store.authenticate("pw@example.com", "newpass1")?.id).toBe(account.id);
    expect(store.updatePassword("nonexistent-id", "whatever1")).toBe(false);
  });

  it("setRole reassigns a member's role within the org but never the owner's", () => {
    const store = freshStore();
    const owner = store.signUp("owner@example.com", "hunter22");
    const member = store.signUpAsMember("member@example.com", "hunter22", owner.orgId, "viewer");

    expect(store.setRole(owner.orgId, member.id, "reviewer")?.role).toBe("reviewer");
    expect(store.findById(member.id)?.role).toBe("reviewer");
    // Can't demote the owner, can't touch members of another org, can't role unknown ids.
    expect(store.setRole(owner.orgId, owner.id, "viewer")).toBeUndefined();
    expect(store.setRole("other-org", member.id, "reviewer")).toBeUndefined();
    expect(store.setRole(owner.orgId, "nobody", "reviewer")).toBeUndefined();
    expect(store.findById(owner.id)?.role).toBe("owner");
  });

  it("removeMember deletes a member but refuses to remove the org's owner", () => {
    const store = freshStore();
    const owner = store.signUp("owner@example.com", "hunter22");
    const member = store.signUpAsMember("member@example.com", "hunter22", owner.orgId);

    expect(store.removeMember(owner.orgId, owner.id)).toBe(false); // owner is not removable
    expect(store.findById(owner.id)).toBeDefined();
    expect(store.removeMember(owner.orgId, member.id)).toBe(true);
    expect(store.findById(member.id)).toBeUndefined();
    expect(store.removeMember(owner.orgId, member.id)).toBe(false); // already gone
    expect(store.removeMember("other-org", owner.id)).toBe(false);
  });
});

describe("roleHasPermission", () => {
  it("gives the owner every permission", () => {
    for (const permission of [
      "billing.manage",
      "team.manage",
      "settings.manage",
      "clients.manage",
      "social.manage",
      "pipeline.run",
      "pipeline.run.live",
      "jobs.manage",
      "review.manage",
      "view"
    ] as const) {
      expect(roleHasPermission("owner", permission)).toBe(true);
    }
  });

  it("admin can manage team and run content but not billing", () => {
    expect(roleHasPermission("admin", "team.manage")).toBe(true);
    expect(roleHasPermission("admin", "clients.manage")).toBe(true);
    expect(roleHasPermission("admin", "pipeline.run")).toBe(true);
    expect(roleHasPermission("admin", "billing.manage")).toBe(false);
    expect(roleHasPermission("admin", "pipeline.run.live")).toBe(false);
  });

  it("editor can run the pipeline and manage content but not team or billing", () => {
    expect(roleHasPermission("editor", "pipeline.run")).toBe(true);
    expect(roleHasPermission("editor", "clients.manage")).toBe(true);
    expect(roleHasPermission("editor", "review.manage")).toBe(true);
    expect(roleHasPermission("editor", "team.manage")).toBe(false);
    expect(roleHasPermission("editor", "billing.manage")).toBe(false);
  });

  it("reviewer only reviews and views", () => {
    expect(roleHasPermission("reviewer", "review.manage")).toBe(true);
    expect(roleHasPermission("reviewer", "view")).toBe(true);
    expect(roleHasPermission("reviewer", "clients.manage")).toBe(false);
    expect(roleHasPermission("reviewer", "pipeline.run")).toBe(false);
  });

  it("viewer only views", () => {
    expect(roleHasPermission("viewer", "view")).toBe(true);
    expect(roleHasPermission("viewer", "review.manage")).toBe(false);
    expect(roleHasPermission("viewer", "settings.manage")).toBe(false);
  });

  it("legacy 'member' behaves like editor and unknown roles fail safe", () => {
    expect(roleHasPermission("member", "clients.manage")).toBe(true);
    expect(roleHasPermission("member", "pipeline.run")).toBe(true);
    expect(roleHasPermission("member", "billing.manage")).toBe(false);
    expect(roleHasPermission("totally-unknown", "view")).toBe(false);
    expect(roleHasPermission(undefined, "view")).toBe(false);
  });
});

describe("toPublicAccount", () => {
  it("strips passwordHash from the account shape", () => {
    const account = {
      id: "1",
      email: "a@b.com",
      passwordHash: "secret-hash-value",
      orgId: "org-1",
      role: "owner" as const,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const pub = toPublicAccount(account);
    expect(pub).not.toHaveProperty("passwordHash");
    expect(pub.email).toBe("a@b.com");
  });
});
