import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { PublicAccount } from '../lib/auth'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Logo } from '../components/Logo'
import { NavIcon } from '../components/NavIcon'
import { Onboarding, useOnboarding } from '../components/Onboarding'
import { paths, tabPath } from '../lib/paths'

const PRIMARY: { to: string; label: string; icon: Parameters<typeof NavIcon>[0]['name']; end?: boolean; badge?: boolean }[] = [
  { to: paths.home, label: 'This Week', icon: 'week', end: true },
  { to: paths.intel, label: 'Intel', icon: 'intel' },
  { to: paths.studio, label: 'Studio', icon: 'studio' },
  { to: paths.library, label: 'Library', icon: 'library' },
  { to: paths.review, label: 'Review', icon: 'review', badge: true }
]

const SECONDARY: { to: string; label: string; icon: Parameters<typeof NavIcon>[0]['name'] }[] = [
  { to: paths.brand, label: 'Brand', icon: 'brand' },
  { to: paths.billing, label: 'Billing', icon: 'billing' },
  { to: paths.settings, label: 'Settings', icon: 'settings' }
]

function titleFor(pathname: string): { title: string; sub: string } {
  if (pathname.startsWith('/intel/remix')) return { title: 'Intel', sub: 'Paste a URL to remix' }
  if (pathname.startsWith('/intel/')) return { title: 'Intel', sub: 'Source detail' }
  if (pathname.startsWith('/intel')) return { title: 'Intel', sub: 'Viral inbox' }
  if (pathname.startsWith('/studio/script')) return { title: 'Studio', sub: 'Hook / Point / CTA' }
  if (pathname.startsWith('/studio/runs')) return { title: 'Studio', sub: 'Live nine-stage run' }
  if (pathname.startsWith('/studio')) return { title: 'Studio', sub: 'Start a run' }
  if (pathname.startsWith('/library/')) return { title: 'Library', sub: 'Master' }
  if (pathname.startsWith('/library')) return { title: 'Library', sub: '9:16 masters' }
  if (pathname.startsWith('/review/')) return { title: 'Review', sub: 'Approve or reject' }
  if (pathname.startsWith('/review')) return { title: 'Review', sub: 'HITL queue' }
  if (pathname.startsWith('/brand/clients')) return { title: 'Brand', sub: 'Client' }
  if (pathname.startsWith('/brand')) return { title: 'Brand', sub: 'Kit and clients' }
  if (pathname.startsWith('/billing')) return { title: 'Billing', sub: 'Plan and usage' }
  if (pathname.startsWith('/settings')) return { title: 'Settings', sub: 'Password, MFA, theme' }
  return { title: 'This Week', sub: 'Cadence, quota, next action' }
}

export function WorkspaceLayout({
  account,
  onLogout
}: {
  account: PublicAccount
  onLogout: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { showOnboarding, completeOnboarding } = useOnboarding()
  const queue = useApi(() => api.queue())
  const pending = (queue.data ?? []).filter((i) => i.status === 'pending').length
  const heading = titleFor(location.pathname)

  function navClass(active: boolean) {
    return {
      backgroundColor: active ? 'var(--color-surface)' : 'transparent',
      borderLeft: active ? '2px solid var(--color-lime)' : '2px solid transparent',
      color: active ? 'var(--color-text)' : 'var(--color-muted-2)'
    }
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex flex-col">
      <header className="border-b border-[var(--color-raised)] px-6 py-3 flex items-center justify-between shrink-0">
        <Logo onClick={() => navigate(paths.home)} />
        <div className="flex items-center gap-5">
          <span className="text-[11px] text-[var(--color-muted-2)] hidden lg:block">{account.email}</span>
          <button
            onClick={onLogout}
            className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-red)] transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-14 sm:w-52 border-r border-[var(--color-raised)] bg-[var(--color-nav)] flex flex-col shrink-0">
          <div className="flex-1 py-4">
            {PRIMARY.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                style={({ isActive }) => navClass(isActive)}
              >
                {({ isActive }) => (
                  <>
                    <span style={{ color: isActive ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                      <NavIcon name={n.icon} />
                    </span>
                    <span className="text-[12px] uppercase tracking-widest hidden sm:block">{n.label}</span>
                    {n.badge && pending > 0 && (
                      <span className="ml-auto hidden sm:inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-[10px] font-mono bg-[var(--color-lime)] text-[var(--color-on-accent)]">
                        {pending}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
            <div className="my-3 mx-4 border-t border-[var(--color-raised)]" />
            {SECONDARY.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                style={({ isActive }) => navClass(isActive)}
              >
                {({ isActive }) => (
                  <>
                    <span style={{ color: isActive ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                      <NavIcon name={n.icon} />
                    </span>
                    <span className="text-[12px] hidden sm:block">{n.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>

        <main className="flex-1 overflow-y-auto p-6 scrollbar-hidden">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">{heading.title}</h1>
            <p className="text-[12px] text-[var(--color-muted-3)] mt-1">{heading.sub}</p>
          </div>
          <Outlet />
        </main>
      </div>

      {showOnboarding && (
        <Onboarding
          onComplete={completeOnboarding}
          onNavigate={(tab) => {
            navigate(tabPath[tab] ?? paths.home)
            completeOnboarding()
          }}
          onStart={(runId) => {
            completeOnboarding()
            navigate(paths.studioRun(runId))
          }}
        />
      )}
    </div>
  )
}