import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'
import { App } from './App'
import { APP_BASENAME } from './lib/paths'

/**
 * Smoke tests for the control-panel shell: session, grouped nav, theme via
 * Settings, and real routes (not tab-state).
 */

const ACCOUNT = {
  id: 'acc_test',
  email: 'ops@ugu.test',
  orgId: 'org_test',
  role: 'admin',
  orgName: 'UGU TEST'
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as Response
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/accounts/me')) {
      return jsonResponse({ account: ACCOUNT, csrfToken: 'csrf_test', mfaEnabled: false })
    }
    if (url.endsWith('/stats')) return jsonResponse({ totalRemakes: 0 })
    if (url.endsWith('/queue')) return jsonResponse([])
    if (url.endsWith('/runs')) return jsonResponse([])
    if (url.endsWith('/accounts/billing')) {
      return jsonResponse({ tiers: [], plan: { tierId: 'starter', status: 'active' }, runsUsedThisMonth: 3, monthlyRunLimit: 10, overage: { priceUsdPerRun: 0, overageRunsThisMonth: 0, chargedThisMonth: 0, totalUsdThisMonth: 0 } })
    }
    if (url.endsWith('/creators')) return jsonResponse({ creators: [] })
    if (url.endsWith('/models')) return jsonResponse({ models: [] })
    if (url.endsWith('/clients') || url.includes('/accounts/clients')) return jsonResponse({ clients: [] })
    if (url.endsWith('/accounts/members')) return jsonResponse({ members: [ACCOUNT], role: ACCOUNT.role, canManageTeam: true })
    return jsonResponse({})
  }) as unknown as typeof fetch
}

function renderApp(entry = '/app') {
  return render(
    <MemoryRouter basename={APP_BASENAME} initialEntries={[entry]}>
      <App />
    </MemoryRouter>
  )
}

async function reachWorkspace() {
  await screen.findByText(ACCOUNT.email)
}

