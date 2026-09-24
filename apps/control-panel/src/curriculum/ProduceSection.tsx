import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { CourseStatusBadge } from './parts'

/**
 * `/curriculum/produce` — pick a course to open its production dashboard (§27).
 * Real course list from `api.curricula()`.
 */
export function ProduceSection() {
  const navigate = useNavigate()
  const { data, error, loading } = useApi(() => api.curricula())
  const courses = data?.courses ?? []

  return (
    <div className="space-y-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
        Produce — pick a course
      </p>

      {loading && courses.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading courses…</p>
      )}

      {!loading && !error && courses.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted-3)]">
          No courses yet — create one and generate its plan first.
        </p>
      )}

      {courses.length > 0 && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
          {courses.map((course) => (
            <button
              key={course.id}
              type="button"
              onClick={() => navigate(paths.curriculumProduceCourse(course.id))}
              className="w-full text-left px-4 py-3 hover:bg-[var(--color-raised)] transition-colors flex items-center gap-4"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-[var(--color-text)] truncate">{course.title}</span>
                <span className="block text-[11px] text-[var(--color-muted-3)] mt-0.5 truncate">
                  {course.topic}
                </span>
              </span>
              <CourseStatusBadge status={course.status} />
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}
    </div>
  )
}
