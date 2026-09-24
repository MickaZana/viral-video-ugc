import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { ScoreBar } from '../components/primitives'
import type { CurriculumCourse } from '../lib/types'
import { CourseStatusBadge } from './parts'

/**
 * `/curriculum/courses` — every course in the org as a responsive card grid.
 * Each card shows real learning progress fetched per-course by <CourseCard/>.
 */
export function CourseList() {
  const navigate = useNavigate()
  const { data, error, loading } = useApi(() => api.curricula())
  const courses = data?.courses ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
          {courses.length} {courses.length === 1 ? 'course' : 'courses'}
        </p>
        <button
          type="button"
          onClick={() => navigate(paths.curriculumCourseNew)}
          className="px-4 py-2 text-[11px] font-mono uppercase tracking-widest transition-colors hover:brightness-110"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          ＋ New course
        </button>
      </div>

      {loading && courses.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading courses…</p>
      )}

      {!loading && !error && courses.length === 0 && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 space-y-3">
          <p className="text-sm text-[var(--color-muted-2)]">No courses yet.</p>
          <button
            type="button"
            onClick={() => navigate(paths.curriculumCourseNew)}
            className="px-6 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            Create your first course
          </button>
        </div>
      )}

      {courses.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <CourseCard
              key={course.id}
              course={course}
              onOpen={() => navigate(paths.curriculumCourse(course.id))}
            />
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}
    </div>
  )
}

function CourseCard({ course, onOpen }: { course: CurriculumCourse; onOpen: () => void }) {
  const progress = useApi(() => api.curriculumProgress(course.id), [course.id])
  const pct = progress.data?.learning.pct ?? null

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3 hover:border-[var(--color-lime)] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--color-text)] leading-snug">{course.title}</p>
        <CourseStatusBadge status={course.status} />
      </div>
      <p className="text-[11px] text-[var(--color-muted-3)] truncate">{course.topic}</p>
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
        {course.moduleCount} × {course.lessonsPerModule} lessons
      </p>
      <div>
        {progress.loading && pct === null ? (
          <p className="text-[10px] font-mono text-[var(--color-muted-3)]">progress…</p>
        ) : pct === null ? (
          <p className="text-[10px] font-mono text-[var(--color-muted-3)]">progress —</p>
        ) : (
          <ScoreBar score={pct} />
        )}
      </div>
    </button>
  )
}
