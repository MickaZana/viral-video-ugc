/**
 * Durable tenant configuration/profile repository.  This is intentionally a
 * separate boundary from identity: identities are security principals, while
 * these records are tenant-owned business state.  Every lookup includes org_id
 * so a caller can never retrieve a known UUID from another tenant.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import { withTransaction } from "@vvugc/shared-persistence";
import { createAgencyClientStore, createCreatorProfileStore, createInviteStore, createProductProfileStore, createSettingsStore, createSocialConnectionStore, type AgencyClient, type AgencyClientInput, type AccountSettings, type AccountSettingsInput, type Invite, type SocialConnection, type SocialConnectionSecrets } from "@vvugc/shared-auth";
import type { CreatorProfile, CreatorReferenceImage, ProductImage, ProductProfile } from "@vvugc/shared-schema";
import { CreatorProfileSchema, ProductProfileSchema } from "@vvugc/shared-schema";
import { createCurriculumStore, expandCurriculumPlan, CurriculumAssetSchema, CurriculumCourseSchema, CurriculumLessonSchema, CurriculumModuleSchema, CurriculumProjectSchema, CurriculumVersionSchema, LessonCompletionSchema, type CurriculumAsset, type CurriculumAssetFilter, type CurriculumAssetInput, type CurriculumCourse, type CurriculumCourseInput, type CurriculumLesson, type CurriculumLessonInput, type CurriculumModule, type CurriculumModuleInput, type CurriculumPlan, type CurriculumProject, type CurriculumProjectInput, type CurriculumVersion, type CurriculumVersionCreateInput, type LessonCompletion, type LessonCompletionInput } from "@vvugc/curriculum-engine";

type Platform = SocialConnection["platform"];
export type ProductProfileInput = Omit<ProductProfile, "id" | "orgId" | "createdAt" | "updatedAt" | "productImages" | "extractionStatus"> & { productImages?: ProductImage[]; extractionStatus?: ProductProfile["extractionStatus"] };
export type CreatorProfileInput = Omit<CreatorProfile, "id" | "orgId" | "createdAt" | "updatedAt" | "referenceImages"> & { referenceImages?: CreatorReferenceImage[] };

const DEFAULT_SETTINGS: AccountSettingsInput = { appMode: "standard", niche: "", brandVoice: "neutral, energetic, concise", platforms: ["youtube_shorts"], targetDurationSec: 35, videoVendor: "higgsfield", cadence: "manual" };
const WEEK = 7 * 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const nextWeeklyRun = (from = new Date()) => new Date(from.getTime() + WEEK).toISOString();

/** Field-granular shallow merge (mirrors the curriculum file store): copies only
 *  the keys actually present and not `undefined` in `patch`. */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function statusFor(expiresAt?: string): SocialConnection["status"] { if (!expiresAt) return "connected"; const left = new Date(expiresAt).getTime() - Date.now(); return left <= 0 ? "expired" : left <= WEEK ? "expiring" : "connected"; }
function tokenKey(secret: string): Buffer { if (secret.length < 32) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY must be at least 32 characters"); return createHash("sha256").update(secret).digest(); }
function encrypt(value: string, key: Buffer): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const cipherText = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), cipherText]).toString("base64url"); }
function decrypt(value: string, key: Buffer): string { const bytes = Buffer.from(value, "base64url"); if (bytes.length < 29) throw new Error("invalid encrypted social token"); const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); }

