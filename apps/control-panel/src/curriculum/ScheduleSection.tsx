import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { ScoreBar } from '../components/primitives'

/**
 * `/curriculum/schedule` — a "what to learn / produce next" board built from
 * `api.curriculumToday()`. There is no cron UI and no fabricated dates: this is
 * the honest, real-lite view of where each active course stands.
 */
export function ScheduleSection() {
  const navigate = useNavigate()
  const { data, error, loading, reload } = useApi(() => api.curriculumToday())
  const items = data?.items ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
          Schedule — what is next per course
        </p>
        <button
          type="button"
          onClick={reload}
          className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-3)] hover:text-[var(--color-text)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && items.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading…</p>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 space-y-2">
          <p className="text-sm text-[var(--color-muted-2)]">Nothing active.</p>
          <p className="text-[11px] text-[var(--color-muted-3)] max-w-lg">
            A course appears here once it has been approved and locked for production.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
          {items.map((item) => (
            <div key={item.courseId} className="px-4 py-4 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--color-text)] truncate">{item.courseTitle}</p>
                  <p className="text-[11px] text-[var(--color-muted-3)] mt-0.5">
                    {item.nextLesson
                      ? `Next: ${item.nextLesson.title}`
                      : 'All lessons complete'}{' '}
                    · {item.lessonsCompleted}/{item.lessonsTotal} lessons
                  </p>
                </div>
                {item.nextLesson && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        paths.curriculumLearnLesson(item.courseId, item.nextLesson!.id)
                      )
                    }
                    className="shrink-0 px-4 py-2 text-[11px] font-mono uppercase tracking-widest transition-colors hover:brightness-110"
                    style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                  >
                    Continue
                  </button>
                )}
              </div>
              <ScoreBar score={item.pct} />
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}

      <p className="text-[11px] text-[var(--color-muted-3)] max-w-xl">
        Production cadence is set per course and runs are triggered from the Produce dashboard.
        Automated scheduling is not part of Curriculum Mode v2.
      </p>
    </div>
  )
}
