import type { ReactNode } from 'react'

interface CurriculumProps {
  enabled: boolean
  onEnable: () => void | Promise<void>
  busy?: boolean
}

const BARLOW = "'Barlow Condensed', 'Arial Narrow', sans-serif"

/**
 * Curriculum Mode workspace — a pure presentational component. It renders either
 * an activation screen (when the mode is off) or the active education-engine
 * workspace (when it's on). It holds no state and calls no API; the parent
 * (WorkspaceLayout) owns `appMode` and passes `enabled` / `onEnable` / `busy`.
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

  const steps = [
    {
      number: '01',
      title: 'Create Course',
      description:
        'Name the subject and target learner. The engine drafts a course outline — objectives, prerequisites and a module map.'
    },
    {
      number: '02',
      title: 'Build Curriculum',
      description:
        'Expand each module into micro-lessons, hands-on projects and long-form tutorials, sequenced by difficulty.'
    },
    {
      number: '03',
      title: 'Produce',
      description:
        'Turn every lesson into a scripted vertical video, route it through QA, and ship the finished learning system.'
    }
  ]

  const pipeline = ['Topic', 'Course', 'Modules', 'Lessons', 'Projects', 'Video', 'QA']

  return (
    <section className="max-w-6xl space-y-6">
      <div className="border border-[var(--color-lime)] bg-[var(--color-surface)] p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Curriculum Mode Active
            </p>
            <h2
              className="text-4xl font-black uppercase"
              style={{ fontFamily: BARLOW, color: 'var(--color-text)' }}
            >
              Education Engine
            </h2>
            <p className="text-sm text-[var(--color-muted-2)] max-w-2xl">
              Every run now flows through the curriculum pipeline — from a raw topic to a
              QA-checked library of courses, lessons and project videos.
            </p>
          </div>
          <span className="shrink-0 border border-[var(--color-lime)] px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
            ● ACTIVE
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {steps.map((s) => (
          <CurriculumCard
            key={s.number}
            number={s.number}
            title={s.title}
            description={s.description}
          />
        ))}
      </div>

      <div className="border border-[var(--color-raised)] bg-[var(--color-surface)] p-6">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] mb-4">
          Curriculum Pipeline
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {pipeline.map((node, i) => (
            <div key={node} className="flex items-center gap-2">
              <PipelineNode>{node}</PipelineNode>
              {i < pipeline.length - 1 && <Arrow />}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

interface CurriculumCardProps {
  number: string
  title: string
  description: string
}

function CurriculumCard({ number, title, description }: CurriculumCardProps) {
  return (
    <div className="border border-[var(--color-raised)] bg-[var(--color-surface)] p-5">
      <p className="text-[10px] font-mono tracking-widest text-[var(--color-lime)]">{number}</p>
      <p
        className="mt-2 text-xl font-black uppercase"
        style={{ fontFamily: BARLOW, color: 'var(--color-text)' }}
      >
        {title}
      </p>
      <p className="mt-2 text-[13px] text-[var(--color-muted-2)] leading-relaxed">{description}</p>
    </div>
  )
}

function PipelineNode({ children }: { children: ReactNode }) {
  return (
    <span className="border border-[var(--color-raised)] px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest text-[var(--color-text)]">
      {children}
    </span>
  )
}

function Arrow() {
  return <span className="text-[var(--color-muted-3)] font-mono text-sm">→</span>
}
