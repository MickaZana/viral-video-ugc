import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { PublicAccount } from '../lib/auth'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Logo } from '../components/Logo'
import { NavIcon } from '../components/NavIcon'
import { Onboarding, useOnboarding } from '../components/Onboarding'
import { GlobalExportButton } from '../components/GlobalExportButton'
import { LegalModals, type LegalModalType } from '../components/LegalModals'
import { paths, tabPath } from '../lib/paths'

const PRIMARY: { to: string; label: string; icon: Parameters<typeof NavIcon>[0]['name']; end?: boolean; badge?: boolean }[] = [
  { to: paths.home, label: 'This Week', icon: 'week', end: true },
  { to: paths.intel, label: 'Intel', icon: 'intel' },
  { to: paths.studio, label: 'Studio', icon: 'studio' },
  { to: paths.review, label: 'Review', icon: 'review', badge: true },
  { to: paths.library, label: 'Library', icon: 'library' }
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
  if (pathname.startsWith('/studio/batch')) return { title: 'Studio', sub: 'Batch variation generator' }
  if (pathname.startsWith('/studio')) return { title: 'Studio', sub: 'Start a run' }
  if (pathname.startsWith('/review/')) return { title: 'Review', sub: 'Approve or reject' }
  if (pathname.startsWith('/review')) return { title: 'Review', sub: 'Approve, reject, or publish' }
  if (pathname.startsWith('/library/')) return { title: 'Library', sub: 'Source detail' }
  if (pathname.startsWith('/library')) return { title: 'Library', sub: 'Crawled videos & past productions' }
  if (pathname.startsWith('/brand/clients')) return { title: 'Brand', sub: 'Client' }
  if (pathname.startsWith('/brand')) return { title: 'Brand', sub: 'Kit and clients' }
  if (pathname.startsWith('/billing')) return { title: 'Billing', sub: 'Plan and usage' }
  if (pathname.startsWith('/settings')) return { title: 'Settings', sub: 'Password, MFA, theme' }
  return { title: 'This Week', sub: 'Cadence, quota, next action' }
}

export function WorkspaceLayout({
  account,
  isGuest,
  onLogout,
  onSignIn
}: {
  account: PublicAccount
  isGuest?: boolean
  onLogout: () => void
  onSignIn?: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [legalModal, setLegalModal] = useState<LegalModalType>(null)
  const { showOnboarding, completeOnboarding } = useOnboarding()
  const queue = useApi(() => api.queue())
  const runs = useApi(() => api.runs())
  const pending = (queue.data ?? []).filter((i) => i.status === 'pending').length
  const heading = titleFor(location.pathname)

  function navClass(active: boolean) {
    return {
      backgroundColor: active ? 'var(--color-raised)' : 'transparent',
      borderLeft: active ? '2px solid var(--color-lime)' : '2px solid transparent',
      color: active ? 'var(--color-text)' : 'var(--color-muted-2)'
    }
  }

  return (
    <div className="workspace-shell">
      <header className="workspace-header border-b border-[var(--color-raised)] flex items-center justify-between shrink-0 bg-[var(--color-surface)]">
        <Logo onClick={() => navigate(paths.home)} />
        <div className="flex items-center gap-3 lg:gap-5">
          {isGuest ? (
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 border border-[var(--color-lime)] text-[var(--color-lime)]">
                Demo Workspace
              </span>
              <button
                onClick={onSignIn}
                className="px-3 py-1 text-[11px] font-bold uppercase tracking-widest bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 transition-colors"
              >
                Sign In
              </button>
            </div>
          ) : (
            <>
              <GlobalExportButton items={queue.data ?? []} runs={runs.data ?? []} />
              <span className="header-email text-[11px] text-[var(--color-muted-2)] font-mono">{account.email}</span>
              <button
                onClick={onLogout}
                className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-red)] transition-colors"
              >
                Sign Out
              </button>
            </>
          )}
        </div>
      </header>

      <div className="workspace-body">
        <nav className="workspace-nav">
          <div className="flex-1 py-4">
            {PRIMARY.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors font-mono"
                style={({ isActive }) => navClass(isActive)}
              >
                {({ isActive }) => (
                  <>
                    <span className="shrink-0" style={{ color: isActive ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                      <NavIcon name={n.icon} />
                    </span>
                    <span className="nav-label text-[12px] uppercase tracking-widest">{n.label}</span>
                    {n.badge && pending > 0 && (
                      <span className="nav-badge ml-auto items-center justify-center min-w-[1.25rem] h-5 px-1 text-[10px] font-mono bg-[var(--color-lime)] text-[var(--color-on-accent)]">
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
                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors font-mono"
                style={({ isActive }) => navClass(isActive)}
              >
                {({ isActive }) => (
                  <>
                    <span className="shrink-0" style={{ color: isActive ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                      <NavIcon name={n.icon} />
                    </span>
                    <span className="nav-label text-[12px] uppercase tracking-widest">{n.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="workspace-content">
          <main className="workspace-main">
            <div className="mb-4 lg:mb-6">
              <h1 className="text-xl lg:text-2xl font-semibold tracking-tight text-[var(--color-text)]">{heading.title}</h1>
              <p className="text-[12px] text-[var(--color-muted-3)] mt-1">{heading.sub}</p>
            </div>
            <Outlet />
          </main>

          {/* Legal and Compliance Footer */}
          <footer className="workspace-footer border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 lg:px-6 py-4 mt-auto flex items-center justify-between gap-3 text-[10px] font-mono text-[var(--color-muted-2)]">
            <span>© 2026 VUGC. A Micany Company product. All rights reserved.</span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={() => setLegalModal('privacy')}
                className="hover:text-[var(--color-lime)] transition-colors cursor-pointer"
              >
                Privacy Policy
              </button>
              <button
                onClick={() => setLegalModal('terms')}
                className="hover:text-[var(--color-lime)] transition-colors cursor-pointer"
              >
                Terms of Service
              </button>
              <button
                onClick={() => setLegalModal('dsr_gdpr')}
                className="hover:text-[var(--color-lime)] text-[var(--color-lime)] font-bold transition-colors cursor-pointer"
              >
                GDPR &amp; DSR Rights
              </button>
              <button
                onClick={() => setLegalModal('about')}
                className="hover:text-[var(--color-lime)] transition-colors cursor-pointer"
              >
                About Us
              </button>
              <button
                onClick={() => setLegalModal('sitemap')}
                className="hover:text-[var(--color-lime)] transition-colors cursor-pointer"
              >
                Site Map
              </button>
            </div>
          </footer>
        </div>
      </div>

      <LegalModals activeModal={legalModal} onClose={() => setLegalModal(null)} />

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
