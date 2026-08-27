import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@vvugc/shared-persistence";
import { MIGRATIONS, runMigrations } from "@vvugc/review-queue";
import { MfaSecretCipher, PostgresIdentityRepository } from "./identity-postgres.js";
import { PostgresTenantProfileRepository } from "./tenant-profile-postgres.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const secret = "social-test-key-that-is-longer-than-thirty-two-characters";
const clientInput = { name: "Brand", niche: "fitness", brandVoice: "direct", locale: "en", platforms: ["youtube_shorts"], targetDurationSec: 30, videoVendor: "higgsfield", cadence: "manual", active: true } as any;
const productInput = { name: "Bottle", description: "", shortDescription: "", productCategory: "", targetCustomer: "", customerPain: "", primaryBenefits: [], features: [], claims: [], forbiddenClaims: [], differentiators: [], callToAction: "Buy", extractedImageUrls: [] } as any;
const creatorInput = { displayName: "Alex", description: "", faceEmbeddingStatus: "none", avatarMode: "none", compatibleVendors: [], lipSyncVendor: "none", speechStyle: "", tone: "", wardrobe: "", visualStyle: "", language: "en", prohibitedDepictions: [], consentConfirmed: true, consentConfirmedAt: new Date().toISOString(), consentConfirmedBy: "test", active: true } as any;

describe.skipIf(!TEST_DATABASE_URL)("Postgres tenant profile repository", () => {
  let database: IsolatedTestDatabase; let identity: PostgresIdentityRepository; let profiles: PostgresTenantProfileRepository;
  beforeAll(async () => { database = await createIsolatedTestDatabase(); await runMigrations(database.pool, MIGRATIONS); identity = new PostgresIdentityRepository(database.pool, new MfaSecretCipher(secret)); profiles = new PostgresTenantProfileRepository(database.pool, secret); });
  afterAll(async () => database?.dispose());

  it("enforces tenant scope for client, product, creator, consent/image metadata and encrypted social secrets", async () => {
    const one = await identity.signUp("profile-one@example.test", "correct horse battery staple"); const two = await identity.signUp("profile-two@example.test", "correct horse battery staple");
    const client = await profiles.clientCreate(one.orgId, clientInput); const product = await profiles.productCreate(one.orgId, { ...productInput, clientId: client.id }); const creator = await profiles.creatorCreate(one.orgId, { ...creatorInput, clientId: client.id });
    expect(await profiles.clientGet(two.orgId, client.id)).toBeUndefined(); expect(await profiles.productGet(two.orgId, product.id)).toBeUndefined(); expect(await profiles.creatorGet(two.orgId, creator.id)).toBeUndefined();
    const image = { id: "image", fileName: "reference.png", mimeType: "image/png" as const, filePath: "creator-assets/x", createdAt: new Date().toISOString() }; expect((await profiles.creatorAddImage(one.orgId, creator.id, image))?.referenceImages).toHaveLength(1);
    const social = await profiles.socialConnect(one.orgId, { clientId: client.id, platform: "youtube_shorts", accountLabel: "channel", accessToken: "raw-access", refreshToken: "raw-refresh" }); expect(await profiles.socialSecrets(two.orgId, social.id)).toBeUndefined(); expect(await profiles.socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" }); await expect(profiles.rotateSocialKey(`${secret}-wrong`, `${secret}-rotated`)).rejects.toThrow(); expect(await profiles.socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" }); await profiles.rotateSocialKey(secret, `${secret}-rotated`);
    expect((await database.pool.query<{ access_ciphertext: string }>("SELECT access_ciphertext FROM social_connections WHERE id=$1", [social.id])).rows[0]?.access_ciphertext).not.toContain("raw-access");
    expect(await new PostgresTenantProfileRepository(database.pool, `${secret}-rotated`).socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" });
  });

  it("claims invitations once under concurrency and cascades all profile state with an organization", async () => {
    const owner = await identity.signUp("invite-owner@example.test", "correct horse battery staple"); const invite = await profiles.inviteCreate(owner.orgId, "invitee@example.test", owner.id, "editor");
    const [first, second] = await Promise.allSettled([identity.acceptInvite(invite, "correct horse battery staple"), identity.acceptInvite(invite, "correct horse battery staple")]);
    expect([first, second].filter((result) => result.status === "fulfilled" && result.value).length).toBe(1); expect(await profiles.inviteVerify(invite.token)).toBeUndefined();
    const client = await profiles.clientCreate(owner.orgId, clientInput); await profiles.productCreate(owner.orgId, { ...productInput, clientId: client.id }); await profiles.creatorCreate(owner.orgId, { ...creatorInput, clientId: client.id }); await identity.deleteOrg(owner.orgId);
    expect(await profiles.clientList(owner.orgId)).toEqual([]); expect(await profiles.productList(owner.orgId)).toEqual([]); expect(await profiles.creatorList(owner.orgId)).toEqual([]);
  });
});
