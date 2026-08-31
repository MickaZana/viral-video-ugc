/**
 * Thin HTTP client for the control panel. All endpoints live under `/api/*`
 * which the Vite dev server proxies to the review-dashboard backend. Every call
 * here returns real backend data — there is no mock/fallback in this codebase.
 *
 * Auth: requests carry the browser's session cookie (Same-Origin, so no CORS).
 * State-changing requests attach the CSRF token the server issued at login/signup
 * (stored in sessionStorage by lib/auth.ts).
 */

import type {
  AgencyClient,
  BillingResponse,
  ClientsResponse,
  CreateClientInput,
  CreatorsResponse,
  DiscoverBrief,
  DiscoverRequest,
  DiscoverResponse,
  ModelsResponse,
  RemixPreviewResponse,
  RemixRequest,
  ReviewItem,
  RunResponse,
  RunSummary,
  Stats,
  TrackedCreator,
  TrendsResponse,
  ProductProfile,
  ProductsResponse,
  CreatorProfile,
  CharacterAttributes,
  CharacterPortrait
  , UGCTemplate
} from './types'
import { loadCsrf } from './auth'
import type { BatchPlan, BatchPlanDraft, BatchProgress, BatchRequest, Preset } from '@vvugc/shared-schema'

const API_BASE = '/api'

// When true, read-only data routes (/stats, /creators, /runs, /queue) are
// rewritten to the backend's public /preview/* endpoints. The landing page's
// "live preview" frame turns this on for anonymous visitors so they can click
// around without a session; the authenticated app leaves it off so it reads the
// real, full data over the session-authenticated routes. State-changing calls
// (approve/reject/regenerate/publish) are never rewritten — a guest clicking a
// mutate button in the preview simply gets an auth error, which is correct.
let previewMode = false
export function setPreviewMode(on: boolean): void {
  previewMode = on
}

const PREVIEW_ROUTES: Record<string, string> = {
  '/stats': '/preview/stats',
  '/creators': '/preview/creators',
  '/runs': '/preview/runs',
  '/queue': '/preview/queue'
}