describe('App (control panel shell)', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ugu-onboarding-done', '1')
    sessionStorage.clear()
    installFetchMock()
  })

  it('boots into the authenticated workspace after the session resolves', async () => {
    renderApp()

    expect(screen.getByText(/Establishing session/i)).toBeInTheDocument()
    await reachWorkspace()

    expect(screen.getByRole('heading', { name: 'This Week' })).toBeInTheDocument()
    expect(screen.getByText('Intel')).toBeInTheDocument()
    expect(screen.getByText('Studio')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('Billing')).toBeInTheDocument()
    expect(screen.getByText(ACCOUNT.email)).toBeInTheDocument()
  })

  it('lets an anonymous visitor reach sign-in from the landing page', async () => {
    const user = userEvent.setup()
    globalThis.fetch = vi.fn(async () => {
      const res = jsonResponse({ error: 'No session' })
      return { ...res, ok: false, status: 401 } as Response
    }) as unknown as typeof fetch

    renderApp()
    await waitFor(() => expect(screen.queryByText(/Establishing session/i)).not.toBeInTheDocument())
    expect(screen.queryByText(ACCOUNT.email)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Spy The Format/i })).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /^Sign In$/i })[0])

    expect(await screen.findByText(/Access your account/i)).toBeInTheDocument()
  })

  it('opens sign-up directly from the get-started query route', async () => {
    globalThis.fetch = vi.fn(async () => {
      const res = jsonResponse({ error: 'No session' })
      return { ...res, ok: false, status: 401 } as Response
    }) as unknown as typeof fetch

    renderApp('/app?mode=signup')

    expect(await screen.findByText(/Create your account/i)).toBeInTheDocument()
  })

  it('toggles the theme from Settings and persists the choice', async () => {
    const user = userEvent.setup()
    renderApp()
    await reachWorkspace()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('ugu-theme')).toBe('dark')

    await user.click(screen.getByRole('link', { name: /Settings/i }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^dark$/i }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('ugu-theme')).toBe('dark')

    await user.click(screen.getByRole('button', { name: /^light$/i }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('ugu-theme')).toBe('light')
  })

  it('toggles the theme from the always-visible header button, not just Settings', async () => {
    const user = userEvent.setup()
    renderApp()
    await reachWorkspace()

    expect(document.documentElement.dataset.theme).toBe('dark')
    const headerToggle = screen.getByRole('button', { name: /switch to light background/i })

    await user.click(headerToggle)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('ugu-theme')).toBe('light')
    expect(screen.getByRole('button', { name: /switch to dark background/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /switch to dark background/i }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('ugu-theme')).toBe('dark')
  })

  it('shows a persistent runs-used pill in the header, linking to Billing', async () => {
    const user = userEvent.setup()
    renderApp()
    await reachWorkspace()

    const pill = await screen.findByRole('button', { name: /3 \/ 10 runs/i })
    await user.click(pill)
    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeInTheDocument()
  })

  it('navigates to Library via a real route and renders its category switcher', async () => {
    const user = userEvent.setup()
    renderApp()
    await reachWorkspace()

    await user.click(screen.getByRole('link', { name: /Library/i }))

    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /VIDEO DEMOS/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SCRIPT DEMOS/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WORKFLOW DEMOS/ })).toBeInTheDocument()
  })

  it('shows a recent-activity feed on This Week built from real queue items', async () => {
    const QUEUE_ITEMS = [
      {
        id: 'item_recent_1',
        runId: 'run_1',
        niche: 'fitness',
        videoPath: '/tmp/item_recent_1.mp4',
        platform: 'tiktok',
        script: {
          videoId: 'vid_1',
          hook: 'This one habit changed my mornings forever',
          points: ['point a', 'point b'],
          cta: 'Follow for more',
          durationSec: 30,
          brandVoice: 'energetic',
          locale: 'en-US',
          trendingPhrases: ['#fitness']
        },
        score: 82,
        flags: [],
        status: 'approved',
        createdAt: '2026-08-30T12:00:00.000Z'
      },
      {
        id: 'item_recent_2',
        runId: 'run_1',
        niche: 'fitness',
        videoPath: '/tmp/item_recent_2.mp4',
        platform: 'youtube_shorts',
        script: {
          videoId: 'vid_2',
          hook: 'Why nobody talks about this recovery trick',
          points: ['point a', 'point b'],
          cta: 'Comment below',
          durationSec: 45,
          brandVoice: 'calm',
          locale: 'en-US',
          trendingPhrases: []
        },
        score: 64,
        flags: [],
        status: 'pending',
        createdAt: '2026-08-31T09:00:00.000Z'
      }
    ]

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/accounts/me')) {
        return jsonResponse({ account: ACCOUNT, csrfToken: 'csrf_test', mfaEnabled: false })
      }
      if (url.endsWith('/stats')) return jsonResponse({ totalRemakes: 0 })
      if (url.endsWith('/queue')) return jsonResponse(QUEUE_ITEMS)
      if (url.endsWith('/runs')) return jsonResponse([])
      if (url.endsWith('/accounts/billing')) {
        return jsonResponse({ tiers: [], plan: { tierId: 'starter', status: 'active' }, runsUsedThisMonth: 3, monthlyRunLimit: 10, overage: { priceUsdPerRun: 0, overageRunsThisMonth: 0, chargedThisMonth: 0, totalUsdThisMonth: 0 } })
      }
      if (url.endsWith('/creators')) return jsonResponse({ creators: [] })
      if (url.endsWith('/models')) return jsonResponse({ models: [] })
      if (url.endsWith('/clients') || url.includes('/accounts/clients')) return jsonResponse({ clients: [] })
      if (url.endsWith('/accounts/members')) return jsonResponse({ members: [ACCOUNT], role: ACCOUNT.role, canManageTeam: true })
      return jsonResponse({})
    }) as unknown as typeof fetch

    renderApp()
    await reachWorkspace()

    expect(await screen.findByText('This one habit changed my mornings forever')).toBeInTheDocument()
    expect(await screen.findByText('Why nobody talks about this recovery trick')).toBeInTheDocument()
  })
})
