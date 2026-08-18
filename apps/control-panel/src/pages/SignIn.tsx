import { useState, type FormEvent } from 'react'
import { saveAccount, saveCsrf, type PublicAccount } from '../lib/auth'
import { api } from '../lib/api'
import { Logo } from '../components/Logo'

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset'

export function SignIn({ onAuthed }: { onAuthed: (acc: PublicAccount) => void }) {
  const [mode, setMode] = useState<AuthMode>('signin')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
      await api.signup({
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        orgName: String(fd.get('orgName') || '') || undefined
      })
      const me = await api.me()
      await finishSession(me.account, me.csrfToken)
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
      setInfo('If that email has an account, password reset instructions have been sent. Follow them to reset your password.')
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

  const input =
    'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors'
  const label = 'block text-[10px] uppercase tracking-widest text-[var(--color-muted)] mb-1'
  const field = (id: string, title: string, type = 'text') => (
    <div>
      <label className={label} htmlFor={id}>
        {title}
      </label>
      <input id={id} name={id} type={type} className={input} autoComplete={type === 'password' ? 'current-password' : 'on'} />
    </div>
  )

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <span className="w-1.5 h-1.5 bg-[var(--color-lime)]" aria-hidden="true" />
          <Logo />
        </div>

        <div className="flex gap-1 mb-4">
          {(
            [
              ['signin', 'Sign in'],
              ['signup', 'Sign up'],
              ['forgot', 'Forgot'],
              ['reset', 'Reset']
            ] as [AuthMode, string][]
          ).map(([m, tabLabel]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m)
                setError(null)
                setInfo(null)
                setMfaToken(null)
              }}
              className="text-[10px] uppercase tracking-widest px-2 py-1.5 border transition-colors flex-1"
              style={{
                color: mode === m ? 'var(--color-on-accent)' : 'var(--color-muted)',
                backgroundColor: mode === m ? 'var(--color-lime)' : 'transparent',
                borderColor: mode === m ? 'var(--color-lime)' : 'var(--color-faint)'
              }}
            >
              {tabLabel}
            </button>
          ))}
        </div>

        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          {mode === 'signin' && mfaToken && (
            <form onSubmit={handleMfa} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">Two-factor code</p>
              <div>{field('code', 'Authenticator code', 'text')}</div>
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Verify
              </button>
            </form>
          )}

          {mode === 'signin' && !mfaToken && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">Access your account</p>
              {field('email', 'Email', 'email')}
              {field('password', 'Password', 'password')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] text-[var(--color-lime)]">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Sign In
              </button>
            </form>
          )}

          {mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">Create your account</p>
              {field('email', 'Email', 'email')}
              {field('orgName', 'Organization (optional)')}
              {field('password', 'Password (8+ chars)', 'password')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] text-[var(--color-lime)]">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Create Account
              </button>
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">Recover your password</p>
              {field('email', 'Email', 'email')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] text-[var(--color-lime)] break-all">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-orange)', color: 'var(--color-on-accent)' }}
              >
                Request Reset
              </button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={handleReset} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">Set a new password</p>
              {field('token', 'Reset token', 'text')}
              {field('password', 'New password (8+ chars)', 'password')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] text-[var(--color-lime)] break-all">{info}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
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