function routeFor(path: string): string {
  if (previewMode && PREVIEW_ROUTES[path]) return PREVIEW_ROUTES[path]
  return path
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {}
  const csrf = loadCsrf()
  const method = (init?.method ?? 'GET').toUpperCase()

  // Mark every SPA request as an AJAX call. The backend's Basic Auth middleware
  // only sends the WWW-Authenticate: Basic challenge header to non-AJAX requests,
  // so a 401 here is just a JSON error the UI handles — it never triggers the
  // browser's native HTTP login popup.
  headers['X-Requested-With'] = 'XMLHttpRequest'

  // CSRF protection is only required for state-changing requests. It is derived
  // server-side from the session cookie, so it's meaningless without a session.
  if (csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = csrf
  }
  if (init?.body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${routeFor(path)}`, {
    headers,
    credentials: 'same-origin',
    ...init
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const message =
      (body as { error?: string }).error || `Request failed (${res.status})`
    throw new Error(message)
  }
  if (res.status === 204) return undefined as unknown as T
  return (await res.json()) as T
}

export interface PublicAccount {
  id: string
  email: string
  orgId: string
  role: string
  orgName?: string
}

/** Assignable team roles — owner is excluded (an org has exactly one, set at signup). */
export type AccountRole = 'admin' | 'editor' | 'reviewer' | 'viewer'

export interface SocialConnection {
  id: string
  clientId: string
  platform: string
  accountLabel: string
  status: 'connected' | 'expiring' | 'expired'
  expiresAt?: string
}

export interface MembersResponse {
  members: PublicAccount[]
  role: string
  /** Server-computed from the actual permission map — routes still enforce this
   *  independently, so this only controls whether the UI shows manage controls. */
  canManageTeam: boolean
}

export interface MeResponse {
  account: PublicAccount
  csrfToken?: string
  mfaEnabled: boolean
}

export interface LoginResponse {
  account: PublicAccount
  csrfToken?: string
  mfaRequired?: boolean
  mfaToken?: string
  expiresAt?: string
}

export interface StartRequest {
  niche?: string
  platform?: string
  brandVoice?: string
  sourceUrl?: string
  clientId?: string
  dryRun?: boolean
  live?: boolean
  brief?: DiscoverBrief
  productProfileId?: string
  templateId?: string
}
export interface StartResponse {
  job: { id: string; status: string }
  runId: string
  progressUrl: string
  brief?: DiscoverBrief
}

/** Optional filters for GET /queue. Server-side; keeps the QA board focused on
 *  exactly what the operator wants to see (e.g. hide dry-run/mock items). */
export interface QueueFilter {
  status?: ReviewItem['status']
  platform?: ReviewItem['platform']
  /** When false, excludes dry-run (mock) items from the queue. */
  dryRun?: boolean
}

export const api = {
  // ---- Account / auth ----
  me(): Promise<MeResponse> {
    return request<MeResponse>('/accounts/me')
  },
  signup(body: { email: string; password: string; orgName?: string }): Promise<{ account: PublicAccount }> {
    return request<{ account: PublicAccount }>('/accounts/signup', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  login(body: { email: string; password: string }): Promise<LoginResponse> {
    return request<LoginResponse>('/accounts/login', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  mfaChallenge(body: { mfaToken: string; code: string }): Promise<LoginResponse> {
    return request<LoginResponse>('/accounts/mfa/challenge', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  logout(): Promise<void> {
    return request<void>('/accounts/logout', { method: 'POST' })
  },
  changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
    return request<void>('/accounts/password', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  forgotPassword(body: { email: string }): Promise<{ resetToken: string | null; expiresAt?: string }> {
    return request('/accounts/password/forgot', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  resetPassword(body: { token: string; newPassword: string }): Promise<void> {
    return request<void>('/accounts/password/reset', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  acceptInvite(body: { token: string; password: string }): Promise<{ account: PublicAccount }> {
    return request<{ account: PublicAccount }>('/accounts/invite/accept', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },

  // ---- Team ----
  members(): Promise<MembersResponse> {
    return request<MembersResponse>('/accounts/members')
  },
  inviteMember(body: { email: string; role: AccountRole }): Promise<{ inviteToken: string; expiresAt: string }> {
    return request<{ inviteToken: string; expiresAt: string }>('/accounts/invite', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  updateMemberRole(id: string, role: AccountRole): Promise<{ member: PublicAccount }> {
    return request<{ member: PublicAccount }>(`/accounts/members/${encodeURIComponent(id)}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role })
    })
  },
  removeMember(id: string): Promise<void> {
    return request<void>(`/accounts/members/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  // ---- Publishing connections ----
  socialConnections(clientId: string): Promise<{ connections: SocialConnection[] }> {
    return request<{ connections: SocialConnection[] }>(`/accounts/social-connections?clientId=${encodeURIComponent(clientId)}`)
  },
  /** Starts the Google OAuth consent flow for a client's YouTube channel. Returns
   *  the hosted authorization URL to redirect the browser to; the callback lands
   *  back on this client's brand page with ?oauth=google-connected. */
  startGoogleOAuth(clientId: string): Promise<{ authorizationUrl: string }> {
    return request<{ authorizationUrl: string }>(`/accounts/clients/${encodeURIComponent(clientId)}/oauth/google/start`, {
      method: 'POST'
    })
  },
  disconnectSocial(id: string): Promise<void> {
    return request<void>(`/accounts/social-connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  // ---- Billing ----
  billing(): Promise<BillingResponse> {
    return request<BillingResponse>('/accounts/billing')
  },
  /** Starts a real Stripe Checkout session for the given tier. Returns the hosted
   *  checkout URL to redirect the browser to; on failure (e.g. Stripe not
   *  configured yet, unknown tier, missing billing.manage permission) throws the
   *  backend's error message so the UI can show it honestly instead of a dead link. */
  billingCheckout(tierId: string): Promise<{ url: string }> {
    return request<{ url: string }>('/accounts/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ tierId })
    })
  },

  // ---- Models ----
  models(): Promise<ModelsResponse> {
    return request<ModelsResponse>('/models')
  },

  // ---- Remix from URL ----
  remixPreview(body: RemixRequest): Promise<RemixPreviewResponse> {
    return request<RemixPreviewResponse>('/accounts/remix', {
      method: 'POST',
      body: JSON.stringify({ ...body, previewOnly: true })
    })
  },
  remix(body: RemixRequest): Promise<RunSummary & { overage?: { priceUsdPerRun: number } | null }> {
    return request('/accounts/remix', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },

  // ---- Agency clients & pipeline runs ----
  clients(): Promise<ClientsResponse> {
    return request<ClientsResponse>('/accounts/clients')
  },
  createClient(body: CreateClientInput): Promise<{ client: AgencyClient }> {
    return request<{ client: AgencyClient }>('/accounts/clients', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  updateClient(id: string, body: CreateClientInput): Promise<{ client: AgencyClient }> {
    return request<{ client: AgencyClient }>(`/accounts/clients/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    })
  },
  /** Runs the real pipeline for the org's client. Dry-run (safe, no vendor spend)
   *  is the backend default; pass dryRun:false to attempt a live run. */
  templates(): Promise<{ templates: UGCTemplate[] }> { return request('/templates') },
  /** Curated starting configurations — see PresetSchema's doc comment. */
  presets(): Promise<{ presets: Preset[] }> { return request('/presets') },
  run(body: { clientId: string; dryRun: boolean; productProfileId?: string; creatorProfileId?: string; templateId?: string; visualDirection?: Record<string, string> }): Promise<RunResponse> {
    return request<RunResponse>('/accounts/run', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  /** First-run happy path: enqueue a dry-run (or live) pipeline for the org and
   *  return its runId + progressUrl so the SPA can land on the live run page. */
  start(body: StartRequest): Promise<StartResponse> {
    return request<StartResponse>('/accounts/start', {
      method: 'POST',
      body: JSON.stringify({
        niche: body.niche,
        platform: body.platform,
        brandVoice: body.brandVoice,
        sourceUrl: body.sourceUrl,
        clientId: body.clientId,
        dryRun: body.dryRun,
        live: body.live,
        brief: body.brief,
        productProfileId: body.productProfileId
        , templateId: body.templateId
      })
    })
  },

  // ---- Data ----
  products(clientId?: string): Promise<ProductsResponse> {
    const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''
    return request<ProductsResponse>(`/accounts/products${qs}`)
  },
  creatorProfiles(clientId?: string): Promise<{ creators: CreatorProfile[] }> { const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''; return request<{ creators: CreatorProfile[] }>(`/accounts/creators${qs}`) },
  creatorPreflight(id: string, videoVendor: string, clientId?: string): Promise<{ creatorId: string; vendor: string; warnings: string[]; blocking: boolean }> { const qs = new URLSearchParams({ videoVendor }); if (clientId) qs.set('clientId', clientId); return request<{ creatorId: string; vendor: string; warnings: string[]; blocking: boolean }>(`/accounts/creators/${id}/preflight?${qs.toString()}`) },
  createCreator(body: Partial<CreatorProfile> & { displayName: string }): Promise<{ creator: CreatorProfile }> { return request<{ creator: CreatorProfile }>('/accounts/creators', { method: 'POST', body: JSON.stringify(body) }) },
  updateCreator(id: string, body: Partial<CreatorProfile> & { displayName: string }): Promise<{ creator: CreatorProfile }> { return request<{ creator: CreatorProfile }>(`/accounts/creators/${id}`, { method: 'PUT', body: JSON.stringify(body) }) },
  archiveCreator(id: string): Promise<void> { return request<void>(`/accounts/creators/${id}`, { method: 'DELETE' }) },
  uploadCreatorImage(id: string, body: { fileName: string; mimeType: string; dataBase64: string }): Promise<{ creator: CreatorProfile }> { return request<{ creator: CreatorProfile }>(`/accounts/creators/${id}/images`, { method: 'POST', body: JSON.stringify(body) }) },
  deleteCreatorImage(id: string, imageId: string): Promise<void> { return request<void>(`/accounts/creators/${id}/images/${imageId}`, { method: 'DELETE' }) },

  // Character Builder — "generate a person from scratch," a standalone flow separate
  // from the main run pipeline. Stateless: returns candidate portraits for the caller to
  // preview and pick from, then hand the chosen one to uploadCreatorImage above (same as
  // an uploaded photo).
  generateCharacterPortraits(attributes: CharacterAttributes, count?: number): Promise<{ portraits: CharacterPortrait[] }> {
    return request<{ portraits: CharacterPortrait[] }>('/accounts/character-builder/generate', { method: 'POST', body: JSON.stringify({ attributes, count }) })
  },

  // Soul ID
  trainCreatorIdentity(creatorId: string): Promise<CreatorProfile> {
    return request<CreatorProfile>(`/accounts/creators/${creatorId}/train`, { method: 'POST' })
  },
  getCreatorIdentity(creatorId: string): Promise<{ faceEmbeddingStatus: string; primaryReferenceImageUrl?: string; referenceImageCount: number; avatarMode: string }> {
    return request(`/accounts/creators/${creatorId}/identity`)
  },

  createProduct(body: Partial<ProductProfile> & { name: string; clientId?: string }): Promise<{ product: ProductProfile }> {
    return request<{ product: ProductProfile }>('/accounts/products', { method: 'POST', body: JSON.stringify(body) })
  },
  ingestProductUrl(sourceUrl: string, clientId?: string): Promise<{ product: ProductProfile }> {
    return request<{ product: ProductProfile }>('/accounts/products/ingest-url', { method: 'POST', body: JSON.stringify({ sourceUrl, clientId }) })
  },
  updateProduct(id: string, body: Partial<ProductProfile> & { name: string }): Promise<{ product: ProductProfile }> {
    return request<{ product: ProductProfile }>(`/accounts/products/${id}`, { method: 'PUT', body: JSON.stringify(body) })
  },
  deleteProduct(id: string): Promise<void> {
    return request<void>(`/accounts/products/${id}`, { method: 'DELETE' })
  },
  uploadProductImage(id: string, body: { fileName: string; mimeType: string; dataBase64: string }): Promise<{ product: ProductProfile }> {
    return request<{ product: ProductProfile }>(`/accounts/products/${id}/images`, { method: 'POST', body: JSON.stringify(body) })
  },
  deleteProductImage(id: string, imageId: string): Promise<void> {
    return request<void>(`/accounts/products/${id}/images/${imageId}`, { method: 'DELETE' })
  },
  stats(): Promise<Stats> {
    return request<Stats>('/stats')
  },
  async queue(filter?: QueueFilter): Promise<ReviewItem[]> {
    const params = new URLSearchParams()
    if (filter?.status) params.set('status', filter.status)
    if (filter?.platform) params.set('platform', String(filter.platform))
    if (filter?.dryRun !== undefined) params.set('dryRun', String(filter.dryRun))
    const qs = params.toString()
    // C-2 compat: server now returns { items, hasMore, total } instead of bare array
    const raw = await request<ReviewItem[] | { items: ReviewItem[]; hasMore: boolean; total: number }>(
      `/queue${qs ? `?${qs}` : ''}`
    )
    return Array.isArray(raw) ? raw : raw.items
  },
  queueItem(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}`)
  },
  runs(): Promise<RunSummary[]> {
    return request<RunSummary[]>('/runs')
  },
  creators(): Promise<TrackedCreator[]> {
    return request<CreatorsResponse>('/creators').then((r) => r.creators)
  },
  /** Proactive discovery: niches + winning angles aggregated from local history. */
  trends(): Promise<TrendsResponse> {
    return request<TrendsResponse>('/accounts/trends')
  },
  /** Discovery: finds what's working in a niche, explains why, and returns a
   *  riff-able brief. Never throws on an empty/erroring external fetch — the
   *  backend returns 200 with a seeded brief. */
  discover(body: DiscoverRequest): Promise<DiscoverResponse> {
    return request<DiscoverResponse>('/accounts/discover', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  regenerateScript(id: string, body: { hook: string; points: string[]; cta: string }): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/regenerate-script`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },
  approve(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/approve`, { method: 'POST' })
  },
  reject(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/reject`, { method: 'POST' })
  },
  /** Send an approved/rejected item back to pending (undo decision). */
  sendBack(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/send-back`, { method: 'POST' })
  },
  /** Publish a previously-approved item to its connected platform account.
   *  Refuses (via the backend) for mock/dry-run items or anything not approved. */
  publish(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/publish`, { method: 'POST' })
  },
  /** Promote a dry-run (mock) item to a real, publishable render by re-rendering
   *  it live. Flips dryRun to false so the item can then be published. */
  regenerateLive(id: string): Promise<ReviewItem> {
    return request<ReviewItem>(`/queue/${id}/regenerate-live`, { method: 'POST' })
  },
  bulkApprove(ids: string[]): Promise<{ updated: number }> {
    return request<{ updated: number }>('/queue/bulk/approve', {
      method: 'POST',
      body: JSON.stringify({ ids })
    })
  },
  bulkReject(ids: string[]): Promise<{ updated: number }> {
    return request<{ updated: number }>('/queue/bulk/reject', {
      method: 'POST',
      body: JSON.stringify({ ids })
    })
  },
  bulkPublish(ids: string[]): Promise<{ published: number; failed: number; results: Array<{ id: string; success: boolean; error?: string }> }> {
    return request<{ published: number; failed: number; results: Array<{ id: string; success: boolean; error?: string }> }>('/queue/bulk/publish', {
      method: 'POST',
      body: JSON.stringify({ ids })
    })
  },
  /** Same-origin URL for a review item's finished video — consumed directly by a
   *  <video> element (History tab), not through this JSON client, because the
   *  response is binary MP4. The backend serves it at /api/media/:id behind the
   *  same session/Basic-Auth gate as every other data route. */
  mediaUrl(id: string): string {
    return `${API_BASE}/media/${encodeURIComponent(id)}`
  },

  // ---- Batch variation generation ----
  /** Natural-language front end to batchPlan below: describe a batch in plain
   *  language ("a week of fitness content for my protein brand, TikTok and
   *  Reels") and get back a draft BatchRequest to review/edit before planning.
   *  Never plans or enqueues anything itself. */
  batchPlanFromDescription(description: string, clientId?: string): Promise<BatchPlanDraft> {
    return request<BatchPlanDraft>('/accounts/batch/plan-from-description', {
      method: 'POST',
      body: JSON.stringify({ description, clientId })
    })
  },
  /** Plan a batch — returns cost breakdown, warnings, variation count. */
  batchPlan(body: BatchRequest): Promise<BatchPlan> {
    return request<BatchPlan>('/accounts/batch/plan', { method: 'POST', body: JSON.stringify(body) })
  },
  /** Confirm and enqueue a planned batch. */
  batchEnqueue(body: { plan: BatchPlan; request: BatchRequest }): Promise<{
    batchId: string
    variationCount: number
    totalEstimatedCost: number
    isDryRun: boolean
    overage: boolean
    overagePriceUsdPerRun?: number
    message: string
  }> {
    return request('/accounts/batch/enqueue', { method: 'POST', body: JSON.stringify(body) })
  },
  /** Get current batch progress (polling fallback). */
  batchProgress(batchId: string): Promise<BatchProgress> {
    return request<BatchProgress>(`/accounts/batch/${encodeURIComponent(batchId)}/progress`)
  },
  /** Cancel a running batch. */
  batchCancel(batchId: string): Promise<void> {
    return request(`/accounts/batch/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' })
  }
}

export function useCreators(): Promise<TrackedCreator[]> {
  return api.creators()
}
