import { useState, type FormEvent, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { saveAccount, saveCsrf, type PublicAccount } from '../lib/auth'
import { api } from '../lib/api'
import { Logo } from '../components/Logo'

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset' | 'invite'
const AUTH_MODES: AuthMode[] = ['signin', 'signup', 'forgot', 'reset', 'invite']

export function SignIn({ onAuthed }: { onAuthed: (acc: PublicAccount) => void }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const inviteToken = searchParams.get('token') ?? ''
  const [mode, setMode] = useState<AuthMode>(() => {
    const m = searchParams.get('mode')
    return (AUTH_MODES as string[]).includes(m ?? '') ? (m as AuthMode) : 'signup'
  })

  useEffect(() => {
    const m = searchParams.get('mode')
    if ((AUTH_MODES as string[]).includes(m ?? '')) {
      setMode(m as AuthMode)
    }
  }, [searchParams])
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
      const res = await api.signup({
        email: String(fd.get('email') || ''),
        password: String(fd.get('password') || ''),
        orgName: String(fd.get('orgName') || '') || undefined
      })
      await finishSession(res.account, (res as any).csrfToken)
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

  async function handleInviteAccept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      const res = await api.acceptInvite({
        token: inviteToken,
        password: String(fd.get('password') || '')
      })
      await finishSession(res.account)
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

  // Use design tokens for proper theme support (light/dark)
  const input = 'w-full bg-[var(--color-input)] border border-[var(--color-border)] text-[var(--color-text)] text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors'
  const label = 'block text-[10px] uppercase tracking-widest text-[var(--color-muted-4)] mb-1'
  const field = (id: string, title: string, type = 'text') => (
    <div>
      <label className={label} htmlFor={id}>
        {title}
      </label>
      <input id={id} name={id} type={type} className={input} autoComplete={type === 'password' ? 'current-password' : 'on'} />
    </div>
  )

  return (
   <div className="min-h-screen w-full bg-[var(--color-bg)] flex flex-col items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center w-8 h-8 border border-[var(--color-border)] text-[var(--color-muted-3)] hover:text-[var(--color-text)] hover:border-[var(--color-text)] transition-colors rounded-md"
            aria-label="Back to home"
          >
            ←
          </button>
          <button onClick={() => navigate('/')} className="cursor-pointer" aria-label="Back to home">
            <Logo />
          </button>
        </div>

        {mode !== 'invite' && (
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
                color: mode === m ? 'var(--color-on-accent)' : 'var(--color-text)',
                backgroundColor: mode === m ? 'var(--color-lime)' : 'transparent',
                borderColor: mode === m ? 'var(--color-lime)' : 'var(--color-border)'
              }}
            >
              {tabLabel}
            </button>
          ))}
        </div>
        )}

        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-2xl">
          {mode === 'invite' && (
            <form onSubmit={handleInviteAccept} className="space-y-4">
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">You've been invited — set a password to join</p>
              {field('password', 'Password (8+ chars)', 'password')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              <button
                type="submit"
                disabled={busy || !inviteToken}
                className="w-full py-3 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                Accept invite &amp; join
              </button>
              {!inviteToken && <p className="text-[11px] text-[var(--color-red)]">This invite link is missing its token.</p>}
            </form>
          )}

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
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">Access your account</p>
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
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">Create your account</p>
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
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">Recover your password</p>
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
              <p className="text-[11px] uppercase tracking-widest text-[var(--color-muted-4)]">Set a new password</p>
              {field('token', 'Reset token', 'text')}
              {field('password', 'New password (8+ chars)', 'password')}
              {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
              {info && <p className="text-[11px] text-[var(--color-lime)]">{info}</p>}
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

      {/* Generated video showcase — populated with generated GIFs */}
      <div className="w-full max-w-5xl mt-12">
        <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-3)] mb-4 text-center">What our pipeline creates</p>
        <VideoCarousel />
      </div>
    </div>
  )
}

