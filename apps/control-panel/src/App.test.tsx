import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { App } from './App'

/**
 * Smoke tests for the control-panel shell. They exercise the real component
 * tree (theme state + persistence, tab navigation, the authenticated
 * workspace render) against a stubbed `fetch` so no backend is needed and the
 * suite stays offline and deterministic. There is no mock data path in the
 * app itself — only the network boundary is faked here.
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
    return jsonResponse({})
  }) as unknown as typeof fetch
}

/** The signed-in account email is only rendered in the workspace header, so it's
 *  the cleanest "we reached the authenticated shell" signal. */
async function reachWorkspace() {
  await screen.findByText(ACCOUNT.email)
}

describe('App (control panel shell)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    installFetchMock()
  })

  it('boots into the authenticated workspace after the session resolves', async () => {
    render(<App />)

    // It starts on the session-establishing splash, then reaches the workspace.
    expect(screen.getByText(/Establishing session_/i)).toBeInTheDocument()
    await reachWorkspace()

    // The nav is present. `DASHBOARD` appears twice (nav item + active h1), so
    // assert on the unique labels / a multiple-match set for the heading one.
    expect(screen.getByText('CREATOR SPY')).toBeInTheDocument()
    expect(screen.getByText('HISTORY')).toBeInTheDocument()
    expect(screen.getByText('BILLING')).toBeInTheDocument()
    expect(screen.getAllByText('DASHBOARD').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(ACCOUNT.email)).toBeInTheDocument()
  })

  it('renders the landing page (not the workspace) for an anonymous visitor', async () => {
    // No session: /accounts/me rejects, so App drops to the marketing page.
    globalThis.fetch = vi.fn(async () => {
      const res = jsonResponse({ error: 'No session' })
      return { ...res, ok: false, status: 401 } as Response
    }) as unknown as typeof fetch

    render(<App />)
    // Await the session check finishing before asserting on the landing page.
    await waitFor(() => expect(screen.queryByText(/Establishing session_/i)).not.toBeInTheDocument())
    expect(screen.queryByText(ACCOUNT.email)).not.toBeInTheDocument()
    // The landing page has at least one Get Started CTA. (Its preview nav
    // deliberately mirrors the workspace nav labels, so those overlap — the
    // account email is the unambiguous "workspace absent" signal above.)
    expect(screen.getAllByRole('button', { name: /Get Started/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /Get Started/i }).length).toBeGreaterThan(0)
  })

  it('toggles the theme, flips <html data-theme>, and persists the choice', async () => {
    const user = userEvent.setup()
    render(<App />)
    await reachWorkspace()

    // Defaults to dark and records it on the document root.
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('ugu-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: /◐ DARK/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /◐ DARK/ }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('ugu-theme')).toBe('light')
    expect(await screen.findByRole('button', { name: /◐ WHITE/ })).toBeInTheDocument()

    // And back.
    await user.click(screen.getByRole('button', { name: /◐ WHITE/ }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('navigates to the History tab and renders its category switcher', async () => {
    const user = userEvent.setup()
    render(<App />)
    await reachWorkspace()

    await user.click(screen.getByRole('button', { name: /HISTORY/ }))

    // Main heading reflects the active tab.
    expect(await screen.findByRole('heading', { name: 'HISTORY' })).toBeInTheDocument()
    // History's three categories are present (fed by the empty /queue + /runs).
    expect(screen.getByRole('button', { name: /VIDEO DEMOS/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /SCRIPT DEMOS/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WORKFLOW DEMOS/ })).toBeInTheDocument()
  })
})