export interface TenantProfileRepository {
  settingsGet(orgId: string): Promise<AccountSettings>; settingsUpsert(orgId: string, input: AccountSettingsInput): Promise<AccountSettings>;
  clientList(orgId: string): Promise<AgencyClient[]>; clientGet(orgId: string, id: string): Promise<AgencyClient | undefined>; clientCreate(orgId: string, input: AgencyClientInput): Promise<AgencyClient>; clientUpdate(orgId: string, id: string, input: AgencyClientInput): Promise<AgencyClient | undefined>; clientArchive(orgId: string, id: string): Promise<boolean>; clientClaimDue(now: Date, orgId?: string): Promise<AgencyClient[]>;
  productList(orgId: string, clientId?: string): Promise<ProductProfile[]>; productGet(orgId: string, id: string): Promise<ProductProfile | undefined>; productCreate(orgId: string, input: ProductProfileInput): Promise<ProductProfile>; productUpdate(orgId: string, id: string, input: ProductProfileInput): Promise<ProductProfile | undefined>; productArchive(orgId: string, id: string): Promise<boolean>; productAddImage(orgId: string, id: string, image: ProductImage): Promise<ProductProfile | undefined>; productRemoveImage(orgId: string, id: string, imageId: string): Promise<ProductImage | undefined>;
  creatorList(orgId: string, clientId?: string): Promise<CreatorProfile[]>; creatorGet(orgId: string, id: string): Promise<CreatorProfile | undefined>; creatorCreate(orgId: string, input: CreatorProfileInput): Promise<CreatorProfile>; creatorUpdate(orgId: string, id: string, input: CreatorProfileInput): Promise<CreatorProfile | undefined>; creatorArchive(orgId: string, id: string): Promise<boolean>; creatorAddImage(orgId: string, id: string, image: CreatorReferenceImage): Promise<CreatorProfile | undefined>; creatorRemoveImage(orgId: string, id: string, imageId: string): Promise<CreatorReferenceImage | undefined>;
  inviteCreate(orgId: string, email: string, invitedByAccountId: string, role: Invite["role"], ttlMs?: number): Promise<Invite>; inviteVerify(token: string): Promise<Invite | undefined>; inviteConsume(token: string): Promise<Invite | undefined>; inviteDeleteByEmail(email: string): Promise<void>;
  socialList(orgId: string, clientId?: string): Promise<SocialConnection[]>; socialConnect(orgId: string, input: { clientId: string; platform: Platform; accountLabel: string; providerAccountId?: string; accessToken: string; refreshToken?: string; expiresAt?: string }): Promise<SocialConnection>; socialSecrets(orgId: string, connectionId: string): Promise<SocialConnectionSecrets | undefined>; socialDisconnect(orgId: string, connectionId: string): Promise<boolean>; rotateSocialKey(oldSecret: string, newSecret: string): Promise<number>;
  deleteOrg(orgId: string): Promise<void>;
  curriculumCourseCreate(orgId: string, input: CurriculumCourseInput): Promise<CurriculumCourse>;
  curriculumCourseList(orgId: string): Promise<CurriculumCourse[]>;
  curriculumCourseGet(orgId: string, courseId: string): Promise<CurriculumCourse | undefined>;
  curriculumCourseUpdate(orgId: string, courseId: string, patch: Partial<CurriculumCourseInput>): Promise<CurriculumCourse | undefined>;
  curriculumCourseDelete(orgId: string, courseId: string): Promise<boolean>;
  curriculumModuleList(orgId: string, courseId: string): Promise<CurriculumModule[]>;
  curriculumModuleGet(orgId: string, courseId: string, moduleId: string): Promise<CurriculumModule | undefined>;
  curriculumModuleUpdate(orgId: string, courseId: string, moduleId: string, patch: Partial<CurriculumModuleInput>): Promise<CurriculumModule | undefined>;
  curriculumLessonList(orgId: string, courseId: string, moduleId?: string): Promise<CurriculumLesson[]>;
  curriculumLessonGet(orgId: string, courseId: string, lessonId: string): Promise<CurriculumLesson | undefined>;
  curriculumLessonUpdate(orgId: string, courseId: string, lessonId: string, patch: Partial<CurriculumLessonInput>): Promise<CurriculumLesson | undefined>;
  curriculumProjectList(orgId: string, courseId: string): Promise<CurriculumProject[]>;
  curriculumProjectGet(orgId: string, courseId: string, projectId: string): Promise<CurriculumProject | undefined>;
  curriculumProjectGetByModule(orgId: string, courseId: string, moduleId: string): Promise<CurriculumProject | undefined>;
  curriculumProjectUpdate(orgId: string, courseId: string, projectId: string, patch: Partial<CurriculumProjectInput>): Promise<CurriculumProject | undefined>;
  curriculumAssetCreate(orgId: string, input: CurriculumAssetInput): Promise<CurriculumAsset>;
  curriculumAssetList(orgId: string, courseId: string, filter?: CurriculumAssetFilter): Promise<CurriculumAsset[]>;
  curriculumAssetGet(orgId: string, assetId: string): Promise<CurriculumAsset | undefined>;
  curriculumAssetUpdate(orgId: string, assetId: string, patch: Partial<CurriculumAssetInput>): Promise<CurriculumAsset | undefined>;
  curriculumVersionCreate(orgId: string, courseId: string, input: CurriculumVersionCreateInput): Promise<CurriculumVersion>;
  curriculumVersionList(orgId: string, courseId: string): Promise<CurriculumVersion[]>;
  curriculumNextVersionNumber(orgId: string, courseId: string): Promise<number>;
  curriculumLessonCompletionUpsert(orgId: string, input: LessonCompletionInput): Promise<LessonCompletion>;
  curriculumLessonCompletionList(orgId: string, courseId: string, accountId?: string): Promise<LessonCompletion[]>;
  curriculumSaveApprovedPlan(orgId: string, courseId: string, plan: CurriculumPlan): Promise<{ modules: CurriculumModule[]; lessons: CurriculumLesson[]; projects: CurriculumProject[] }>;
}

/** Development/test adapter for the exact same awaitable tenant-profile
 * boundary as PostgreSQL.  Production always injects the PostgreSQL adapter. */
