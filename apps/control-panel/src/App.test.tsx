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
})
