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
  TrendsResponse
} from './types'
import { loadCsrf } from './auth'

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
  run(body: { clientId: string; dryRun: boolean }): Promise<RunResponse> {
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
        brief: body.brief
      })
    })
  },

  // ---- Data ----
  stats(): Promise<Stats> {
    return request<Stats>('/stats')
  },
  queue(filter?: QueueFilter): Promise<ReviewItem[]> {
    const params = new URLSearchParams()
    if (filter?.status) params.set('status', filter.status)
    if (filter?.platform) params.set('platform', String(filter.platform))
    if (filter?.dryRun !== undefined) params.set('dryRun', String(filter.dryRun))
    const qs = params.toString()
    return request<ReviewItem[]>(`/queue${qs ? `?${qs}` : ''}`)
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
  /** Same-origin URL for a review item's finished video — consumed directly by a
   *  <video> element (History tab), not through this JSON client, because the
   *  response is binary MP4. The backend serves it at /api/media/:id behind the
   *  same session/Basic-Auth gate as every other data route. */
  mediaUrl(id: string): string {
    return `${API_BASE}/media/${encodeURIComponent(id)}`
  }
}

export function useCreators(): Promise<TrackedCreator[]> {
  return api.creators()
}
