import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import {
  loadAccount,
  saveAccount,
  saveCsrf,
  clearSession,
  type PublicAccount
} from './lib/auth'
import { api } from './lib/api'
import { History } from './tabs/History'
import { Rewriter } from './tabs/Rewriter'
import { Spy } from './tabs/Spy'
import { Billing } from './tabs/Billing'
import { VideoGenerator } from './tabs/VideoGenerator'
import { Remix } from './tabs/Remix'
import { WorkspaceLayout } from './layout/WorkspaceLayout'
import { SignIn } from './pages/SignIn'
import { ThisWeek } from './pages/ThisWeek'
import { IntelSource } from './pages/IntelSource'
import { StudioRun } from './pages/StudioRun'
import { BatchStudio } from './pages/BatchStudio'
import { BatchProgress } from './pages/BatchProgress'
import { LibraryItem } from './pages/LibraryItem'
import { ReviewPage } from './pages/ReviewPage'
import { ReviewDetail } from './pages/ReviewDetail'
import { Brand, BrandClient } from './pages/Brand'
import { Settings } from './pages/Settings'
import { Landing } from './Landing'

const THEME_KEY = 'ugu-theme'
type Theme = 'dark' | 'light'

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // ignore storage errors
  }
  return 'dark'
}

export function App() {
  const [account, setAccount] = useState<PublicAccount | null>(() => loadAccount())
  const [checking, setChecking] = useState(true)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  // Always respect user's theme choice — both authenticated and demo workspace
  const effectiveTheme = theme

  // Set theme synchronously BEFORE first render so it applies to landing page
  // without waiting for useEffect. This is critical for accessibility tests.
  if (typeof window !== 'undefined') {
    const html = document.documentElement
    html.dataset.theme = effectiveTheme
  }

  useEffect(() => {
    const html = document.documentElement
    html.dataset.theme = effectiveTheme
    html.classList.add('theme-transition')
    // Only persist theme when authenticated (workspace theme preference)
    if (account) {
      try {
        localStorage.setItem(THEME_KEY, theme)
      } catch {
        // ignore storage errors
      }
    }
    const t = window.setTimeout(() => html.classList.remove('theme-transition'), 350)
    return () => window.clearTimeout(t)
  }, [effectiveTheme, theme, account])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const me = await api.me()
        if (cancelled) return
        saveCsrf(me.csrfToken ?? null)
        saveAccount(me.account)
        setAccount(me.account)
      } catch {
        if (!cancelled) {
          clearSession()
          setAccount(null)
        }
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleLogout() {
    try {
      await api.logout()
    } catch {
      // Ignore — we clear locally regardless.
    }
    clearSession()
    setAccount(null)
    // A stale ?mode=signup/signin from the original auth flow otherwise
    // survives in the URL through the whole authenticated session (nothing
    // clears it once signed in) and immediately re-triggers showingAuth once
    // account goes null again — landing a just-signed-out user back on the
    // signup form instead of the marketing page.
    navigate({ pathname: '/', search: '' })
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <span className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">Establishing session</span>
      </div>
    )
  }

  const authMode = searchParams.get('mode')
  const showingAuth = !account && ['signin', 'signup', 'forgot', 'reset', 'invite'].includes(authMode ?? '')

  if (showingAuth) {
    return <SignIn onAuthed={setAccount} />
  }

  const effectiveAccount: PublicAccount = account || {
    id: 'guest',
    email: 'guest@micany.com',
    orgId: 'guest-org',
    role: 'member',
    orgName: 'Demo Workspace'
  }

  return (
    <Routes>
      <Route
        element={
          <WorkspaceLayout
            account={effectiveAccount}
            isGuest={!account}
            onLogout={handleLogout}
            onSignIn={() => navigate({ pathname: '/', search: '?mode=signin' })}
          />
        }
      >
        <Route
          index
          element={
            account ? (
              <ThisWeek />
            ) : (
              <Landing
                onGetStarted={() => {
                  navigate({ pathname: '/', search: '?mode=signup' })
                }}
                onSignIn={() => {
                  navigate({ pathname: '/', search: '?mode=signin' })
                }}
              />
            )
          }
        />
        <Route path="intel" element={<Spy />} />
        <Route path="intel/remix" element={<Remix />} />
        <Route path="intel/:sourceId" element={<IntelSource />} />
        <Route path="studio" element={<VideoGenerator />} />
        <Route path="studio/script/:id" element={<Rewriter />} />
        <Route path="studio/batch" element={<BatchStudio />} />
        <Route path="studio/batch/:batchId" element={<BatchProgress />} />
        <Route path="studio/runs/:runId" element={<StudioRun />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="review/:id" element={<ReviewDetail />} />
        <Route path="library" element={<History />} />
        <Route path="library/:id" element={<LibraryItem />} />
        <Route path="brand" element={<Brand />} />
        <Route path="brand/clients/:id" element={<BrandClient />} />
        <Route path="billing" element={<Billing />} />
        <Route
          path="settings"
          element={<Settings theme={theme} onTheme={setTheme} email={account?.email ?? 'guest@micany.com'} isGuest={!account} onSignIn={() => navigate({ pathname: '/', search: '?mode=signin' })} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