export class LocalTenantProfileRepository implements TenantProfileRepository {
  private readonly settings; private readonly clients; private readonly products; private readonly creators; private readonly invites; private readonly social; private readonly curriculum;
  constructor(runsDir: string, socialEncryptionSecret: string) {
    this.settings = createSettingsStore(join(runsDir, "account-settings.json")); this.clients = createAgencyClientStore(join(runsDir, "agency-clients.json")); this.products = createProductProfileStore(join(runsDir, "product-profiles.json")); this.creators = createCreatorProfileStore(join(runsDir, "creator-profiles.json")); this.invites = createInviteStore(join(runsDir, "invites.json")); this.social = createSocialConnectionStore(join(runsDir, "social-connections.json"), socialEncryptionSecret); this.curriculum = createCurriculumStore(runsDir);
  }
  async settingsGet(orgId: string) { return this.settings.get(orgId); } async settingsUpsert(orgId: string, input: AccountSettingsInput) { return this.settings.upsert(orgId, input); }
  async clientList(orgId: string) { return this.clients.listByOrg(orgId); } async clientGet(orgId: string, id: string) { return this.clients.getForOrg(orgId, id); } async clientCreate(orgId: string, input: AgencyClientInput) { return this.clients.create(orgId, input); } async clientUpdate(orgId: string, id: string, input: AgencyClientInput) { return this.clients.update(orgId, id, input); } async clientArchive(orgId: string, id: string) { return this.clients.archive(orgId, id); } async clientClaimDue(now: Date, orgId?: string) { return this.clients.claimDue(now, orgId); }
  async productList(orgId: string, clientId?: string) { return this.products.listByOrg(orgId, clientId); } async productGet(orgId: string, id: string) { return this.products.getForOrg(orgId, id); } async productCreate(orgId: string, input: ProductProfileInput) { return this.products.create(orgId, input); } async productUpdate(orgId: string, id: string, input: ProductProfileInput) { return this.products.update(orgId, id, input); } async productArchive(orgId: string, id: string) { return this.products.archive(orgId, id); } async productAddImage(orgId: string, id: string, image: ProductImage) { return this.products.addImage(orgId, id, image); } async productRemoveImage(orgId: string, id: string, imageId: string) { return this.products.removeImage(orgId, id, imageId); }
  async creatorList(orgId: string, clientId?: string) { return this.creators.listByOrg(orgId, clientId); } async creatorGet(orgId: string, id: string) { return this.creators.getForOrg(orgId, id); } async creatorCreate(orgId: string, input: CreatorProfileInput) { return this.creators.create(orgId, input); } async creatorUpdate(orgId: string, id: string, input: CreatorProfileInput) { return this.creators.update(orgId, id, input); } async creatorArchive(orgId: string, id: string) { return this.creators.archive(orgId, id); } async creatorAddImage(orgId: string, id: string, image: CreatorReferenceImage) { return this.creators.addImage(orgId, id, image); } async creatorRemoveImage(orgId: string, id: string, imageId: string) { return this.creators.removeImage(orgId, id, imageId); }
  async inviteCreate(orgId: string, email: string, invitedByAccountId: string, role: Invite["role"], ttlMs?: number) { return this.invites.create(orgId, email, invitedByAccountId, role, ttlMs); } async inviteVerify(token: string) { return this.invites.verify(token); } async inviteConsume(token: string) { const value = this.invites.verify(token); if (value) this.invites.consume(token); return value; } async inviteDeleteByEmail(email: string) { this.invites.deleteByEmail(email); }
  async socialList(orgId: string, clientId?: string) { return this.social.list(orgId, clientId); } async socialConnect(orgId: string, input: Parameters<typeof this.social.connect>[1]) { return this.social.connect(orgId, input); } async socialSecrets(orgId: string, connectionId: string) { return this.social.getSecrets(orgId, connectionId); } async socialDisconnect(orgId: string, connectionId: string) { return this.social.disconnect(orgId, connectionId); } async rotateSocialKey(_oldSecret: string, _newSecret: string): Promise<number> { throw new Error("Social token rotation must use the explicit local rotation command"); }
  async deleteOrg(orgId: string) { this.settings.delete(orgId); this.clients.deleteOrg(orgId); this.products.deleteOrg(orgId); this.creators.deleteOrg(orgId); this.invites.deleteOrg(orgId); this.social.deleteOrg(orgId); }
  async curriculumCourseCreate(orgId: string, input: CurriculumCourseInput) { return this.curriculum.courseCreate(orgId, input); } async curriculumCourseList(orgId: string) { return this.curriculum.courseList(orgId); } async curriculumCourseGet(orgId: string, courseId: string) { return this.curriculum.courseGet(orgId, courseId); } async curriculumCourseUpdate(orgId: string, courseId: string, patch: Partial<CurriculumCourseInput>) { return this.curriculum.courseUpdate(orgId, courseId, patch); } async curriculumCourseDelete(orgId: string, courseId: string) { return this.curriculum.courseDelete(orgId, courseId); }
  async curriculumModuleList(orgId: string, courseId: string) { return this.curriculum.moduleList(orgId, courseId); } async curriculumModuleGet(orgId: string, courseId: string, moduleId: string) { return this.curriculum.moduleGet(orgId, courseId, moduleId); } async curriculumModuleUpdate(orgId: string, courseId: string, moduleId: string, patch: Partial<CurriculumModuleInput>) { return this.curriculum.moduleUpdate(orgId, courseId, moduleId, patch); }
  async curriculumLessonList(orgId: string, courseId: string, moduleId?: string) { return this.curriculum.lessonList(orgId, courseId, moduleId); } async curriculumLessonGet(orgId: string, courseId: string, lessonId: string) { return this.curriculum.lessonGet(orgId, courseId, lessonId); } async curriculumLessonUpdate(orgId: string, courseId: string, lessonId: string, patch: Partial<CurriculumLessonInput>) { return this.curriculum.lessonUpdate(orgId, courseId, lessonId, patch); }
  async curriculumProjectList(orgId: string, courseId: string) { return this.curriculum.projectList(orgId, courseId); } async curriculumProjectGet(orgId: string, courseId: string, projectId: string) { return this.curriculum.projectGet(orgId, courseId, projectId); } async curriculumProjectGetByModule(orgId: string, courseId: string, moduleId: string) { return this.curriculum.projectGetByModule(orgId, courseId, moduleId); } async curriculumProjectUpdate(orgId: string, courseId: string, projectId: string, patch: Partial<CurriculumProjectInput>) { return this.curriculum.projectUpdate(orgId, courseId, projectId, patch); }
  async curriculumAssetCreate(orgId: string, input: CurriculumAssetInput) { return this.curriculum.assetCreate(orgId, input); } async curriculumAssetList(orgId: string, courseId: string, filter?: CurriculumAssetFilter) { return this.curriculum.assetList(orgId, courseId, filter); } async curriculumAssetGet(orgId: string, assetId: string) { return this.curriculum.assetGet(orgId, assetId); } async curriculumAssetUpdate(orgId: string, assetId: string, patch: Partial<CurriculumAssetInput>) { return this.curriculum.assetUpdate(orgId, assetId, patch); }
  async curriculumVersionCreate(orgId: string, courseId: string, input: CurriculumVersionCreateInput) { return this.curriculum.versionCreate(orgId, courseId, input); } async curriculumVersionList(orgId: string, courseId: string) { return this.curriculum.versionList(orgId, courseId); } async curriculumNextVersionNumber(orgId: string, courseId: string) { return this.curriculum.nextVersionNumber(orgId, courseId); }
  async curriculumLessonCompletionUpsert(orgId: string, input: LessonCompletionInput) { return this.curriculum.lessonCompletionUpsert(orgId, input); } async curriculumLessonCompletionList(orgId: string, courseId: string, accountId?: string) { return this.curriculum.lessonCompletionList(orgId, courseId, accountId); }
  async curriculumSaveApprovedPlan(orgId: string, courseId: string, plan: CurriculumPlan) { return this.curriculum.saveApprovedPlan(orgId, courseId, plan); }
}

