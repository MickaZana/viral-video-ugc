import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { PublicAccount } from '../lib/auth'
import type { AppMode, BillingResponse } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Logo } from '../components/Logo'
import { NavIcon } from '../components/NavIcon'
import { Onboarding, useOnboarding } from '../components/Onboarding'
import { GlobalExportButton } from '../components/GlobalExportButton'
import { LegalModals, type LegalModalType } from '../components/LegalModals'
import { paths, tabPath } from '../lib/paths'

type Theme = 'dark' | 'light'

/** Minimal line-icon sun/moon, matching NavIcon.tsx's stroke-based style —
 *  kept local rather than added to NavIcon since it represents a toggle
 *  state, not a fixed nav destination. */
function ThemeIcon({ theme }: { theme: Theme }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (theme === 'dark') {
    // Sun — shown when dark is active, inviting a switch to light.
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
      </svg>
    )
  }
  // Moon — shown when light is active, inviting a switch to dark.
  return (
    <svg {...common}>
      <path d="M13 8.8A5.2 5.2 0 1 1 7.2 3a4.2 4.2 0 0 0 5.8 5.8z" />
    </svg>
  )
}

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
  { to: paths.curriculum, label: 'Curriculum', icon: 'curriculum' },
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
  if (pathname.startsWith('/curriculum')) return { title: 'Curriculum', sub: 'Structured courses, lessons & projects' }
  if (pathname.startsWith('/settings')) return { title: 'Settings', sub: 'Password, MFA, theme' }
  return { title: 'This Week', sub: 'Cadence, quota, next action' }
}

