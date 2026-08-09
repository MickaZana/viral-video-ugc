import { useEffect, useState } from 'react'
import { Dashboard } from './tabs/Dashboard'
import { Spy } from './tabs/Spy'
import { Rewriter } from './tabs/Rewriter'
import { History } from './tabs/History'
import { setPreviewMode } from './lib/api'
import { HeroFlow } from './components/HeroFlow'
import { Logo } from './components/Logo'

// Set preview routing BEFORE this module's components ever render. See the note
// in Landing() below about why this must not live in a useEffect.
setPreviewMode(true)

type PreviewTab = 'dashboard' | 'spy' | 'rewriter' | 'history'

const PREVIEW_NAV: { id: PreviewTab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'DASHBOARD', icon: '◉' },
  { id: 'spy', label: 'CREATOR SPY', icon: '◈' },
  { id: 'rewriter', label: 'SCRIPT REWRITER', icon: '⌥' },
  { id: 'history', label: 'HISTORY', icon: '▤' }
]

const FEATURES = [
  {
    icon: '◈',
    title: 'Creator Spy',
    desc: 'Enter any Instagram, TikTok, or YouTube account. We track it and alert you the moment one of its videos starts going viral.'
  },
  {
    icon: '⌥',
    title: 'Script Rewriter',
    desc: 'Remix any viral video to fit your niche while keeping the exact format that made it take off — hooks, pacing, and call-to-action intact.'
  },
  {
    icon: '▤',
    title: 'History',
    desc: 'Every video, script, and workflow run you have made — organised into one clean hub so you always know what worked.'
  },
  {
    icon: '◉',
    title: 'Real-time Dashboard',
    desc: 'A live command center showing discovery runs, viral scores, and pipeline health across every platform at a glance.'
  }
]

const STEPS = [
  { n: '01', title: 'Spy', desc: 'Point us at a creator. We watch their feed and catch the exact moment a video begins to break out.' },
  { n: '02', title: 'Rewrite', desc: 'AI regenerates the script in your voice and niche — same viral structure, zero effort.' },
  { n: '03', title: 'Remake', desc: 'Your recreated version, scored against the original, ready to ship to your audience.' }
]

