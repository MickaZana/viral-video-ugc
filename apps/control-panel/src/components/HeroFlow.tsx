import { useEffect, useRef, useState } from 'react'

/**
 * Self-playing screen-flow demo for the landing hero. It walks a first-time
 * visitor through the production remix-from-URL flow one stage at a time
 * (paste source → fetch transcript → adapt script → generate video → review),
 * advancing automatically and looping. This is a live animated mock of the real
 * interface — not a recorded file — so it stays crisp at any size and never
 * goes stale as the product changes.
 */

const STEPS = [
  {
    key: 'paste',
    label: 'PASTE SOURCE',
    title: 'Paste a viral video link',
    caption: 'Drop in any TikTok, YouTube, or Instagram (Reels) URL — the format you want to copy.'
  },
  {
    key: 'fetch',
    label: 'FETCH TRANSCRIPT',
    title: 'We pull its transcript',
    caption: 'Captions (or ASR) are resolved from the source so we know exactly what made it work.'
  },
  {
    key: 'adapt',
    label: 'ADAPT SCRIPT',
    title: 'Rewrite for your niche',
    caption: 'AI keeps the winning structure and rewrites the hook, points & CTA in your brand voice.'
  },
  {
    key: 'generate',
    label: 'GENERATE VIDEO',
    title: 'Render the remake',
    caption: 'One clip per script segment, then assembly, captions, and optional voiceover.'
  },
  {
    key: 'review',
    label: 'QUEUED FOR REVIEW',
    title: 'Scored & ready to ship',
    caption: 'A viral score is attached and it lands in your review queue for a human approve / reject.'
  }
]

const URL_TEXT = 'https://www.tiktok.com/@fitcoach/video/7123456789012345678'