const CAROUSEL_ITEMS = [
  { niche: 'Fitness', hook: 'Stop doing crunches', score: 94, dur: '0:28', platform: 'TT' },
  { niche: 'Skincare', hook: 'Your moisturizer is lying', score: 87, dur: '0:35', platform: 'IG' },
  { niche: 'Pet gear', hook: 'My anxious dog finally sleeps', score: 91, dur: '0:22', platform: 'TT' },
  { niche: 'Productivity', hook: 'Delete this app now', score: 96, dur: '0:30', platform: 'YT' },
  { niche: 'Finance', hook: 'The $5 trick banks hate', score: 89, dur: '0:18', platform: 'TT' },
  { niche: 'Cooking', hook: 'One pan. Five minutes.', score: 92, dur: '0:25', platform: 'IG' },
  { niche: 'Fashion', hook: 'Outfit hack nobody knows', score: 85, dur: '0:32', platform: 'TT' },
  { niche: 'Tech', hook: 'This gadget replaced my phone', score: 93, dur: '0:27', platform: 'YT' },
  { niche: 'Wellness', hook: 'Morning routine was wrong', score: 88, dur: '0:20', platform: 'IG' },
  { niche: 'DIY', hook: 'Fix anything with this', score: 90, dur: '0:33', platform: 'TT' },
]

function VideoCarousel() {
  const SHAPES = [
    { w: 'w-40', h: 180, radius: 'rounded-2xl' },
    { w: 'w-48', h: 240, radius: 'rounded-3xl' },
    { w: 'w-36', h: 200, radius: 'rounded-xl' },
    { w: 'w-44', h: 260, radius: 'rounded-[28px]' },
    { w: 'w-40', h: 190, radius: 'rounded-2xl' },
    { w: 'w-52', h: 220, radius: 'rounded-[32px]' },
    { w: 'w-38', h: 210, radius: 'rounded-3xl' },
    { w: 'w-44', h: 170, radius: 'rounded-xl' },
    { w: 'w-48', h: 250, radius: 'rounded-[24px]' },
    { w: 'w-40', h: 200, radius: 'rounded-2xl' },
  ]

  return (
    <div className="relative overflow-hidden py-4">
      <div className="flex gap-4 items-center animate-[scroll_35s_linear_infinite] hover:[animation-play-state:paused]">
        {[...CAROUSEL_ITEMS, ...CAROUSEL_ITEMS].map((item, i) => {
          const shape = SHAPES[i % SHAPES.length]
          return (
            <div
              key={i}
              className={`shrink-0 ${shape.w} ${shape.radius} border border-[var(--color-border)] bg-[var(--color-nav)] overflow-hidden shadow-xl hover:shadow-[0_0_24px_-4px_rgba(212,255,0,0.15)] hover:border-[var(--color-lime)]/50 transition-all duration-300 group hover:-translate-y-1`}
              style={{ height: `${shape.h}px` }}
            >
              <div className="flex flex-col h-full justify-between p-4">
                <div>
                  <span className="text-[8px] font-mono uppercase tracking-widest px-2 py-1 rounded-full border border-[var(--color-raised)] text-[var(--color-muted-4)] bg-[var(--color-surface)]">
                    {item.platform}
                  </span>
                  <p className="text-[11px] font-semibold text-[var(--color-text)] mt-3 leading-tight">{item.hook}</p>
                  <p className="text-[9px] text-[var(--color-muted-3)] mt-1.5">{item.niche} · {item.dur}</p>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full border border-[var(--color-raised)] bg-[var(--color-surface)] flex items-center justify-center group-hover:border-[var(--color-lime)]/40 group-hover:bg-[var(--color-lime)]/10 transition-all">
                      <span className="text-[var(--color-muted-5)] text-[9px] group-hover:text-[var(--color-lime)] transition-colors">▶</span>
                    </div>
                    <span className="text-[8px] font-mono text-[var(--color-muted-4)]">{item.dur}</span>
                  </div>
                  <span className="text-[11px] font-black text-[var(--color-lime)] drop-shadow-[0_0_6px_rgba(212,255,0,0.3)]">{item.score}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
