import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { ScoreBar } from '../components/primitives'

/**
 * Curriculum index (`/curriculum`) — the "today / continue learning" surface.
 * Pulls the caller's per-course progress from `api.curriculumToday()` and the
 * full course list from `api.curricula()`. Empty course list → a first-run
 * empty state that routes into the creation wizard.
 */
export function CurriculumOverview() {
  const navigate = useNavigate()
  const today = useApi(() => api.curriculumToday())
  const courses = useApi(() => api.curricula())

  const items = today.data?.items ?? []
  const courseList = courses.data?.courses ?? []
  const loading = today.loading || courses.loading
  const error = today.error || courses.error

  if (!loading && !error && courseList.length === 0) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 space-y-4">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
          No courses yet
        </p>
        <p className="text-sm text-[var(--color-muted-2)] max-w-lg">
          A course turns a subject into a sequenced system of modules, micro-lessons and
          hands-on projects. Create one to get started.
        </p>
        <button
          type="button"
          onClick={() => navigate(paths.curriculumCourseNew)}
          className="px-6 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          Create your first course
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 flex flex-wrap items-center gap-6">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
            Courses
          </p>
          <p className="text-3xl font-black leading-none font-mono text-[var(--color-lime)] mt-1">
            {courseList.length}
          </p>
        </div>
        <div className="h-8 w-px bg-[var(--color-border)] hidden sm:block" />
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
            In progress
          </p>
          <p className="text-3xl font-black leading-none font-mono text-[var(--color-text)] mt-1">
            {items.filter((i) => i.lessonsCompleted > 0 && i.pct < 100).length}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(paths.curriculumCourses)}
          className="ml-auto px-4 py-2 text-[11px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors"
        >
          All courses
        </button>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
          Continue learning
        </p>
        {loading && items.length === 0 && (
          <p className="text-[11px] text-[var(--color-muted-3)]">Loading…</p>
        )}
        {!loading && items.length === 0 && (
          <p className="text-[11px] text-[var(--color-muted-3)]">
            No active courses yet — open a course and start its first lesson.
          </p>
        )}
        {items.length > 0 && (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
            {items.map((item) => (
              <button
                key={item.courseId}
                type="button"
                onClick={() => navigate(paths.curriculumCourse(item.courseId))}
                className="w-full text-left px-4 py-3 hover:bg-[var(--color-raised)] transition-colors"
              >
                <p className="text-sm text-[var(--color-text)]">{item.courseTitle}</p>
                <p className="text-[11px] text-[var(--color-muted-3)] mt-0.5">
                  {item.nextLesson
                    ? `Next: ${item.nextLesson.title}`
                    : `${item.lessonsCompleted}/${item.lessonsTotal} lessons — nothing queued`}
                </p>
                <div className="mt-2">
                  <ScoreBar score={item.pct} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}
    </div>
  )
}
