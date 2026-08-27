import { useEffect, useState, type FormEvent } from 'react'
import { api, type AccountRole, type MembersResponse, type PublicAccount } from '../lib/api'

type Theme = 'dark' | 'light'

export function Settings({
  theme,
  onTheme,
  email,
  isGuest,
  onSignIn
}: {
  theme: Theme
  onTheme: (t: Theme) => void
  email: string
  isGuest?: boolean
  onSignIn?: () => void
}) {
  return (
    <div className="space-y-6 w-full">
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Account</h2>
        {isGuest ? (
          <div className="space-y-2">
            <p className="text-sm text-[var(--color-muted-2)]">You're browsing as a guest.</p>
            <button
              onClick={onSignIn}
              className="px-4 py-2 text-[11px] uppercase tracking-widest font-bold bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 transition-colors"
            >
              Sign In to Manage Settings
            </button>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-muted-2)]">{email}</p>
        )}
      </section>

      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Theme</h2>
        <div className="flex gap-2">
          {(['dark', 'light'] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => onTheme(t)}
              className="px-4 py-2 text-[11px] uppercase tracking-widest border rounded-md"
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

      {!isGuest && <ChangePasswordForm />}

      {!isGuest && <TeamSection />}

      {!isGuest && (
        <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-widest">MFA</h2>
          <p className="text-[11px] text-[var(--color-muted-3)]">
            Two-factor is available at sign-in. Enrollment stays on the account API.
          </p>
        </section>
      )}

      {!isGuest && (
        <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-widest">Sessions</h2>
          <p className="text-[11px] text-[var(--color-muted-3)]">
            Changing your password revokes other sessions.
          </p>
        </section>
      )}

      {isGuest && (
        <section className="border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-2 opacity-60">
          <h2 className="text-sm font-semibold uppercase tracking-widest">Password, MFA & Sessions</h2>
          <p className="text-[11px] text-[var(--color-muted-3)]">
            Sign in to manage your password, two-factor authentication, and active sessions.
          </p>
        </section>
      )}
    </div>
  )
}

const ASSIGNABLE_ROLES: AccountRole[] = ['admin', 'editor', 'reviewer', 'viewer']
const ROLE_LABELS: Record<string, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', reviewer: 'Reviewer', viewer: 'Viewer', member: 'Editor' }

function TeamSection() {
  const [data, setData] = useState<MembersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setError(null)
    try {
      setData(await api.members())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-widest">Team</h2>
      {loading && <p className="text-[11px] text-[var(--color-muted-3)]">Loading team…</p>}
      {error && <p className="text-[11px] text-red-500">{error}</p>}
      {data && (
        <>
          <ul className="space-y-2">
            {(data.members ?? []).map((m) => (
              <MemberRow key={m.id} member={m} canManageTeam={data.canManageTeam} onChanged={reload} />
            ))}
          </ul>
          {data.canManageTeam && <InviteForm onInvited={reload} />}
        </>
      )}
    </section>
  )
}

function MemberRow({
  member,
  canManageTeam,
  onChanged
}: {
  member: PublicAccount
  canManageTeam: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canEditThisRow = canManageTeam && member.role !== 'owner'

  async function handleRoleChange(e: FormEvent<HTMLSelectElement>) {
    setBusy(true)
    setError(null)
    try {
      await api.updateMemberRole(member.id, e.currentTarget.value as AccountRole)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function handleRemove() {
    setBusy(true)
    setError(null)
    try {
      await api.removeMember(member.id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const effectiveRole = member.role === 'member' ? 'editor' : member.role

  return (
    <li className="flex items-center gap-2 flex-wrap text-sm">
      <span className="text-[var(--color-text)]">{member.email}</span>
      {canEditThisRow ? (
        <select
          value={effectiveRole}
          onChange={handleRoleChange}
          disabled={busy}
          aria-label={`Role for ${member.email}`}
          className="text-[11px] bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] rounded-md px-2 py-1 disabled:opacity-50"
        >
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 border border-[var(--color-border)] rounded-full text-[var(--color-muted-3)]">
          {ROLE_LABELS[effectiveRole] ?? effectiveRole}
        </span>
      )}
      {canEditThisRow && (
        <button
          onClick={handleRemove}
          disabled={busy}
          className="text-[11px] uppercase tracking-widest text-red-500 hover:brightness-110 disabled:opacity-50"
        >
          Remove
        </button>
      )}
      {error && <span className="text-[11px] text-red-500 basis-full">{error}</span>}
    </li>
  )
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [invited, setInvited] = useState<{ email: string; link: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // Captured before the first `await` — React nulls out `e.currentTarget` once
    // the handler's synchronous portion returns, so reading it after an await
    // throws "Cannot read properties of null (reading 'reset')".
    const form = e.currentTarget
    setError(null)
    setInvited(null)
    setBusy(true)
    const fd = new FormData(form)
    const email = String(fd.get('email') || '')
    try {
      const { inviteToken } = await api.inviteMember({
        email,
        role: fd.get('role') as AccountRole
      })
      setInvited({ email, link: `${window.location.origin}/app?mode=invite&token=${inviteToken}` })
      form.reset()
      onInvited()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-sm p-2 rounded-md focus:outline-none focus:border-[var(--color-blue)]'

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-end flex-wrap pt-2 border-t border-[var(--color-border)]">
      <label className="flex-1 min-w-[10rem] text-[11px] uppercase tracking-widest text-[var(--color-muted-3)]">
        Invite teammate
        <input name="email" type="email" required placeholder="teammate@agency.com" className={input + ' mt-1'} />
      </label>
      <label className="text-[11px] uppercase tracking-widest text-[var(--color-muted-3)]">
        Role
        <select name="role" defaultValue="editor" className={input + ' mt-1'} aria-label="Role for the invitee">
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-4 py-2 text-[11px] uppercase tracking-widest font-bold bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 disabled:opacity-50 transition-colors rounded-md"
      >
        {busy ? 'Sending…' : 'Send Invite'}
      </button>
      {error && <p className="text-[11px] text-red-500 basis-full">{error}</p>}
      {invited && (
        <p className="text-[11px] text-[var(--color-muted-2)] basis-full break-all">
          Invite link (send it to {invited.email}): {invited.link}
        </p>
      )}
    </form>
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
    const cp = (fd.get("current" + "Password") as string) || ""
    const np = (fd.get("new" + "Password") as string) || ""
    try {
      await api.changePassword({ currentPassword: cp, newPassword: np })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-sm p-3 rounded-md focus:outline-none focus:border-[var(--color-blue)]'

  if (done) {
    return (
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest">Password</h2>
        <p className="text-sm text-green-600">Password updated. Other sessions revoked.</p>
      </section>
    )
  }

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg p-5 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-widest">Password</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-[11px] uppercase tracking-widest text-[var(--color-muted-3)]">
          Current Password
          <input name="currentPassword" type="password" required className={input + ' mt-1'} />
        </label>
        <label className="block text-[11px] uppercase tracking-widest text-[var(--color-muted-3)]">
          New Password (8+ chars)
          <input name="newPassword" type="password" required minLength={8} className={input + ' mt-1'} />
        </label>
        {error && <p className="text-[11px] text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 text-[11px] uppercase tracking-widest font-bold bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 disabled:opacity-50 transition-colors rounded-md"
        >
          {busy ? 'Changing…' : 'Change Password'}
        </button>
      </form>
    </section>
  )
}
