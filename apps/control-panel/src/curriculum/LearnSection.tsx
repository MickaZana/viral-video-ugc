import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { ScorePctBar } from './parts'

/**
 * `/curriculum/learn` — the TODAY surface (§20/§49). Every ACTIVE course the
 * caller is enrolled in, with their next uncompleted lesson, a completion tally
 * and a bar, plus a one-click jump into the learner view for that lesson.
 * Everything comes from `api.curriculumToday()` — no mock data.
 */
export function LearnSection() {
  const navigate = useNavigate()
  const { data, error, loading, reload } = useApi(() => api.curriculumToday())
  const items = data?.items ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
          Today — what to learn next
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
          <p className="text-sm text-[var(--color-muted-2)]">Nothing active to learn.</p>
          <p className="text-[11px] text-[var(--color-muted-3)] max-w-lg">
            A course shows up here once it has been approved and locked for production. Create a
            course, generate its plan, then approve it to start learning.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.courseId}
              className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3"
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold text-[var(--color-text)] leading-snug">
                  {item.courseTitle}
                </p>
                <p className="text-[11px] text-[var(--color-muted-3)]">
                  {item.lessonsCompleted} / {item.lessonsTotal} lessons complete
                </p>
              </div>

              <ScorePctBar label="Progress" pct={item.pct} />

              {item.nextLesson ? (
                <>
                  <div className="space-y-1">
                    <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                      Next lesson
                    </p>
                    <p className="text-[13px] text-[var(--color-text)]">
                      <span className="font-mono text-[var(--color-muted-3)] mr-2">
                        #{item.nextLesson.globalOrder}
                      </span>
                      {item.nextLesson.title}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        paths.curriculumLearnLesson(item.courseId, item.nextLesson!.id)
                      )
                    }
                    className="px-4 py-2 text-[11px] font-mono uppercase tracking-widest transition-colors hover:brightness-110"
                    style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                  >
                    Start lesson
                  </button>
                </>
              ) : (
                <p className="text-[12px] text-[var(--color-lime)]">All lessons complete ✓</p>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}
    </div>
  )
}
