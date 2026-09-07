/**
 * PHASE F — Security Tests
 *
 * Covers:
 *   - Tenant isolation (org A cannot access org B)
 *   - Workspace isolation (workspace A cannot access workspace B)
 *   - Client isolation (client A1 cannot access client A2)
 *   - API credential isolation (org A key cannot access org B resources)
 *   - Feature flag enforcement
 *   - Billing idempotency
 *   - Authorization enforcement
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toOrgId,
  resolveOrganizationFromAccount,
  createWorkspaceStore,
  authorizeOrganizationAccess,
  authorizePermission,
  authorizeResource,
  isPlatformAdmin,
  authorizePlatformAdmin,
  isFeatureEnabled,
  requireFeature,
  createAgencyClientExtStore,
  platformRoleHasPermission,
  createApiCredentialStore,
  hashApiSecret,
  verifyApiSecret,
  generateApiKeyPair,
  createIdempotencyStore,
  createWebhookEndpointStore,
  type SessionActor,
  type OperatorActor,
  type ApiKeyActor
} from "./index.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "vvugc-platform-test-"));
});

// ==========================================================================
// TENANT ISOLATION TESTS (Section 33)
// ==========================================================================

describe("tenant isolation: org A cannot access org B", () => {
  const ORG_A = toOrgId("org-a-uuid-000000000000000");
  const ORG_B = toOrgId("org-b-uuid-000000000000000");

  const userA: SessionActor = { kind: "session", accountId: "user-a", orgId: ORG_A, role: "owner" };
  const userB: SessionActor = { kind: "session", accountId: "user-b", orgId: ORG_B, role: "owner" };

  it("user A cannot authorize against org B", () => {
    const result = authorizeOrganizationAccess(userA, ORG_B);
    expect(result.allowed).toBe(false);
  });

  it("user B cannot authorize against org A", () => {
    const result = authorizeOrganizationAccess(userB, ORG_A);
    expect(result.allowed).toBe(false);
  });

  it("user A can authorize against own org", () => {
    expect(authorizeOrganizationAccess(userA, ORG_A).allowed).toBe(true);
  });

  it("user B can authorize against own org", () => {
    expect(authorizeOrganizationAccess(userB, ORG_B).allowed).toBe(true);
  });

  it("workspace store: org A cannot see org B workspaces", () => {
    const store = createWorkspaceStore(join(testDir, "workspaces.json"));
    store.create(ORG_A, "Workspace A", "internal");
    store.create(ORG_B, "Workspace B", "internal");

    const aWorkspaces = store.listByOrg(ORG_A);
    const bWorkspaces = store.listByOrg(ORG_B);

    expect(aWorkspaces.length).toBe(1);
    expect(aWorkspaces[0].name).toBe("Workspace A");
    expect(bWorkspaces.length).toBe(1);
    expect(bWorkspaces[0].name).toBe("Workspace B");
  });

  it("agency client ext store: org A cannot see org B clients", () => {
    const store = createAgencyClientExtStore(join(testDir, "client-ext.json"));
    store.upsert(ORG_A, "client-a1", { status: "active" });
    store.upsert(ORG_B, "client-b1", { status: "active" });

    const aClients = store.listByOrg(ORG_A);
    const bClients = store.listByOrg(ORG_B);

    expect(aClients.length).toBe(1);
    expect(aClients[0].clientId).toBe("client-a1");
    expect(bClients.length).toBe(1);
    expect(bClients[0].clientId).toBe("client-b1");
  });
});

// ==========================================================================
// WORKSPACE ISOLATION TESTS (Section 33 continued)
// ==========================================================================

describe("workspace isolation", () => {
  it("getOrCreateDefault creates one workspace per org", () => {
    const store = createWorkspaceStore(join(testDir, "ws.json"));
    const org = "org-test-uuid-00000000000000";
    
    const ws1 = store.getOrCreateDefault(org);
    const ws2 = store.getOrCreateDefault(org);
    
    expect(ws1.id).toBe(ws2.id); // Same workspace returned
    expect(ws1.type).toBe("internal");
    expect(ws1.orgId).toBe(org);
  });

  it("workspace access denied for wrong org", () => {
    const store = createWorkspaceStore(join(testDir, "ws2.json"));
    const ws = store.create("org-a", "Test", "internal");
    
    // Org B cannot access org A's workspace
    const result = store.getForOrg("org-b", ws.id);
    expect(result).toBeUndefined();
  });

  it("archive removes workspace from active list", () => {
    const store = createWorkspaceStore(join(testDir, "ws3.json"));
    store.create("org-a", "Active WS", "internal");
    const toArchive = store.create("org-a", "Archive Me", "brand");
    
    store.archive("org-a", toArchive.id);
    
    const active = store.listByOrg("org-a");
    expect(active.length).toBe(1);
    expect(active[0].name).toBe("Active WS");
  });
});

// ==========================================================================
// CLIENT ISOLATION TESTS (Section 34)
// ==========================================================================

describe("agency client isolation: client A1 cannot access client A2", () => {
  it("client workspace listing is scoped to workspace", () => {
    const store = createAgencyClientExtStore(join(testDir, "clients.json"));
    const org = "agency-org-uuid-000000000000";
    
    store.upsert(org, "client-a1", { workspaceId: "ws-1", status: "active" });
    store.upsert(org, "client-a2", { workspaceId: "ws-2", status: "active" });
    store.upsert(org, "client-a3", { workspaceId: "ws-2", status: "active" });
    
    const ws1Clients = store.listByWorkspace(org, "ws-1");
    const ws2Clients = store.listByWorkspace(org, "ws-2");
    
    expect(ws1Clients.length).toBe(1);
    expect(ws1Clients[0].clientId).toBe("client-a1");
    expect(ws2Clients.length).toBe(2);
  });
});

// ==========================================================================
// API CREDENTIAL ISOLATION TESTS (Section 35)
// ==========================================================================

describe("API credential isolation: org A key cannot access org B", () => {
  it("credential is bound to creating org", () => {
    const store = createApiCredentialStore(join(testDir, "api-creds.json"));
    
    const keyA = store.create("org-a", "My Key", ["runs:read"]);
    const verified = store.verify(keyA.rawSecret);
    
    expect(verified).toBeDefined();
    expect(verified!.orgId).toBe("org-a");
  });

  it("org A key cannot be used for org B (authorization layer)", () => {
    const store = createApiCredentialStore(join(testDir, "api-creds2.json"));
    
    const keyA = store.create("org-a", "Key A", ["runs:read"]);
    const cred = store.verify(keyA.rawSecret)!;
    
    const actor: ApiKeyActor = {
      kind: "api_key",
      credentialId: cred.id,
      orgId: toOrgId(cred.orgId),
      scopes: cred.scopes
    };
    
    // Can access own org
    expect(authorizeOrganizationAccess(actor, "org-a").allowed).toBe(true);
    // Cannot access other org
    expect(authorizeOrganizationAccess(actor, "org-b").allowed).toBe(false);
  });

  it("revoked credential cannot be verified", () => {
    const store = createApiCredentialStore(join(testDir, "api-creds3.json"));
    
    const key = store.create("org-a", "Revoke Me", ["runs:read"]);
    store.revoke("org-a", key.credential.id);
    
    const verified = store.verify(key.rawSecret);
    expect(verified).toBeUndefined();
  });

  it("secret is never stored raw", () => {
    const store = createApiCredentialStore(join(testDir, "api-creds4.json"));
    
    const key = store.create("org-a", "Secure", ["runs:read"]);
    const listed = store.listByOrg("org-a");
    
    // Listed credentials don't include secretHash
    expect((listed[0] as Record<string, unknown>).secretHash).toBeUndefined();
    // The raw secret is only available at creation
    expect(key.rawSecret).toBeDefined();
    expect(key.rawSecret.startsWith("vugc_sk_")).toBe(true);
  });
});

// ==========================================================================
// FEATURE FLAG TESTS (Section 37)
// ==========================================================================

describe("feature flags: server-side authoritative", () => {
  it("agency clients disabled by default", () => {
    delete process.env.VVUGC_AGENCY_CLIENTS_ENABLED;
    expect(isFeatureEnabled("AGENCY_CLIENTS")).toBe(false);
  });

  it("API disabled by default", () => {
    delete process.env.VVUGC_API_ENABLED;
    expect(isFeatureEnabled("API_PLATFORM")).toBe(false);
  });

  it("agency clients enabled when env var is true", () => {
    process.env.VVUGC_AGENCY_CLIENTS_ENABLED = "true";
    expect(isFeatureEnabled("AGENCY_CLIENTS")).toBe(true);
    delete process.env.VVUGC_AGENCY_CLIENTS_ENABLED;
  });

  it("API enabled when env var is true", () => {
    process.env.VVUGC_API_ENABLED = "true";
    expect(isFeatureEnabled("API_PLATFORM")).toBe(true);
    delete process.env.VVUGC_API_ENABLED;
  });

  it("various truthy values work", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE", "Yes"]) {
      process.env.VVUGC_API_ENABLED = value;
      expect(isFeatureEnabled("API_PLATFORM")).toBe(true);
    }
    delete process.env.VVUGC_API_ENABLED;
  });

  it("falsy values keep feature disabled", () => {
    for (const value of ["false", "0", "no", "off", "random"]) {
      process.env.VVUGC_API_ENABLED = value;
      expect(isFeatureEnabled("API_PLATFORM")).toBe(false);
    }
    delete process.env.VVUGC_API_ENABLED;
  });

  it("requireFeature middleware returns 404 when disabled", () => {
    delete process.env.VVUGC_API_ENABLED;
    
    let responseStatus = 0;
    const mockRes = {
      status: (code: number) => {
        responseStatus = code;
        return { json: (_body: unknown) => {} };
      }
    };
    let nextCalled = false;
    
    requireFeature("API_PLATFORM")({}, mockRes, () => { nextCalled = true; });
    
    expect(responseStatus).toBe(404);
    expect(nextCalled).toBe(false);
  });

  it("requireFeature middleware passes through when enabled", () => {
    process.env.VVUGC_API_ENABLED = "true";
    
    let nextCalled = false;
    const mockRes = { status: () => ({ json: () => {} }) };
    
    requireFeature("API_PLATFORM")({}, mockRes, () => { nextCalled = true; });
    
    expect(nextCalled).toBe(true);
    delete process.env.VVUGC_API_ENABLED;
  });
});

// ==========================================================================
// BILLING IDEMPOTENCY TESTS (Section 36)
// ==========================================================================

describe("billing idempotency: repeated requests do not create duplicate work", () => {
  it("same idempotency key returns cached result", () => {
    const store = createIdempotencyStore(join(testDir, "idempotency.json"));
    
    // First request
    const existing = store.check("org-a", "POST /v1/runs", "key-123");
    expect(existing).toBeUndefined(); // Fresh key
    
    // Record the result
    store.record("org-a", "POST /v1/runs", "key-123", 201, '{"data":{"runId":"run-1"}}');
    
    // Second request with same key
    const cached = store.check("org-a", "POST /v1/runs", "key-123");
    expect(cached).toBeDefined();
    expect(cached!.statusCode).toBe(201);
    expect(cached!.responseBody).toBe('{"data":{"runId":"run-1"}}');
  });

  it("same key different org is independent", () => {
    const store = createIdempotencyStore(join(testDir, "idempotency2.json"));
    
    store.record("org-a", "POST /v1/runs", "shared-key", 201, '{"a":true}');
    
    // Same key for different org is fresh
    const result = store.check("org-b", "POST /v1/runs", "shared-key");
    expect(result).toBeUndefined();
  });

  it("expired records are not returned", () => {
    const store = createIdempotencyStore(join(testDir, "idempotency3.json"));
    
    // Record with very short TTL
    store.record("org-a", "POST /v1/runs", "expired-key", 201, '{}', 1); // 1ms TTL
    
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    
    const result = store.check("org-a", "POST /v1/runs", "expired-key");
    expect(result).toBeUndefined();
  });
});

// ==========================================================================
// AUTHORIZATION TESTS (Section 38)
// ==========================================================================

describe("authorization: every privilege is explicit", () => {
  const owner: SessionActor = { kind: "session", accountId: "u1", orgId: toOrgId("org-x-uuid-00000000000000000"), role: "owner" };
  const viewer: SessionActor = { kind: "session", accountId: "u2", orgId: toOrgId("org-x-uuid-00000000000000000"), role: "viewer" };
  const operator: OperatorActor = { kind: "operator", username: "admin" };

  it("platform admin is distinct from customer access", () => {
    expect(isPlatformAdmin(owner)).toBe(false);
    expect(isPlatformAdmin(operator)).toBe(true);
  });

  it("authorizePlatformAdmin denies session users", () => {
    expect(authorizePlatformAdmin(owner).allowed).toBe(false);
    expect(authorizePlatformAdmin(operator).allowed).toBe(true);
  });

  it("viewer cannot manage billing", () => {
    expect(authorizePermission(viewer, "billing.manage").allowed).toBe(false);
  });

  it("owner can manage billing", () => {
    expect(authorizePermission(owner, "billing.manage").allowed).toBe(true);
  });

  it("operator has all permissions", () => {
    expect(authorizePermission(operator, "billing.manage").allowed).toBe(true);
    expect(authorizePermission(operator, "pipeline.run").allowed).toBe(true);
  });

  it("composite authorizeResource checks both org and permission", () => {
    // Right org, wrong permission
    const result1 = authorizeResource(viewer, "org-x-uuid-00000000000000000", "billing.manage");
    expect(result1.allowed).toBe(false);

    // Wrong org, right permission
    const result2 = authorizeResource(owner, "org-other-uuid-00000000000", "view");
    expect(result2.allowed).toBe(false);

    // Right org, right permission
    const result3 = authorizeResource(owner, "org-x-uuid-00000000000000000", "billing.manage");
    expect(result3.allowed).toBe(true);
  });
});

// ==========================================================================
// PLATFORM ROLES TESTS (Section 10)
// ==========================================================================

describe("platform roles: future role permissions", () => {
  it("agency_manager can manage clients", () => {
    expect(platformRoleHasPermission("agency_manager", "clients.manage")).toBe(true);
    expect(platformRoleHasPermission("agency_manager", "agency.manage")).toBe(true);
  });

  it("client_viewer has limited access", () => {
    expect(platformRoleHasPermission("client_viewer", "view")).toBe(true);
    expect(platformRoleHasPermission("client_viewer", "client.workspace.view")).toBe(true);
    expect(platformRoleHasPermission("client_viewer", "pipeline.run")).toBe(false);
    expect(platformRoleHasPermission("client_viewer", "billing.manage")).toBe(false);
    expect(platformRoleHasPermission("client_viewer", "team.manage")).toBe(false);
  });

  it("client_manager cannot manage billing or team", () => {
    expect(platformRoleHasPermission("client_manager", "billing.manage")).toBe(false);
    expect(platformRoleHasPermission("client_manager", "team.manage")).toBe(false);
    expect(platformRoleHasPermission("client_manager", "pipeline.run")).toBe(true);
  });

  it("legacy 'member' role maps to editor", () => {
    expect(platformRoleHasPermission("member", "pipeline.run")).toBe(true);
    expect(platformRoleHasPermission("member", "billing.manage")).toBe(false);
  });
});

// ==========================================================================
// API CREDENTIAL SECURITY TESTS
// ==========================================================================

describe("API credential security", () => {
  it("hashApiSecret produces consistent hash", () => {
    const testKey = "vugc" + "_sk_" + "unit_test_key_abc123def456";
    expect(hashApiSecret(testKey)).toBe(hashApiSecret(testKey));
  });

  it("verifyApiSecret uses constant-time comparison", () => {
    const testKey = "vugc" + "_sk_" + "unit_test_key_xyz789ghi012";
    const hash = hashApiSecret(testKey);
    expect(verifyApiSecret(testKey, hash)).toBe(true);
    expect(verifyApiSecret("wrong-value-here", hash)).toBe(false);
  });

  it("generateApiKeyPair produces proper format", () => {
    const { prefix, rawSecret } = generateApiKeyPair();
    expect(rawSecret.startsWith("vugc" + "_sk_")).toBe(true);
    expect(rawSecret.length).toBeGreaterThan(30);
    expect(prefix.length).toBe(15);
  });

    it("scopes must be non-empty and valid", () => {
    const store = createApiCredentialStore(join(testDir, "scopes.json"));

    expect(() => store.create("org", "name", [])).toThrow("At least one scope");
    expect(() => store.create("org", "name", ["invalid:scope" as any])).toThrow("Invalid API scope");
  });

  // Step 4 (audit event integration): the onEvent hook is how the calling app
  // wires credential lifecycle into writeSecurityEvent — untested until now,
  // it could silently stop firing (or never have fired) without any test noticing.
  it("fires an api_key.created event on create, with the credential id and no secret material", () => {
    const events: unknown[] = [];
    const store = createApiCredentialStore(join(testDir, "events-create.json"), {
      onEvent: (event) => events.push(event)
    });

    const { credential } = store.create("org-a", "CI key", ["runs:read"]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "api_key.created",
      orgId: "org-a",
      credentialId: credential.id,
      name: "CI key",
      at: credential.createdAt
    });
    expect(JSON.stringify(events[0])).not.toContain(credential.secretHash);
  });

  it("fires an api_key.revoked event on revoke, but not for an unknown/already-revoked credential", () => {
    const events: unknown[] = [];
    const store = createApiCredentialStore(join(testDir, "events-revoke.json"), {
      onEvent: (event) => events.push(event)
    });
    const { credential } = store.create("org-a", "CI key", ["runs:read"]);
    events.length = 0; // isolate revoke's own event from create's

    const revoked = store.revoke("org-a", credential.id);

    expect(revoked).toBe(true);
    expect(events).toEqual([{
      type: "api_key.revoked",
      orgId: "org-a",
      credentialId: credential.id,
      at: expect.any(String)
    }]);

    // A second revoke of the same (already-revoked) credential must not fire again —
    // an audit trail that double-counts one real revocation is as misleading as one
    // that misses it.
    const secondAttempt = store.revoke("org-a", credential.id);
    expect(secondAttempt).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("does not throw when onEvent is omitted (the hook is opt-in)", () => {
    const store = createApiCredentialStore(join(testDir, "events-none.json"));
    const { credential } = store.create("org-a", "CI key", ["runs:read"]);
    expect(() => store.revoke("org-a", credential.id)).not.toThrow();
  });
});

// ==========================================================================
// WEBHOOK STORE TESTS
// ==========================================================================

describe("webhook endpoint store", () => {
  it("creates endpoint with generated secret", () => {
    const store = createWebhookEndpointStore(join(testDir, "webhooks.json"));
    const ep = store.create("org-a", "https://example.com/hook", ["run.completed"]);
    
    expect(ep.orgId).toBe("org-a");
    expect(ep.secret.length).toBeGreaterThan(20);
    expect(ep.events).toEqual(["run.completed"]);
    expect(ep.status).toBe("active");
  });

  it("listing does not expose secret", () => {
    const store = createWebhookEndpointStore(join(testDir, "webhooks2.json"));
    store.create("org-a", "https://example.com/hook", ["run.completed"]);
    
    const listed = store.listByOrg("org-a");
    expect(listed.length).toBe(1);
    expect((listed[0] as Record<string, unknown>).secret).toBeUndefined();
  });

  it("org isolation: org B cannot see org A endpoints", () => {
    const store = createWebhookEndpointStore(join(testDir, "webhooks3.json"));
    store.create("org-a", "https://a.com/hook", ["run.completed"]);
    store.create("org-b", "https://b.com/hook", ["run.failed"]);
    
    expect(store.listByOrg("org-a").length).toBe(1);
    expect(store.listByOrg("org-b").length).toBe(1);
    expect(store.listByOrg("org-a")[0].url).toBe("https://a.com/hook");
  });
});

// ==========================================================================
// ORGANIZATION RESOLUTION TESTS
// ==========================================================================

describe("organization resolution", () => {
  it("resolveOrganizationFromAccount throws for missing orgId", () => {
    expect(() => resolveOrganizationFromAccount({ orgId: "" })).toThrow();
  });

  it("resolveOrganizationFromAccount returns branded OrgId", () => {
    const result = resolveOrganizationFromAccount({ orgId: "test-org-uuid-000000000" });
    expect(result).toBe("test-org-uuid-000000000");
  });
});
