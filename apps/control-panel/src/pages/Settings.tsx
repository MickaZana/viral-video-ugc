import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'

type Theme = 'dark' | 'light'

export function Settings({
  theme,
  onTheme,
  email
}: {
  theme: Theme
  onTheme: (t: Theme) => void
  email: string
}) {
  return (
    <div className="space-y-6 max-w-lg">
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Account</h2>
        <p className="text-sm text-[var(--color-muted-2)]">{email}</p>
      </section>

      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Theme</h2>
        <div className="flex gap-2">
          {(['dark', 'light'] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => onTheme(t)}
              className="px-4 py-2 text-[11px] uppercase tracking-widest border"
              style={{
                color: theme === t ? 'var(--color-on-accent)' : 'var(--color-muted-2)',
                backgroundColor: theme === t ? 'var(--color-lime)' : 'transparent',
                borderColor: theme === t ? 'var(--color-lime)' : 'var(--color-raised)'
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <ChangePasswordForm />

      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest">MFA</h2>
        <p className="text-[11px] text-[var(--color-muted-3)]">
          Two-factor is available at sign-in. Enrollment stays on the account API.
        </p>
      </section>

      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Sessions</h2>
        <p className="text-[11px] text-[var(--color-muted-3)]">
          Changing your password revokes other sessions.
        </p>
      </section>
    </div>
  )
}

function ChangePasswordForm() {
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

  const input =
    'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors'

  if (done) {
    return (
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="text-sm text-[var(--color-lime)]">
          Password changed. Other sessions were revoked — sign in again if needed.
        </p>
      </section>
    )
  }

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest mb-4">Password</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-[var(--color-muted)] mb-1" htmlFor="currentPassword">
            Current password
          </label>
          <input id="currentPassword" name="currentPassword" type="password" className={input} autoComplete="current-password" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-[var(--color-muted)] mb-1" htmlFor="newPassword">
            New password (8+ chars)
          </label>
          <input id="newPassword" name="newPassword" type="password" className={input} autoComplete="new-password" />
        </div>
        {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2.5 text-sm font-semibold uppercase tracking-widest disabled:opacity-50"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}