import { useState, useEffect, type FormEvent } from 'react'
import {
  loadAccount,
  saveAccount,
  saveCsrf,
  clearSession,
  type PublicAccount
} from './lib/auth'
import { api } from './lib/api'
import { Dashboard } from './tabs/Dashboard'
import { History } from './tabs/History'
import { Rewriter } from './tabs/Rewriter'
import { Spy } from './tabs/Spy'
import { Billing } from './tabs/Billing'
import { VideoGenerator } from './tabs/VideoGenerator'
import { Remix } from './tabs/Remix'
import { Landing } from './Landing'
import { Logo } from './components/Logo'

type TabId = 'dashboard' | 'spy' | 'rewriter' | 'remix' | 'generator' | 'history' | 'billing'

const NAV: { id: TabId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'DASHBOARD', icon: '◉' },
  { id: 'spy', label: 'CREATOR SPY', icon: '◈' },
  { id: 'rewriter', label: 'SCRIPT REWRITER', icon: '⌥' },
  { id: 'remix', label: 'REMIX FROM URL', icon: '↗' },
  { id: 'generator', label: 'VIDEO GENERATOR', icon: '▶' },
  { id: 'history', label: 'HISTORY', icon: '▤' },
  { id: 'billing', label: 'BILLING', icon: '$' }
]

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
  const [tab, setTab] = useState<TabId>('dashboard')
  const [account, setAccount] = useState<PublicAccount | null>(() => loadAccount())
  const [checking, setChecking] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  // Guests land on the marketing page first; Get Started / Sign In open auth.
  const [guestView, setGuestView] = useState<'landing' | 'auth'>('landing')
  const [time, setTime] = useState(new Date().toLocaleTimeString('en-US', { hour12: false }))
  // Logged-in users can move freely between their workspace and the marketing page.
  const [screen, setScreen] = useState<'workspace' | 'landing'>('workspace')
  const [theme, setTheme] = useState<Theme>(initialTheme)

  // Apply the theme to the document root so every surface (workspace, landing
  // and auth) follows it, and persist the choice.
  useEffect(() => {
    const html = document.documentElement
    html.dataset.theme = theme
    html.classList.add('theme-transition')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore storage errors
    }
    const t = window.setTimeout(() => html.classList.remove('theme-transition'), 350)
    return () => window.clearTimeout(t)
  }, [theme])

  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString('en-US', { hour12: false })), 1000)
    return () => clearInterval(t)
  }, [])

  // On mount, verify the session cookie is still valid against the real backend.
  // If the cookie is gone/expired, drop to the auth screen even if we have a
  // cached account in sessionStorage.
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
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center" style={{ fontFamily: 'Inter, sans-serif' }}>
        <span className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest blink">Establishing session_</span>
      </div>
    )
  }

  // Unauthenticated: show the landing page. Get Started / Sign In reveal the auth
  // screen; a successful login sets `account` and reveals the app.
  if (!account) {
    if (guestView === 'auth') {
      return <AuthScreen onAuthed={(acc) => setAccount(acc)} onBack={() => setGuestView('landing')} />
    }
    return <Landing onGetStarted={() => setGuestView('auth')} onSignIn={() => setGuestView('auth')} />
  }

  // Authenticated: a logged-in user can browse the marketing page too. The logo /
  // "Back to Workspace" return them here without logging out.
  if (screen === 'landing') {
    return (
      <Landing
        authenticated
        onWorkspace={() => setScreen('workspace')}
        onGetStarted={() => setScreen('workspace')}
        onSignIn={() => setScreen('workspace')}
      />
    )
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex flex-col" style={{ fontFamily: 'Inter, sans-serif' }}>
      <header className="border-b border-[var(--color-raised)] px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Logo onClick={() => setTab('dashboard')} />
          <span className="text-[10px] font-mono text-[var(--color-faint)] uppercase tracking-widest hidden sm:block">
            AI-Powered Viral Engine
          </span>
        </div>
        <div className="flex items-center gap-6">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="text-[10px] font-mono uppercase tracking-widest border px-2.5 py-1 transition-colors"
            style={{
              color: theme === 'light' ? 'var(--color-on-accent)' : 'var(--color-muted-2)',
              backgroundColor: theme === 'light' ? 'var(--color-lime)' : 'transparent',
              borderColor: theme === 'light' ? 'var(--color-lime)' : 'var(--color-raised)'
            }}
            title="Toggle between dark and white theme"
          >
            {theme === 'light' ? '◐ WHITE' : '◐ DARK'}
          </button>
          <button
            onClick={() => setScreen('landing')}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)] transition-colors"
            title="View the marketing page"
          >
            Landing ↗
          </button>
          <span className="text-[10px] font-mono text-[var(--color-muted-2)] hidden md:block">
            SYS: <span className="text-[var(--color-lime)]">ONLINE</span>
          </span>
          <span className="text-[10px] font-mono text-[var(--color-muted-3)] hidden sm:block">{time}</span>
          <span className="text-[10px] font-mono text-[var(--color-muted-2)] hidden lg:block">{account.email}</span>
          <button
            onClick={() => setShowPassword(true)}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)] transition-colors"
          >
            Password
          </button>
          <button
            onClick={handleLogout}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-red)] transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-14 sm:w-52 border-r border-[var(--color-raised)] bg-[var(--color-nav)] flex flex-col shrink-0">
          <div className="flex-1 py-4">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors group"
                style={{
                  backgroundColor: tab === n.id ? 'var(--color-surface)' : 'transparent',
                  borderLeft: tab === n.id ? '2px solid var(--color-lime)' : '2px solid transparent'
                }}
              >
                <span className="text-base shrink-0" style={{ color: tab === n.id ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                  {n.icon}
                </span>
                <span
                  className="text-[11px] font-mono uppercase tracking-widest hidden sm:block transition-colors"
                  style={{ color: tab === n.id ? 'var(--color-lime)' : 'var(--color-muted-2)' }}
                >
                  {n.label}
                </span>
              </button>
            ))}
          </div>
          <div className="px-4 pb-4 hidden sm:block">
            <div className="border border-[var(--color-raised)] p-3">
              <p className="text-[9px] font-mono text-[var(--color-faint)] uppercase tracking-widest">Session</p>
              <p className="text-[11px] font-mono text-[var(--color-lime)] mt-1 truncate">{account.role.toUpperCase()}</p>
            </div>
          </div>
        </nav>

        <main className="flex-1 overflow-y-auto p-6 scrollbar-hidden">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-black uppercase tracking-wider" style={{ fontFamily: 'Barlow Condensed', color: 'var(--color-text)' }}>
                {NAV.find((n) => n.id === tab)?.label}
              </h1>
              <p className="text-[11px] font-mono text-[var(--color-muted-3)] mt-1 uppercase tracking-widest">
                {tab === 'dashboard' && 'Real-time viral intelligence overview'}
                {tab === 'spy' && 'Tracking serial viral creators across platforms'}
                {tab === 'rewriter' && 'AI-powered viral script regeneration'}
                {tab === 'remix' && 'Adapt a viral video to your niche'}
                {tab === 'generator' && 'Pick a model by the result you want'}
                {tab === 'history' && 'Everything you have made, organised'}
                {tab === 'billing' && 'Plan, usage and consumption billing'}
              </p>
            </div>
          </div>

          {tab === 'dashboard' && <Dashboard onOpenHistory={() => setTab('history')} />}
          {tab === 'spy' && <Spy />}
          {tab === 'rewriter' && <Rewriter />}
          {tab === 'remix' && <Remix />}
          {tab === 'generator' && <VideoGenerator />}
          {tab === 'history' && <History />}
          {tab === 'billing' && <Billing />}
        </main>
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  )
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset'