export function HeroFlow() {
  const [step, setStep] = useState(0)
  const [elapsed, setElapsed] = useState(0) // 0..1 progress within the current step
  const [paused, setPaused] = useState(false)
  const raf = useRef<number | null>(null)
  const last = useRef<number>(Date.now())

  const STEP_MS = 2400

  useEffect(() => {
    last.current = Date.now()
    const tick = () => {
      if (!paused) {
        setElapsed((e) => {
          const next = e + (Date.now() - last.current) / STEP_MS
          last.current = Date.now()
          if (next >= 1) {
            setStep((s) => (s + 1) % STEPS.length)
            return 0
          }
          return next
        })
      } else {
        last.current = Date.now()
      }
      raf.current = window.requestAnimationFrame(tick)
    }
    raf.current = window.requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current!)
  }, [paused])

  const s = STEPS[step]
  const pct = Math.round(elapsed * 100)
  // A sub-progress for staggered content reveals inside a stage (0..1).
  const sub = Math.min(1, elapsed * 1.6)

  return (
    <div
      className="border border-[var(--color-border)] bg-[var(--color-nav)] overflow-hidden text-left"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* window top bar */}
      <div className="border-b border-[var(--color-raised)] px-4 py-2.5 flex items-center justify-between bg-[var(--color-nav)]">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-red)]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-orange)]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-lime)]" />
          <span className="ml-3 text-[10px] font-mono text-[var(--color-muted-3)]">ugu-program — remix flow</span>
        </div>
        <span className="flex items-center gap-2 text-[10px] font-mono text-[var(--color-red)] uppercase tracking-widest">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-red)] rec-pulse" />
          {paused ? 'Paused' : 'REC · auto-play'}
        </span>
      </div>

      {/* stage tabs */}
      <div className="grid grid-cols-5 border-b border-[var(--color-raised)]">
        {STEPS.map((st, i) => (
          <div
            key={st.key}
            className="px-2 py-2.5 text-center transition-colors"
            style={{
              backgroundColor: i === step ? 'var(--color-surface)' : 'transparent',
              borderBottom: i === step ? '2px solid var(--color-lime)' : '2px solid transparent',
              color: i === step ? 'var(--color-lime)' : 'var(--color-muted-2)'
            }}
          >
            <div className="text-[9px] sm:text-[10px] font-mono uppercase tracking-widest truncate">{st.label}</div>
          </div>
        ))}
      </div>

      {/* stage body */}
      <div className="relative min-h-[300px] md:min-h-[330px] flex flex-col">
        {/* scanning sweep overlay on fetch stage */}
        {s.key === 'fetch' && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className="absolute inset-x-0 h-10 bg-gradient-to-b from-transparent via-[var(--color-lime)]/10 to-transparent scan-sweep"
            />
          </div>
        )}

        <div key={s.key} className="flow-in flex-1 flex flex-col p-5 md:p-6">
          {s.key === 'paste' && (
            <div className="flex-1 flex flex-col justify-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">Source video URL</span>
                <span className="text-[10px] font-mono text-[var(--color-muted-2)]">↳ format to copy</span>
              </div>
              <div className="relative">
                <input
                  readOnly
                  aria-label="Source video URL"
                  value={sub < 0.5 ? URL_TEXT.slice(0, Math.floor((sub / 0.5) * URL_TEXT.length)) : URL_TEXT}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-lime)] font-mono text-xs sm:text-sm p-3 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-4 bg-[var(--color-lime)] blink" />
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="px-5 py-2.5 font-black uppercase tracking-widest text-xs"
                  style={{ fontFamily: 'Barlow Condensed', backgroundColor: sub > 0.5 ? 'var(--color-lime)' : 'var(--color-faint)', color: sub > 0.5 ? 'var(--color-on-accent)' : 'var(--color-muted-5)' }}
                >
                  Preview Remix
                </span>
                <span className="text-[10px] font-mono text-[var(--color-muted-2)]">one cheap LLM call · no video spend</span>
              </div>
            </div>
          )}

          {s.key === 'fetch' && (
            <div className="flex-1 flex flex-col justify-center gap-4">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-[var(--color-lime)] pulse-lime" />
                <span className="text-[11px] font-mono text-[var(--color-lime)] uppercase tracking-widest">Resolving transcript…</span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <span className="text-[var(--color-muted)]">source: youtube_shorts / dQw4w9WgXcQ</span>
                  <span className="text-[var(--color-lime)]">{pct}%</span>
                </div>
                <div className="h-2 bg-[var(--color-raised)] overflow-hidden">
                  <div className="h-full bg-[var(--color-lime)]" style={{ width: `${pct}%`, animation: 'none' }} />
                </div>
              </div>
              <div className="text-[10px] font-mono text-[var(--color-muted-2)] leading-relaxed">
                {sub > 0.5
                  ? '✓ Captions found — “Wait for this. The old way of onboarding is broken…”'
                  : 'Fetching auto-captions, falling back to ASR if needed…'}
              </div>
            </div>
          )}

          {s.key === 'adapt' && (
            <div className="flex-1 flex flex-col justify-center gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">Adapted for fitness</span>
                <span className="text-[10px] font-mono text-[var(--color-lime)]">✓ ready to review</span>
              </div>
              <div className="bg-[var(--color-bg)] border border-[var(--color-input)] p-3 space-y-1.5 font-mono text-xs">
                <div style={{ opacity: sub > 0.15 ? 1 : 0 }} className="transition-opacity text-[var(--color-lime)]">
                  Hook: Wait for this.
                </div>
                <div style={{ opacity: sub > 0.4 ? 1 : 0 }} className="transition-opacity text-[var(--color-text)]">
                  Point 1: The old warm-up routine is broken.
                </div>
                <div style={{ opacity: sub > 0.6 ? 1 : 0 }} className="transition-opacity text-[var(--color-text)]">
                  Point 2: You waste 20 minutes of gains every session.
                </div>
                <div style={{ opacity: sub > 0.8 ? 1 : 0 }} className="transition-opacity text-[var(--color-orange)]">
                  CTA: Follow for the fix.
                </div>
              </div>
            </div>
          )}

          {s.key === 'generate' && (
            <div className="flex-1 flex flex-col justify-center gap-4">
              <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((i) => {
                  const gate = [0.15, 0.4, 0.65][i]
                  const reveal = Math.max(0, Math.min(1, (sub - gate) / 0.3))
                  return (
                    <div key={i} className="relative border border-[var(--color-raised)] bg-[var(--color-surface)] h-20 overflow-hidden" style={{ opacity: reveal > 0 ? 1 : 0.25 }}>
                      <div className="absolute inset-x-0 bottom-0 bg-[var(--color-lime)]" style={{ height: `${reveal * 100}%`, opacity: 0.9 }} />
                      <div className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-[var(--color-on-accent)]">
                        {reveal >= 1 ? `clip ${i + 1} ✓` : `render ${i + 1}`}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-[var(--color-muted)]">assembly + captions + voiceover</span>
                <span className="text-[var(--color-lime)]">{pct}%</span>
              </div>
              <div className="h-2 bg-[var(--color-raised)] overflow-hidden">
                <div className="h-full bg-[var(--color-lime)]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {s.key === 'review' && (
            <div className="flex-1 flex flex-col justify-center gap-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">Review item · tiktok</span>
                <span className="flex items-center gap-2 text-[10px] font-mono text-[var(--color-lime)]">
                  <span className="w-1.5 h-1.5 bg-[var(--color-lime)] pulse-lime" /> queued
                </span>
              </div>
              <div className="flex items-center gap-6 bg-[var(--color-bg)] border border-[var(--color-input)] p-4">
                <div>
                  <div className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Viral score</div>
                  <div className="text-5xl font-black text-[var(--color-lime)]" style={{ fontFamily: 'Barlow Condensed' }}>
                    {Math.round(60 + sub * 36)}
                  </div>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-mono text-[var(--color-text)]">Wait for this.</div>
                  <div className="mt-1 text-[10px] font-mono text-[var(--color-muted-2)]">originality 82/100 · flags: none</div>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-[var(--color-on-accent)]" style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)' }}>
                  Approve
                </span>
                <span className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-faint)] text-[var(--color-muted-6)]">
                  Reject
                </span>
              </div>
            </div>
          )}
        </div>

        {/* stage footer */}
        <div className="border-t border-[var(--color-raised)] px-5 py-4">
          <div className="text-xs font-black uppercase tracking-widest text-[var(--color-text)]" style={{ fontFamily: 'Barlow Condensed' }}>
            {s.title}
          </div>
          <p className="mt-1 text-[11px] font-mono text-[var(--color-muted-4)]">{s.caption}</p>
        </div>
      </div>
    </div>
  )
}