export function WorkspaceLayout({
  account,
  isGuest,
  onLogout,
  onSignIn,
  theme,
  onTheme,
  appMode,
  onToggleMode,
  modeBusy,
  modeError
}: {
  account: PublicAccount
  isGuest?: boolean
  onLogout: () => void
  onSignIn?: () => void
  theme: Theme
  onTheme: (t: Theme) => void
  appMode: AppMode
  onToggleMode: () => void
  modeBusy?: boolean
  modeError?: string | null
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [legalModal, setLegalModal] = useState<LegalModalType>(null)
  const { showOnboarding, completeOnboarding } = useOnboarding()
  const queue = useApi(() => api.queue())
  const runs = useApi(() => api.runs())
  // Guests share a fake demo account with no real billing state — skip the
  // call entirely rather than surface a 401/guest-plan placeholder.
  const billing = useApi<BillingResponse>(() => (isGuest ? Promise.resolve(null as unknown as BillingResponse) : api.billing()))
  const pending = (queue.data ?? []).filter((i) => i.status === 'pending').length
  const heading = titleFor(location.pathname)

  function navClass(active: boolean) {
    return {
      backgroundColor: active ? 'var(--color-raised)' : 'transparent',
      borderLeft: active ? '2px solid var(--color-blue)' : '2px solid transparent',
      color: active ? 'var(--color-text)' : 'var(--color-muted-2)'
    }
  }

  return (
    <div className="workspace-shell">
      <header className="workspace-header border-b border-[var(--color-raised)] flex items-center justify-between shrink-0 bg-[var(--color-surface)]">
        <Logo onClick={() => navigate(paths.home)} />
        <div className="flex items-center gap-3 lg:gap-5">
          <button
            onClick={onToggleMode}
            disabled={modeBusy}
            aria-label={appMode === 'curriculum' ? 'Switch to Standard Mode' : 'Switch to Curriculum Mode'}
            title={appMode === 'curriculum' ? 'Switch to Standard Mode' : 'Switch to Curriculum Mode'}
            className={`shrink-0 text-[10px] font-mono uppercase tracking-widest border px-2.5 py-1 transition-colors disabled:opacity-50 ${
              appMode === 'curriculum'
                ? ''
                : 'bg-transparent text-[var(--color-muted-2)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-muted-3)]'
            }`}
            style={
              appMode === 'curriculum'
                ? { backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)', borderColor: 'var(--color-lime)' }
                : undefined
            }
          >
            {modeBusy ? 'MODE…' : appMode === 'curriculum' ? '▦ CURRICULUM' : '▦ STANDARD'}
          </button>
          <button
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light background' : 'Switch to dark background'}
            title={theme === 'dark' ? 'Switch to light background' : 'Switch to dark background'}
            className="shrink-0 w-8 h-8 flex items-center justify-center border border-[var(--color-border)] text-[var(--color-muted-2)] hover:text-[var(--color-text)] hover:border-[var(--color-muted-3)] transition-colors"
          >
            <ThemeIcon theme={theme} />
          </button>
          {!isGuest && typeof billing.data?.runsUsedThisMonth === 'number' && (
            <button
              onClick={() => navigate(paths.billing)}
              title="Runs used this month — open Billing"
              className="shrink-0 hidden sm:flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono border border-[var(--color-border)] text-[var(--color-muted-2)] hover:text-[var(--color-text)] hover:border-[var(--color-muted-3)] transition-colors"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    billing.data.monthlyRunLimit && billing.data.runsUsedThisMonth >= billing.data.monthlyRunLimit
                      ? 'var(--color-orange)'
                      : 'var(--color-lime)'
                }}
              />
              {billing.data.runsUsedThisMonth}
              {billing.data.monthlyRunLimit ? ` / ${billing.data.monthlyRunLimit}` : ''} runs
            </button>
          )}
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
                    <span className="shrink-0" style={{ color: isActive ? 'var(--color-blue)' : 'var(--color-muted-3)' }}>
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
                    <span className="shrink-0" style={{ color: isActive ? 'var(--color-blue)' : 'var(--color-muted-3)' }}>
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
            {modeError && (
              <div className="mb-4 border border-[var(--color-red)] px-4 py-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-red)]">
                  Curriculum mode could not be updated: {modeError}
                </p>
              </div>
            )}
            <Outlet />
          </main>

          {/* Legal and Compliance Footer */}
          <footer className="workspace-footer border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 lg:px-6 py-4 mt-auto flex items-center justify-between gap-3 text-[10px] font-mono text-[var(--color-muted-2)]">
            <span>© 2026 VUGC. A Micany Company product. All rights reserved.</span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={() => setLegalModal('privacy')}
                className="hover:text-[var(--color-blue)] transition-colors cursor-pointer"
              >
                Privacy Policy
              </button>
              <button
                onClick={() => setLegalModal('terms')}
                className="hover:text-[var(--color-blue)] transition-colors cursor-pointer"
              >
                Terms of Service
              </button>
              <button
                onClick={() => setLegalModal('dsr_gdpr')}
                className="hover:text-[var(--color-blue)] text-[var(--color-blue)] font-bold transition-colors cursor-pointer"
              >
                GDPR &amp; DSR Rights
              </button>
              <button
                onClick={() => setLegalModal('about')}
                className="hover:text-[var(--color-blue)] transition-colors cursor-pointer"
              >
                About Us
              </button>
              <button
                onClick={() => setLegalModal('sitemap')}
                className="hover:text-[var(--color-blue)] transition-colors cursor-pointer"
              >
                Site Map
              </button>
            </div>
          </footer>
        </div>
      </div>

      <LegalModals activeModal={legalModal} onClose={() => setLegalModal(null)} />

      {/* !isGuest: showOnboarding is purely localStorage-gated (Onboarding.tsx),
          with no account check of its own — without this, a brand-new
          anonymous visitor's first interaction with the marketing landing
          page (also rendered inside this same layout) was a full-screen "set
          up your workspace" modal walking through a pipeline they don't have
          an account for yet, and offering to start a real run via a
          session-gated API call that would just 401 for them. */}
      {showOnboarding && !isGuest && (
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