function AuthScreen({ onAuthed, onBack }: { onAuthed: (acc: PublicAccount) => void; onBack: () => void }) {
  const [mode, setMode] = useState<AuthMode>('signin')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // MFA: when a sign-in returns mfaRequired, we hold the challenge token and ask
  // for the TOTP code before completing the session.
  const [mfaToken, setMfaToken] = useState<string | null>(null)

  async function finishSession(acc: PublicAccount, csrf?: string) {
    saveCsrf(csrf ?? null)
    saveAccount(acc)
    onAuthed(acc)
  }

  async function handleSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      const res = await api.login({
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || '')
      })
      if (res.mfaRequired && res.mfaToken) {
        setMfaToken(res.mfaToken)
        setInfo('Two-factor authentication required.')
        setMode('signin')
        return
      }
      await finishSession(res.account, res.csrfToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleMfa(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!mfaToken) return
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      const res = await api.mfaChallenge({ mfaToken, code: String(fd.get('code') || '') })
      await finishSession(res.account, res.csrfToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      const res = await api.signup({
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        orgName: String(fd.get('orgName') || '') || undefined
      })
      await finishSession(res.account)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleForgot(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      await api.forgotPassword({ email: String(fd.get('email') || '') })
      // The reset token is NEVER returned to the client / shown in the UI — it is
      // delivered out-of-band (email in production; the server log in dev). We only
      // show a generic message regardless of whether the account exists, so this
      // endpoint can't be used to enumerate which emails have accounts.
      setInfo(
        'If that email has an account, password reset instructions have been sent. Follow them to reset your password.'
      )
      setMode('signin')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      await api.resetPassword({
        token: String(fd.get('token') || ''),
        newPassword: String(fd.get('password') || '')
      })
      setInfo('Password reset. Sign in with your new password.')
      setMode('signin')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors'
  const label = 'block text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest mb-1'
  const field = (id: string, title: string, type = 'text') => (
    <div>
      <label className={label} htmlFor={id}>
        {title}
      </label>
      <input id={id} name={id} type={type} className={input} autoComplete={type === 'password' ? 'current-password' : 'on'} />
    </div>
  )

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-6" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest hover:text-[var(--color-lime)] transition-colors">
            ← Back to site
          </button>
        </div>
        <div className="flex items-center gap-2 mb-6">
          <span className="w-2 h-2 rounded-none bg-[var(--color-lime)] pulse-lime block" />
          <span className="text-xl font-black uppercase tracking-widest text-[var(--color-text)]" style={{ fontFamily: 'Barlow Condensed' }}>
            UGU <span className="text-[var(--color-lime)]">PROGRAM</span>
          </span>
        </div>

        <div className="flex gap-1 mb-4">
          {(
            [
              ['signin', 'SIGN IN'],
              ['signup', 'SIGN UP'],
              ['forgot', 'FORGOT'],
              ['reset', 'RESET']
            ] as [AuthMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m)
                setError(null)
                setInfo(null)
                setMfaToken(null)
              }}
              className="text-[10px] font-mono uppercase tracking-widest px-2 py-1.5 border transition-colors flex-1"
              style={{
                color: mode === m ? 'var(--color-on-accent)' : 'var(--color-muted)',
                backgroundColor: mode === m ? 'var(--color-lime)' : 'transparent',
                borderColor: mode === m ? 'var(--color-lime)' : 'var(--color-faint)'
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          {mode === 'signin' && mfaToken && (
            <form onSubmit={handleMfa} className="space-y-4">
              <p className="text-[11px] font-mono text-[var(--color-muted-4)] uppercase tracking-widest">Two-factor code</p>
              <div>{field('code', 'Authenticator Code', 'text')}</div>
              {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Verify
              </button>
            </form>
          )}

          {mode === 'signin' && !mfaToken && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Access your account</p>
              {field('email', 'Email', 'email')}
              {field('password', 'Password', 'password')}
              {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] font-mono text-[var(--color-lime)]">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Sign In
              </button>
            </form>
          )}

          {mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Create your account</p>
              {field('email', 'Email', 'email')}
              {field('orgName', 'Organization (optional)')}
              {field('password', 'Password (8+ chars)', 'password')}
              {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] font-mono text-[var(--color-lime)]">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Create Account
              </button>
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Recover your password</p>
              {field('email', 'Email', 'email')}
              {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] font-mono text-[var(--color-lime)] break-all">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-orange)', color: 'var(--color-on-accent)' }}
              >
                Request Reset
              </button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={handleReset} className="space-y-4">
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Set a new password</p>
              {field('token', 'Reset Token', 'text')}
              {field('password', 'New Password (8+ chars)', 'password')}
              {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] font-mono text-[var(--color-lime)] break-all">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Reset Password
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      await api.changePassword({
        currentPassword: String(fd.get('currentPassword') || ''),
        newPassword: String(fd.get('newPassword') || '')
      })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors'
  const label = 'block text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest mb-1'

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-black uppercase tracking-widest mb-4" style={{ fontFamily: 'Barlow Condensed' }}>
          Change Password
        </p>
        {done ? (
          <div className="space-y-4">
            <p className="text-[11px] font-mono text-[var(--color-lime)]">
              Password changed. Your other sessions were revoked — please sign in again.
            </p>
            <button
              onClick={onClose}
              className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110"
              style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className={label} htmlFor="currentPassword">
                Current Password
              </label>
              <input id="currentPassword" name="currentPassword" type="password" className={input} autoComplete="current-password" />
            </div>
            <div>
              <label className={label} htmlFor="newPassword">
                New Password (8+ chars)
              </label>
              <input id="newPassword" name="newPassword" type="password" className={input} autoComplete="new-password" />
            </div>
            {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
              style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
            >
              {busy ? 'Saving...' : 'Change Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
