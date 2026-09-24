import { CurriculumWorkspace } from '../curriculum/CurriculumWorkspace'

interface CurriculumProps {
  enabled: boolean
  onEnable: () => void | Promise<void>
  busy?: boolean
}

const BARLOW = "'Barlow Condensed', 'Arial Narrow', sans-serif"

/**
 * Curriculum Mode entry point. When the mode is off it renders the activation
 * screen (unchanged — covered by committed tests). When it's on it hands off to
 * <CurriculumWorkspace/>, which hosts its own nested <Routes> for the sub-nav,
 * course list and creation wizard. The parent (WorkspaceLayout) owns `appMode`
 * and passes `enabled` / `onEnable` / `busy`.
 */
export function Curriculum({ enabled, onEnable, busy = false }: CurriculumProps) {
  if (!enabled) {
    const cells = [
      { label: 'COURSE', n: 1 },
      { label: 'MODULES', n: 2 },
      { label: 'MICRO-LESSONS', n: 3 },
      { label: 'PROJECTS', n: 4 }
    ]
    return (
      <section className="max-w-5xl">
        <div className="border border-[var(--color-raised)] bg-[var(--color-surface)] p-8 space-y-6">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
            VUGC Curriculum Engine
          </p>
          <h2
            className="text-5xl font-black uppercase"
            style={{ fontFamily: BARLOW, color: 'var(--color-text)' }}
          >
            Curriculum Mode
          </h2>
          <p className="text-sm text-[var(--color-muted-2)] max-w-2xl">
            Turn a subject into a structured learning system: courses, modules, micro-lessons,
            vertical videos, hands-on projects and long-form tutorials.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cells.map((c) => (
              <div key={c.label} className="border border-[var(--color-raised)] p-4">
                <p className="text-[10px] font-mono text-[var(--color-muted-3)] tracking-widest">
                  {`0${c.n}`}
                </p>
                <p className="mt-2 text-xs font-mono uppercase tracking-widest text-[var(--color-text)]">
                  {c.label}
                </p>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onEnable()
            }}
            className="px-8 py-3 text-sm font-black uppercase tracking-widest transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            {busy ? 'ACTIVATING…' : 'ACTIVATE CURRICULUM MODE'}
          </button>
        </div>
      </section>
    )
  }

  return <CurriculumWorkspace />
}
