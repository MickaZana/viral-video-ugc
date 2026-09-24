// @vvugc/shared-platform — Platform evolution infrastructure
// Phase B: Foundation

export {
  toOrgId,
  resolveOrganizationFromAccount,
  isValidOrgIdFormat,
  DEFAULT_ORGANIZATION_TYPE,
  type OrgId,
  type OrganizationType,
  type OrganizationMeta
} from "./organization.js";

export {
  createWorkspaceStore,
  DEFAULT_WORKSPACE_NAME,
  type Workspace,
  type WorkspaceType,
  type WorkspaceStatus,
  type WorkspaceStore
} from "./workspace.js";

export {
  authorizeOrganizationAccess,
  authorizeWorkspaceAccess,
  authorizeClientAccess,
  authorizePermission,
  authorizeResource,
  isPlatformAdmin,
  authorizePlatformAdmin,
  type Actor,
  type SessionActor,
  type OperatorActor,
  type ApiKeyActor,
  type AuthorizeResult
} from "./authorization.js";

export {
  FEATURE_FLAGS,
  isFeatureEnabled,
  getAllFlagStates,
  requireFeature,
  assertFeatureEnabled,
  type FeatureFlagConfig
} from "./feature-flags.js";

// Phase C: Dormant Agency/Client
export {
  createAgencyClientExtStore,
  type AgencyClientExt,
  type AgencyClientExtStore
} from "./agency-client.js";

// Phase C: Future roles
export {
  PLATFORM_ROLES,
  platformRoleHasPermission,
  type PlatformRole,
  type PlatformPermission
} from "./roles.js";

// Phase D: API Foundation
export {
  createApiCredentialStore,
  hashApiSecret,
  verifyApiSecret,
  generateApiKeyPair,
  API_SCOPES,
  type ApiCredential,
  type ApiCredentialStore,
  type ApiScope,
  type ApiCredentialEvent,
  type ApiCredentialStoreOptions
} from "./api-credentials.js";

export {
  createIdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyStore
} from "./idempotency.js";

export {
  createWebhookEndpointStore,
  type WebhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpointStore
} from "./webhooks.js";

export {
  API_RESPONSE_ENVELOPE,
  apiSuccess,
  apiError,
  generateRequestId
} from "./api-envelope.js";

export {
  API_RATE_LIMITS,
  resolveRateLimitKey,
  type ApiRateLimitConfig
} from "./rate-limit.js";

export {
  assertBillingGateConsulted,
  BILLING_ENFORCED_PATHS,
  type BillingGateResult,
  type RunBillingGate
} from "./billing-gate.js";