export class PostgresTenantProfileRepository implements TenantProfileRepository {
  private readonly key: Buffer;
  constructor(private readonly pool: Pool, encryptionSecret: string) { this.key = tokenKey(encryptionSecret); }
  private async payload<T>(sql: string, values: unknown[] = []): Promise<T | undefined> { const r = await this.pool.query<{ payload: T }>(sql, values); return r.rows[0]?.payload; }
  private async profile<T>(sql: string, values: unknown[] = []): Promise<T | undefined> { return this.payload<T>(sql, values); }
  async settingsGet(orgId: string) { return (await this.payload<AccountSettings>("SELECT payload FROM tenant_settings WHERE org_id=$1", [orgId])) ?? { accountId: orgId, appMode: "standard", ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() }; }
  async settingsUpsert(orgId: string, input: AccountSettingsInput) { const value: AccountSettings = { accountId: orgId, appMode: "standard", ...input, updatedAt: now() }; await this.pool.query("INSERT INTO tenant_settings(org_id,payload,updated_at) VALUES($1,$2::jsonb,now()) ON CONFLICT(org_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()", [orgId, JSON.stringify(value)]); return value; }
  async clientList(orgId: string) { const r = await this.pool.query<{ payload: AgencyClient }>("SELECT payload FROM agency_clients WHERE org_id=$1 ORDER BY payload->>'name'", [orgId]); return r.rows.map((x) => x.payload); }
  async clientGet(orgId: string, id: string) { return this.profile<AgencyClient>("SELECT payload FROM agency_clients WHERE org_id=$1 AND id=$2", [orgId, id]); }
  async clientCreate(orgId: string, input: AgencyClientInput) { const time = now(); const value: AgencyClient = { id: randomUUID(), orgId, ...input, nextRunAt: input.cadence === "weekly" ? nextWeeklyRun(new Date(time)) : undefined, createdAt: time, updatedAt: time }; await this.pool.query("INSERT INTO agency_clients(id,org_id,payload) VALUES($1,$2,$3::jsonb)", [value.id, orgId, JSON.stringify(value)]); return value; }
  async clientUpdate(orgId: string, id: string, input: AgencyClientInput) { const previous = await this.clientGet(orgId, id); if (!previous) return undefined; const value: AgencyClient = { ...previous, ...input, id, orgId, nextRunAt: input.cadence === "weekly" ? (previous.cadence !== input.cadence || !previous.nextRunAt ? nextWeeklyRun() : previous.nextRunAt) : undefined, updatedAt: now() }; await this.pool.query("UPDATE agency_clients SET payload=$3::jsonb WHERE org_id=$1 AND id=$2", [orgId, id, JSON.stringify(value)]); return value; }
  async clientArchive(orgId: string, id: string) { const previous = await this.clientGet(orgId, id); if (!previous) return false; await this.pool.query("UPDATE agency_clients SET payload=$3::jsonb WHERE org_id=$1 AND id=$2", [orgId, id, JSON.stringify({ ...previous, active: false, updatedAt: now() })]); return true; }
  async clientClaimDue(at: Date, orgId?: string) { return withTransaction(this.pool, async (db) => { const due = await db.query<{ payload: AgencyClient }>(`SELECT payload FROM agency_clients WHERE (payload->>'active')::boolean = true AND payload->>'cadence'='weekly' AND (payload->>'nextRunAt')::timestamptz <= $1 ${orgId ? "AND org_id=$2" : ""} FOR UPDATE SKIP LOCKED`, orgId ? [at, orgId] : [at]); const claimed = due.rows.map((row) => row.payload); for (const client of claimed) { const value = { ...client, lastScheduledRunAt: at.toISOString(), nextRunAt: nextWeeklyRun(at), updatedAt: at.toISOString() }; await db.query("UPDATE agency_clients SET payload=$3::jsonb WHERE org_id=$1 AND id=$2", [value.orgId, value.id, JSON.stringify(value)]); } return claimed; }); }
  async productList(orgId: string, clientId?: string) { const r = await this.pool.query<{ payload: ProductProfile }>(clientId ? "SELECT payload FROM product_profiles WHERE org_id=$1 AND client_id=$2 ORDER BY payload->>'name'" : "SELECT payload FROM product_profiles WHERE org_id=$1 ORDER BY payload->>'name'", clientId ? [orgId, clientId] : [orgId]); return r.rows.map((x) => ProductProfileSchema.parse(x.payload)); }
  async productGet(orgId: string, id: string) { const value = await this.profile<ProductProfile>("SELECT payload FROM product_profiles WHERE org_id=$1 AND id=$2", [orgId, id]); return value ? ProductProfileSchema.parse(value) : undefined; }
  async productCreate(orgId: string, input: ProductProfileInput) { const time = now(); const value = ProductProfileSchema.parse({ ...input, id: randomUUID(), orgId, productImages: input.productImages ?? [], extractionStatus: input.extractionStatus ?? "manual", createdAt: time, updatedAt: time }); await this.pool.query("INSERT INTO product_profiles(id,org_id,client_id,payload) VALUES($1,$2,$3,$4::jsonb)", [value.id, orgId, value.clientId ?? null, JSON.stringify(value)]); return value; }
  async productUpdate(orgId: string, id: string, input: ProductProfileInput) { const previous = await this.productGet(orgId, id); if (!previous) return undefined; const value = ProductProfileSchema.parse({ ...previous, ...input, id, orgId, productImages: input.productImages ?? previous.productImages, updatedAt: now() }); await this.pool.query("UPDATE product_profiles SET client_id=$3,payload=$4::jsonb WHERE org_id=$1 AND id=$2", [orgId, id, value.clientId ?? null, JSON.stringify(value)]); return value; }
  async productArchive(orgId: string, id: string) { return (await this.pool.query("DELETE FROM product_profiles WHERE org_id=$1 AND id=$2", [orgId, id])).rowCount === 1; }
  async productAddImage(orgId: string, id: string, image: ProductImage) { const value = await this.productGet(orgId, id); if (!value || value.productImages.length >= 12) return undefined; return this.productUpdate(orgId, id, { ...value, productImages: [...value.productImages, image] }); }
  async productRemoveImage(orgId: string, id: string, imageId: string) { const value = await this.productGet(orgId, id); const image = value?.productImages.find((x) => x.id === imageId); if (!value || !image) return undefined; await this.productUpdate(orgId, id, { ...value, productImages: value.productImages.filter((x) => x.id !== imageId) }); return image; }
  async creatorList(orgId: string, clientId?: string) { const r = await this.pool.query<{ payload: CreatorProfile }>(clientId ? "SELECT payload FROM creator_profiles WHERE org_id=$1 AND client_id=$2 ORDER BY payload->>'displayName'" : "SELECT payload FROM creator_profiles WHERE org_id=$1 ORDER BY payload->>'displayName'", clientId ? [orgId, clientId] : [orgId]); return r.rows.map((x) => CreatorProfileSchema.parse(x.payload)); }
  async creatorGet(orgId: string, id: string) { const value = await this.profile<CreatorProfile>("SELECT payload FROM creator_profiles WHERE org_id=$1 AND id=$2", [orgId, id]); return value ? CreatorProfileSchema.parse(value) : undefined; }
  async creatorCreate(orgId: string, input: CreatorProfileInput) { const time = now(); const value = CreatorProfileSchema.parse({ ...input, id: randomUUID(), orgId, referenceImages: input.referenceImages ?? [], createdAt: time, updatedAt: time }); await this.pool.query("INSERT INTO creator_profiles(id,org_id,client_id,payload) VALUES($1,$2,$3,$4::jsonb)", [value.id, orgId, value.clientId ?? null, JSON.stringify(value)]); return value; }
  async creatorUpdate(orgId: string, id: string, input: CreatorProfileInput) { const previous = await this.creatorGet(orgId, id); if (!previous) return undefined; const value = CreatorProfileSchema.parse({ ...previous, ...input, id, orgId, referenceImages: input.referenceImages ?? previous.referenceImages, updatedAt: now() }); await this.pool.query("UPDATE creator_profiles SET client_id=$3,payload=$4::jsonb WHERE org_id=$1 AND id=$2", [orgId, id, value.clientId ?? null, JSON.stringify(value)]); return value; }
  async creatorArchive(orgId: string, id: string) { const previous = await this.creatorGet(orgId, id); if (!previous) return false; await this.creatorUpdate(orgId, id, { ...previous, active: false }); return true; }
  async creatorAddImage(orgId: string, id: string, image: CreatorReferenceImage) { const value = await this.creatorGet(orgId, id); if (!value || value.referenceImages.length >= 8) return undefined; return this.creatorUpdate(orgId, id, { ...value, referenceImages: [...value.referenceImages, image] }); }
  async creatorRemoveImage(orgId: string, id: string, imageId: string) { const value = await this.creatorGet(orgId, id); const image = value?.referenceImages.find((x) => x.id === imageId); if (!value || !image) return undefined; await this.creatorUpdate(orgId, id, { ...value, referenceImages: value.referenceImages.filter((x) => x.id !== imageId) }); return image; }
  async inviteCreate(orgId: string, email: string, invitedByAccountId: string, role: Invite["role"], ttlMs = WEEK) { const time = Date.now(); const value: Invite = { token: randomBytes(24).toString("base64url"), orgId, email: email.trim().toLowerCase(), role, invitedByAccountId, createdAt: new Date(time).toISOString(), expiresAt: new Date(time + ttlMs).toISOString() }; await this.pool.query("INSERT INTO organization_invites(token,org_id,email,role,invited_by_account_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [value.token, value.orgId, value.email, value.role, value.invitedByAccountId, value.createdAt, value.expiresAt]); return value; }
  async inviteVerify(token: string) { const r = await this.pool.query<Invite>("SELECT token,org_id AS \"orgId\",email,role,invited_by_account_id AS \"invitedByAccountId\",created_at AS \"createdAt\",expires_at AS \"expiresAt\" FROM organization_invites WHERE token=$1 AND expires_at > now()", [token]); return r.rows[0]; }
  async inviteConsume(token: string) { const r = await this.pool.query<Invite>("DELETE FROM organization_invites WHERE token=$1 AND expires_at > now() RETURNING token,org_id AS \"orgId\",email,role,invited_by_account_id AS \"invitedByAccountId\",created_at AS \"createdAt\",expires_at AS \"expiresAt\"", [token]); return r.rows[0]; }
  async inviteDeleteByEmail(email: string) { await this.pool.query("DELETE FROM organization_invites WHERE email=$1", [email.trim().toLowerCase()]); }
  async socialList(orgId: string, clientId?: string) { const r = await this.pool.query<{ id: string; org_id: string; client_id: string; platform: Platform; account_label: string; provider_account_id: string | null; expires_at: Date | null; refresh_ciphertext: string | null; created_at: Date; updated_at: Date }>(clientId ? "SELECT * FROM social_connections WHERE org_id=$1 AND client_id=$2 ORDER BY created_at" : "SELECT * FROM social_connections WHERE org_id=$1 ORDER BY created_at", clientId ? [orgId, clientId] : [orgId]); return r.rows.map((x) => ({ id: x.id, orgId: x.org_id, clientId: x.client_id, platform: x.platform, accountLabel: x.account_label, providerAccountId: x.provider_account_id ?? undefined, expiresAt: x.expires_at?.toISOString(), status: statusFor(x.expires_at?.toISOString()), hasRefreshToken: Boolean(x.refresh_ciphertext), createdAt: x.created_at.toISOString(), updatedAt: x.updated_at.toISOString() })); }
  async socialConnect(orgId: string, input: { clientId: string; platform: Platform; accountLabel: string; providerAccountId?: string; accessToken: string; refreshToken?: string; expiresAt?: string }) { const prior = (await this.pool.query<{ id: string; created_at: Date }>("SELECT id,created_at FROM social_connections WHERE org_id=$1 AND client_id=$2 AND platform=$3", [orgId, input.clientId, input.platform])).rows[0]; const id = prior?.id ?? randomUUID(); const time = now(); await this.pool.query("INSERT INTO social_connections(id,org_id,client_id,platform,account_label,provider_account_id,access_ciphertext,refresh_ciphertext,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT(org_id,client_id,platform) DO UPDATE SET account_label=EXCLUDED.account_label,provider_account_id=EXCLUDED.provider_account_id,access_ciphertext=EXCLUDED.access_ciphertext,refresh_ciphertext=EXCLUDED.refresh_ciphertext,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at", [id, orgId, input.clientId, input.platform, input.accountLabel, input.providerAccountId ?? null, encrypt(input.accessToken, this.key), input.refreshToken ? encrypt(input.refreshToken, this.key) : null, input.expiresAt ?? null, time]); return (await this.socialList(orgId, input.clientId)).find((x) => x.platform === input.platform)!; }
  async socialSecrets(orgId: string, connectionId: string) { const r = await this.pool.query<{ access_ciphertext: string; refresh_ciphertext: string | null }>("SELECT access_ciphertext,refresh_ciphertext FROM social_connections WHERE org_id=$1 AND id=$2", [orgId, connectionId]); const value = r.rows[0]; return value ? { accessToken: decrypt(value.access_ciphertext, this.key), refreshToken: value.refresh_ciphertext ? decrypt(value.refresh_ciphertext, this.key) : undefined } : undefined; }
  async socialDisconnect(orgId: string, connectionId: string) { return (await this.pool.query("DELETE FROM social_connections WHERE org_id=$1 AND id=$2", [orgId, connectionId])).rowCount === 1; }
  async rotateSocialKey(oldSecret: string, newSecret: string) { const oldKey = tokenKey(oldSecret); const newKey = tokenKey(newSecret); return withTransaction(this.pool, async (db) => { const r = await db.query<{ id: string; access_ciphertext: string; refresh_ciphertext: string | null }>("SELECT id,access_ciphertext,refresh_ciphertext FROM social_connections FOR UPDATE"); for (const row of r.rows) await db.query("UPDATE social_connections SET access_ciphertext=$2,refresh_ciphertext=$3,updated_at=now() WHERE id=$1", [row.id, encrypt(decrypt(row.access_ciphertext, oldKey), newKey), row.refresh_ciphertext ? encrypt(decrypt(row.refresh_ciphertext, oldKey), newKey) : null]); return r.rowCount ?? 0; }); }
  async deleteOrg(_orgId: string) { /* PostgreSQL foreign-key cascades run with identity.deleteOrg. */ }
  // ─── Curriculum Mode v2 ────────────────────────────────────────────────
  // Same jsonb-payload + org_id-scoping shape as the tenant-profile tables
  // above; ordering keys live in the payload. Every row is re-`Schema.parse`d
  // before persisting (as the curriculum file store does). Multi-row writes
  // (versionCreate's course side effect, saveApprovedPlan) run in one
  // `withTransaction` so a mid-flight throw rolls the whole thing back.
  async curriculumCourseCreate(orgId: string, input: CurriculumCourseInput): Promise<CurriculumCourse> {
    const ts = now();
    const course = CurriculumCourseSchema.parse({ ...input, id: randomUUID(), orgId, status: input.status ?? "draft", activeVersion: null, createdAt: ts, updatedAt: ts });
    await this.pool.query("INSERT INTO curriculum_courses(id,org_id,payload) VALUES($1,$2,$3::jsonb)", [course.id, orgId, JSON.stringify(course)]);
    return course;
  }
  async curriculumCourseList(orgId: string): Promise<CurriculumCourse[]> {
    const r = await this.pool.query<{ payload: CurriculumCourse }>("SELECT payload FROM curriculum_courses WHERE org_id=$1 ORDER BY updated_at DESC, id DESC", [orgId]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumCourseGet(orgId: string, courseId: string): Promise<CurriculumCourse | undefined> {
    return this.payload<CurriculumCourse>("SELECT payload FROM curriculum_courses WHERE org_id=$1 AND id=$2", [orgId, courseId]);
  }
  async curriculumCourseUpdate(orgId: string, courseId: string, patch: Partial<CurriculumCourseInput>): Promise<CurriculumCourse | undefined> {
    const previous = await this.curriculumCourseGet(orgId, courseId);
    if (!previous) return undefined;
    const value = CurriculumCourseSchema.parse({ ...mergeDefined(previous, patch), id: courseId, orgId, updatedAt: now() });
    await this.pool.query("UPDATE curriculum_courses SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, courseId, JSON.stringify(value)]);
    return value;
  }
  async curriculumCourseDelete(orgId: string, courseId: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM curriculum_courses WHERE org_id=$1 AND id=$2", [orgId, courseId]);
    return (r.rowCount ?? 0) > 0; // FK ON DELETE CASCADE clears modules/lessons/projects/assets/versions/completions
  }
  async curriculumModuleList(orgId: string, courseId: string): Promise<CurriculumModule[]> {
    const r = await this.pool.query<{ payload: CurriculumModule }>("SELECT payload FROM curriculum_modules WHERE org_id=$1 AND course_id=$2 ORDER BY (payload->>'order')::int, id", [orgId, courseId]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumModuleGet(orgId: string, courseId: string, moduleId: string): Promise<CurriculumModule | undefined> {
    return this.payload<CurriculumModule>("SELECT payload FROM curriculum_modules WHERE org_id=$1 AND course_id=$2 AND id=$3", [orgId, courseId, moduleId]);
  }
  async curriculumModuleUpdate(orgId: string, courseId: string, moduleId: string, patch: Partial<CurriculumModuleInput>): Promise<CurriculumModule | undefined> {
    const previous = await this.curriculumModuleGet(orgId, courseId, moduleId);
    if (!previous) return undefined;
    const value = CurriculumModuleSchema.parse({ ...mergeDefined(previous, patch), id: moduleId, orgId, courseId, updatedAt: now() });
    await this.pool.query("UPDATE curriculum_modules SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, moduleId, JSON.stringify(value)]);
    return value;
  }
  async curriculumLessonList(orgId: string, courseId: string, moduleId?: string): Promise<CurriculumLesson[]> {
    const r = await this.pool.query<{ payload: CurriculumLesson }>("SELECT payload FROM curriculum_lessons WHERE org_id=$1 AND course_id=$2 AND ($3::text IS NULL OR payload->>'moduleId'=$3) ORDER BY (payload->>'globalOrder')::int, id", [orgId, courseId, moduleId ?? null]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumLessonGet(orgId: string, courseId: string, lessonId: string): Promise<CurriculumLesson | undefined> {
    return this.payload<CurriculumLesson>("SELECT payload FROM curriculum_lessons WHERE org_id=$1 AND course_id=$2 AND id=$3", [orgId, courseId, lessonId]);
  }
  async curriculumLessonUpdate(orgId: string, courseId: string, lessonId: string, patch: Partial<CurriculumLessonInput>): Promise<CurriculumLesson | undefined> {
    const previous = await this.curriculumLessonGet(orgId, courseId, lessonId);
    if (!previous) return undefined;
    const value = CurriculumLessonSchema.parse({ ...mergeDefined(previous, patch), id: lessonId, orgId, courseId, updatedAt: now() });
    await this.pool.query("UPDATE curriculum_lessons SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, lessonId, JSON.stringify(value)]);
    return value;
  }
  async curriculumProjectList(orgId: string, courseId: string): Promise<CurriculumProject[]> {
    const r = await this.pool.query<{ payload: CurriculumProject }>("SELECT payload FROM curriculum_projects WHERE org_id=$1 AND course_id=$2 ORDER BY (SELECT (m.payload->>'order')::int FROM curriculum_modules m WHERE m.id = curriculum_projects.payload->>'moduleId'), id", [orgId, courseId]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumProjectGet(orgId: string, courseId: string, projectId: string): Promise<CurriculumProject | undefined> {
    return this.payload<CurriculumProject>("SELECT payload FROM curriculum_projects WHERE org_id=$1 AND course_id=$2 AND id=$3", [orgId, courseId, projectId]);
  }
  async curriculumProjectGetByModule(orgId: string, courseId: string, moduleId: string): Promise<CurriculumProject | undefined> {
    return this.payload<CurriculumProject>("SELECT payload FROM curriculum_projects WHERE org_id=$1 AND course_id=$2 AND payload->>'moduleId'=$3", [orgId, courseId, moduleId]);
  }
  async curriculumProjectUpdate(orgId: string, courseId: string, projectId: string, patch: Partial<CurriculumProjectInput>): Promise<CurriculumProject | undefined> {
    const previous = await this.curriculumProjectGet(orgId, courseId, projectId);
    if (!previous) return undefined;
    const value = CurriculumProjectSchema.parse({ ...mergeDefined(previous, patch), id: projectId, orgId, courseId, updatedAt: now() });
    await this.pool.query("UPDATE curriculum_projects SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, projectId, JSON.stringify(value)]);
    return value;
  }
  async curriculumAssetCreate(orgId: string, input: CurriculumAssetInput): Promise<CurriculumAsset> {
    const ts = now();
    const asset = CurriculumAssetSchema.parse({ ...input, id: randomUUID(), orgId, status: input.status ?? "planned", createdAt: ts, updatedAt: ts });
    await this.pool.query("INSERT INTO curriculum_assets(id,org_id,course_id,payload) VALUES($1,$2,$3,$4::jsonb)", [asset.id, orgId, asset.courseId, JSON.stringify(asset)]);
    return asset;
  }
  async curriculumAssetList(orgId: string, courseId: string, filter?: CurriculumAssetFilter): Promise<CurriculumAsset[]> {
    const r = await this.pool.query<{ payload: CurriculumAsset }>(
      "SELECT payload FROM curriculum_assets WHERE org_id=$1 AND course_id=$2 AND ($3::text IS NULL OR payload->>'moduleId'=$3) AND ($4::text IS NULL OR payload->>'lessonId'=$4) AND ($5::text IS NULL OR payload->>'projectId'=$5) AND ($6::text IS NULL OR payload->>'assetType'=$6) AND ($7::text IS NULL OR payload->>'status'=$7) ORDER BY created_at, id",
      [orgId, courseId, filter?.moduleId ?? null, filter?.lessonId ?? null, filter?.projectId ?? null, filter?.assetType ?? null, filter?.status ?? null]
    );
    return r.rows.map((x) => x.payload);
  }
  async curriculumAssetGet(orgId: string, assetId: string): Promise<CurriculumAsset | undefined> {
    return this.payload<CurriculumAsset>("SELECT payload FROM curriculum_assets WHERE org_id=$1 AND id=$2", [orgId, assetId]);
  }
  async curriculumAssetUpdate(orgId: string, assetId: string, patch: Partial<CurriculumAssetInput>): Promise<CurriculumAsset | undefined> {
    const previous = await this.curriculumAssetGet(orgId, assetId);
    if (!previous) return undefined;
    const value = CurriculumAssetSchema.parse({ ...mergeDefined(previous, patch), id: assetId, orgId, updatedAt: now() });
    await this.pool.query("UPDATE curriculum_assets SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, assetId, JSON.stringify(value)]);
    return value;
  }
  async curriculumVersionCreate(orgId: string, courseId: string, input: CurriculumVersionCreateInput): Promise<CurriculumVersion> {
    return withTransaction(this.pool, async (db) => {
      const version = CurriculumVersionSchema.parse({ id: randomUUID(), orgId, courseId, version: input.version, createdAt: now(), createdByAccountId: input.createdByAccountId, reason: input.reason, snapshot: input.snapshot });
      await db.query("INSERT INTO curriculum_versions(id,org_id,course_id,payload) VALUES($1,$2,$3,$4::jsonb)", [version.id, orgId, courseId, JSON.stringify(version)]);
      // Locking a version is the one real path that sets course.activeVersion —
      // saveApprovedPlan then refuses in-place regeneration for this course.
      const current = (await db.query<{ payload: CurriculumCourse }>("SELECT payload FROM curriculum_courses WHERE org_id=$1 AND id=$2 FOR UPDATE", [orgId, courseId])).rows[0]?.payload;
      if (current && (current.activeVersion === null || version.version > current.activeVersion)) {
        const updated = CurriculumCourseSchema.parse({ ...current, activeVersion: version.version, updatedAt: now() });
        await db.query("UPDATE curriculum_courses SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, courseId, JSON.stringify(updated)]);
      }
      return version;
    });
  }
  async curriculumVersionList(orgId: string, courseId: string): Promise<CurriculumVersion[]> {
    const r = await this.pool.query<{ payload: CurriculumVersion }>("SELECT payload FROM curriculum_versions WHERE org_id=$1 AND course_id=$2 ORDER BY (payload->>'version')::int ASC", [orgId, courseId]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumNextVersionNumber(orgId: string, courseId: string): Promise<number> {
    const r = await this.pool.query<{ next: string | number }>("SELECT COALESCE(MAX((payload->>'version')::int), 0) + 1 AS next FROM curriculum_versions WHERE org_id=$1 AND course_id=$2", [orgId, courseId]);
    return Number(r.rows[0]?.next ?? 1);
  }
  async curriculumLessonCompletionUpsert(orgId: string, input: LessonCompletionInput): Promise<LessonCompletion> {
    const row = LessonCompletionSchema.parse({ ...input, orgId, completedAt: now() });
    await this.pool.query("INSERT INTO curriculum_lesson_completions(org_id,course_id,lesson_id,account_id,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT (org_id,course_id,lesson_id,account_id) DO UPDATE SET payload=EXCLUDED.payload", [orgId, row.courseId, row.lessonId, row.accountId, JSON.stringify(row)]);
    return row;
  }
  async curriculumLessonCompletionList(orgId: string, courseId: string, accountId?: string): Promise<LessonCompletion[]> {
    const r = await this.pool.query<{ payload: LessonCompletion }>("SELECT payload FROM curriculum_lesson_completions WHERE org_id=$1 AND course_id=$2 AND ($3::text IS NULL OR account_id=$3) ORDER BY (payload->>'completedAt'), account_id", [orgId, courseId, accountId ?? null]);
    return r.rows.map((x) => x.payload);
  }
  async curriculumSaveApprovedPlan(orgId: string, courseId: string, plan: CurriculumPlan): Promise<{ modules: CurriculumModule[]; lessons: CurriculumLesson[]; projects: CurriculumProject[] }> {
    return withTransaction(this.pool, async (db) => {
      const course = (await db.query<{ payload: CurriculumCourse }>("SELECT payload FROM curriculum_courses WHERE org_id=$1 AND id=$2 FOR UPDATE", [orgId, courseId])).rows[0]?.payload;
      if (!course) {
        throw new Error(`saveApprovedPlan: course ${courseId} not found for org ${orgId}`);
      }
      if (course.activeVersion !== null) {
        throw new Error(
          `saveApprovedPlan: course ${courseId} has an active version (${course.activeVersion}); ` +
            `production has started — cut a new version instead of regenerating the plan in place.`
        );
      }
      // Validate + expand the whole plan (throws → the transaction rolls back →
      // nothing persisted) — shared byte-for-byte with the file store.
      const { course: updatedCourse, modules, lessons, projects } = expandCurriculumPlan(orgId, courseId, course, plan);
      // REPLACE this course's module/lesson/project rows wholesale (idempotent regeneration).
      await db.query("DELETE FROM curriculum_modules WHERE org_id=$1 AND course_id=$2", [orgId, courseId]);
      await db.query("DELETE FROM curriculum_lessons WHERE org_id=$1 AND course_id=$2", [orgId, courseId]);
      await db.query("DELETE FROM curriculum_projects WHERE org_id=$1 AND course_id=$2", [orgId, courseId]);
      for (const m of modules) await db.query("INSERT INTO curriculum_modules(id,org_id,course_id,payload) VALUES($1,$2,$3,$4::jsonb)", [m.id, orgId, courseId, JSON.stringify(m)]);
      for (const l of lessons) await db.query("INSERT INTO curriculum_lessons(id,org_id,course_id,payload) VALUES($1,$2,$3,$4::jsonb)", [l.id, orgId, courseId, JSON.stringify(l)]);
      for (const pr of projects) await db.query("INSERT INTO curriculum_projects(id,org_id,course_id,payload) VALUES($1,$2,$3,$4::jsonb)", [pr.id, orgId, courseId, JSON.stringify(pr)]);
      await db.query("UPDATE curriculum_courses SET payload=$3::jsonb,updated_at=now() WHERE org_id=$1 AND id=$2", [orgId, courseId, JSON.stringify(updatedCourse)]);
      return { modules, lessons, projects };
    });
  }
}
