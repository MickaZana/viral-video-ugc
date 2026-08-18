import { useState } from 'react'
import { api } from '../lib/api'

const ONBOARDING_KEY = 'ugu-onboarding-done'

export function useOnboarding() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(ONBOARDING_KEY) === '1'
    } catch {
      return false
    }
  })

  function complete() {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1')
    } catch {
      // ignore
    }
    setDismissed(true)
  }

  return { showOnboarding: !dismissed, completeOnboarding: complete }
}

type Step = 0 | 1 | 2 | 3

interface OnboardingProps {
  onComplete: () => void
  onNavigate: (tab: string) => void
  onStart?: (runId: string) => void
}

export function Onboarding({ onComplete, onNavigate, onStart }: OnboardingProps) {
  const [step, setStep] = useState<Step>(0)
  const [starting, setStarting] = useState(false)

  async function handleStart() {
    setStarting(true)
    try {
      const { runId } = await api.start({})
      onStart?.(runId)
    } catch {
      // If the run can't start, don't trap the user in the overlay — let them in.
      onComplete()
    }
  }

  function next() {
    if (step < 3) setStep((step + 1) as Step)
    else onComplete()
  }

  function goToTab(tab: string) {
    onComplete()
    onNavigate(tab)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex border-b border-[var(--color-border)]">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex-1 h-1 transition-all duration-500"
              style={{ backgroundColor: i <= step ? 'var(--color-lime)' : 'var(--color-faint)' }}
            />
          ))}
        </div>

        <div className="p-8">
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-1.5 h-1.5 bg-[var(--color-lime)]" />
                <span className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">First run</span>
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">
                WELCOME TO VIRAL VIDEO UGC
              </h2>
              <p className="text-sm text-[var(--color-muted-4)] leading-relaxed">
                A weekly factory for finished shorts. We&apos;ll get you set up in 30 seconds.
              </p>
              <div className="border border-[var(--color-raised)] p-4 mt-4">
                <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)] mb-2">What you can do here</p>
                <ul className="space-y-2 text-[13px] text-[var(--color-muted-4)]">
                  <li>Find ranked viral sources this week</li>
                  <li>Rewrite Hook / Point / CTA per platform</li>
                  <li>Run the nine-stage factory (dry-run is free)</li>
                  <li>Review and approve 9:16 masters</li>
                </ul>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Step 2 of 4</p>
              <h2 className="text-xl font-semibold tracking-tight text-[var(--color-text)]">Your pipeline</h2>
              <p className="text-sm text-[var(--color-muted-4)] leading-relaxed">Every video follows this path:</p>
              <div className="space-y-3">
                {[
                  { label: 'Discover', desc: 'Find viral source videos from tracked creators' },
                  { label: 'Rewrite', desc: 'AI rewrites the script for your niche and brand' },
                  { label: 'Generate', desc: 'Pick a model and render your video' },
                  { label: 'Review', desc: 'QA scores it, you approve or regenerate' }
                ].map((s) => (
                  <div key={s.label} className="flex items-start gap-3 border border-[var(--color-raised)] p-3">
                    <span className="w-1.5 h-1.5 mt-1.5 shrink-0 bg-[var(--color-lime)]" />
                    <div>
                      <p className="text-[11px] uppercase tracking-widest text-[var(--color-text)]">{s.label}</p>
                      <p className="text-[12px] text-[var(--color-muted-4)] mt-0.5">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Step 3 of 4</p>
              <h2 className="text-xl font-semibold tracking-tight text-[var(--color-text)]">Quick start</h2>
              <p className="text-sm text-[var(--color-muted-4)] leading-relaxed">
                Choose your first move. You can always do these later from the sidebar.
              </p>
              <div className="grid grid-cols-1 gap-2 mt-4">
                {[
                  { tab: 'remix', label: 'Remix a video', desc: 'Paste a viral URL, get your version' },
                  { tab: 'generator', label: 'Create a client', desc: 'Set up your niche, brand and model picks' },
                  { tab: 'spy', label: 'Explore sources', desc: 'See who is going viral in your space' }
                ].map((a) => (
                  <button
                    key={a.tab}
                    onClick={() => goToTab(a.tab)}
                    className="flex items-center gap-4 p-4 border border-[var(--color-raised)] text-left hover:border-[var(--color-lime)] hover:bg-[var(--color-raised)] transition-colors"
                  >
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-widest text-[var(--color-text)]">{a.label}</p>
                      <p className="text-[12px] text-[var(--color-muted-4)] mt-0.5">{a.desc}</p>
                    </div>
                    <span className="ml-auto text-[var(--color-muted-3)]">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Step 4 of 4</p>
              <h2 className="text-xl font-semibold tracking-tight text-[var(--color-text)]">
                You&apos;re ready
              </h2>
              <p className="text-sm text-[var(--color-muted-4)] leading-relaxed">
                This Week is home. Start a dry-run, then review what lands in the queue.
              </p>
              <div className="border border-[var(--color-border)] p-4 mt-4">
                <p className="text-[11px] uppercase tracking-widest text-[var(--color-lime)] mb-2">Pro tips</p>
                <ul className="space-y-1.5 text-[12px] text-[var(--color-muted-4)]">
                  <li>• Remix turns any viral URL into your niche</li>
                  <li>• Dry-run is free — test the pipeline without spending on video models</li>
                  <li>• Intel fills up as you run more pipelines</li>
                  <li>• Theme lives in Settings</li>
                </ul>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mt-8 pt-4 border-t border-[var(--color-raised)]">
            <button
              onClick={onComplete}
              className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)] transition-colors"
            >
              Skip
            </button>
            <div className="flex items-center gap-3">
              {step > 0 && (
                <button
                  onClick={() => setStep((step - 1) as Step)}
                  className="text-[10px] uppercase tracking-widest px-4 py-2 border border-[var(--color-faint)] text-[var(--color-muted-4)] hover:border-[var(--color-lime)] transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={step === 3 ? handleStart : next}
                disabled={step === 3 && starting}
                className="px-6 py-2.5 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                {step === 3 ? (starting ? 'Starting…' : 'Get started') : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}