export function Landing({
  onGetStarted,
  onSignIn,
  authenticated = false,
  onWorkspace
}: {
  onGetStarted: () => void
  onSignIn: () => void
  /** True when an already-signed-in user is browsing the marketing page. */
  authenticated?: boolean
  /** When authenticated, this replaces Get Started/Sign In with a return-to-workspace action. */
  onWorkspace?: () => void
}) {
  const [preview, setPreview] = useState<PreviewTab>('dashboard')

  const goHome = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  // The preview frame renders the real tabs, which read via api.* — but a guest
  // has no session, so the tabs' data routes would 401. Route them to the public
  // /preview/* endpoints for the lifetime of the landing page, then restore
  // normal routing when the guest signs in / the page unmounts.
  //
  // NOTE: this must NOT be done in a useEffect. React runs child effects before
  // parent effects, so the tabs (Dashboard/Spy/...) mounted by this component
  // fire their first data requests before a here-inline effect could run — they'd
  // hit the auth-gated routes and 401. Setting it synchronously at module scope
  // guarantees preview routing is active before any tab ever mounts.
  useEffect(() => {
    return () => setPreviewMode(false)
  }, [])

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-raised)] bg-[var(--color-bg)]/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Logo onClick={goHome} />
          </div>
          <nav className="hidden md:flex items-center gap-6 text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-5)]">
            <a href="#features" className="hover:text-[var(--color-lime)] transition-colors">Features</a>
            <a href="#preview" className="hover:text-[var(--color-lime)] transition-colors">Preview</a>
            <a href="#how" className="hover:text-[var(--color-lime)] transition-colors">How it works</a>
          </nav>
          <div className="flex items-center gap-3">
            {authenticated ? (
              <button
                onClick={onWorkspace}
                className="text-[11px] font-mono font-bold uppercase tracking-widest px-4 py-2.5 transition-colors hover:brightness-110"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)', fontFamily: 'Barlow Condensed' }}
              >
                ← Back to Workspace
              </button>
            ) : (
              <>
                <button
                  onClick={onSignIn}
                  className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-6)] hover:text-[var(--color-lime)] transition-colors px-3 py-2"
                >
                  Sign In
                </button>
                <button
                  onClick={onGetStarted}
                  className="text-[11px] font-mono font-bold uppercase tracking-widest px-4 py-2.5 transition-colors hover:brightness-110"
                  style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)', fontFamily: 'Barlow Condensed' }}
                >
                  Get Started
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-[var(--color-raised)]">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28 text-center">
          <div className="inline-flex items-center gap-2 border border-[var(--color-input)] bg-[var(--color-surface)] px-3 py-1.5 mb-8">
            <span className="w-1.5 h-1.5 bg-[var(--color-lime)] blink" />
            <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-4)]">
              AI-Powered Viral Engine
            </span>
          </div>
          <h1
            className="text-5xl md:text-7xl font-black uppercase leading-[0.95] tracking-tight"
            style={{ fontFamily: 'Barlow Condensed' }}
          >
            Spy The Format.
            <br />
            <span className="text-[var(--color-lime)]">Make It Yours.</span>
          </h1>
          <p className="mt-6 text-base md:text-lg font-mono text-[var(--color-muted-4)] max-w-2xl mx-auto">
            UGU watches viral creators, rewrites their winning scripts for your niche, and remakes the content — so you
            go viral without guessing.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onGetStarted}
              className="px-10 py-4 text-base font-black uppercase tracking-widest transition-colors hover:brightness-110 w-full sm:w-auto"
              style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)', fontFamily: 'Barlow Condensed' }}
            >
              Get Started Free
            </button>
            <a
              href="#preview"
              className="px-10 py-4 text-base font-mono uppercase tracking-widest border border-[var(--color-faint)] text-[var(--color-muted-6)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors w-full sm:w-auto"
            >
              See It Live
            </a>
          </div>

          {/* Self-playing screen-flow demo */}
          <div className="mt-16 max-w-4xl mx-auto text-left">
            <div className="flex items-center gap-2 justify-center mb-4">
              <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">Production flow</span>
              <span className="h-px flex-1 max-w-24 bg-[var(--color-input)]" />
              <span className="text-[10px] font-mono text-[var(--color-muted-2)]">auto-plays · pause on hover</span>
            </div>
            <HeroFlow />
          </div>
        </div>
      </section>

      {/* Live preview */}
      <section id="preview" className="border-b border-[var(--color-raised)]">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="flex items-end justify-between mb-8">
            <div>
              <p className="text-[11px] font-mono text-[var(--color-lime)] uppercase tracking-widest mb-2">Live Preview</p>
              <h2 className="text-3xl md:text-4xl font-black uppercase" style={{ fontFamily: 'Barlow Condensed' }}>
                Click around the real app
              </h2>
            </div>
            <span className="hidden md:inline-flex items-center gap-2 text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">
              <span className="w-1.5 h-1.5 bg-[var(--color-lime)] pulse-lime" /> Live interface
            </span>
          </div>

          {/* app frame */}
          <div className="border border-[var(--color-border)] bg-[var(--color-nav)] overflow-hidden">
            {/* fake app top bar */}
            <div className="border-b border-[var(--color-raised)] px-4 py-2.5 flex items-center justify-between bg-[var(--color-nav)]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[var(--color-red)]" />
                <span className="w-2 h-2 bg-[var(--color-orange)]" />
                <span className="w-2 h-2 bg-[var(--color-lime)]" />
                <span className="ml-3 text-[10px] font-mono text-[var(--color-muted-3)]">ugu-program — control</span>
              </div>
              <span className="text-[10px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">Preview Mode</span>
            </div>
            {/* fake app nav + content */}
            <div className="flex">
              <div className="w-14 sm:w-48 border-r border-[var(--color-raised)] bg-[var(--color-nav)] shrink-0">
                <div className="py-3">
                  {PREVIEW_NAV.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setPreview(n.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                      style={{
                        backgroundColor: preview === n.id ? 'var(--color-surface)' : 'transparent',
                        borderLeft: preview === n.id ? '2px solid var(--color-lime)' : '2px solid transparent'
                      }}
                    >
                      <span className="text-sm" style={{ color: preview === n.id ? 'var(--color-lime)' : 'var(--color-muted-3)' }}>
                        {n.icon}
                      </span>
                      <span className="text-[11px] font-mono uppercase tracking-widest hidden sm:block" style={{ color: preview === n.id ? 'var(--color-lime)' : 'var(--color-muted-2)' }}>
                        {n.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="p-4 sm:p-6 bg-[var(--color-bg)]">
                  <div className="mb-4">
                    <h3 className="text-2xl font-black uppercase" style={{ fontFamily: 'Barlow Condensed' }}>
                      {PREVIEW_NAV.find((n) => n.id === preview)?.label}
                    </h3>
                  </div>
                  {preview === 'dashboard' && <Dashboard />}
                  {preview === 'spy' && <Spy />}
                  {preview === 'rewriter' && <Rewriter />}
                  {preview === 'history' && <History />}
                </div>
              </div>
            </div>
          </div>

          <p className="mt-4 text-[11px] font-mono text-[var(--color-muted-2)] text-center">
            This is the real interface, powered by live data. Sign in to load your workspace.
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-b border-[var(--color-raised)]">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <p className="text-[11px] font-mono text-[var(--color-lime)] uppercase tracking-widest mb-2">Capabilities</p>
          <h2 className="text-3xl md:text-4xl font-black uppercase mb-10" style={{ fontFamily: 'Barlow Condensed' }}>
            Everything you need to go viral
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 hover:border-[var(--color-lime)]/40 transition-colors">
                <span className="text-2xl text-[var(--color-lime)]">{f.icon}</span>
                <h3 className="text-xl font-black uppercase mt-3 mb-2" style={{ fontFamily: 'Barlow Condensed' }}>
                  {f.title}
                </h3>
                <p className="text-sm font-mono text-[var(--color-muted-4)] leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-b border-[var(--color-raised)]">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <p className="text-[11px] font-mono text-[var(--color-lime)] uppercase tracking-widest mb-2">How it works</p>
          <h2 className="text-3xl md:text-4xl font-black uppercase mb-10" style={{ fontFamily: 'Barlow Condensed' }}>
            Spy. Rewrite. Remake.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {STEPS.map((s) => (
              <div key={s.n} className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
                <span className="text-4xl font-black text-[var(--color-lime)]" style={{ fontFamily: 'Barlow Condensed' }}>
                  {s.n}
                </span>
                <h3 className="text-xl font-black uppercase mt-3 mb-2" style={{ fontFamily: 'Barlow Condensed' }}>
                  {s.title}
                </h3>
                <p className="text-sm font-mono text-[var(--color-muted-4)] leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b border-[var(--color-raised)]">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-4xl md:text-6xl font-black uppercase leading-tight" style={{ fontFamily: 'Barlow Condensed' }}>
            Ready to go viral?
          </h2>
          <p className="mt-4 text-base font-mono text-[var(--color-muted-4)]">
            Start remaking winning content in minutes. No guesswork.
          </p>
          <button
            onClick={onGetStarted}
            className="mt-8 px-12 py-4 text-lg font-black uppercase tracking-widest transition-colors hover:brightness-110"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)', fontFamily: 'Barlow Condensed' }}
          >
            Get Started Free
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Logo onClick={goHome} size={26} wordmarkClass="text-sm" />
        </div>
        <div className="flex items-center gap-6 text-[11px] font-mono text-[var(--color-muted-2)]">
          <button onClick={onSignIn} className="hover:text-[var(--color-lime)] transition-colors">Sign In</button>
          <button onClick={onGetStarted} className="hover:text-[var(--color-lime)] transition-colors">Get Started</button>
        </div>
      </footer>
    </div>
  )
}
