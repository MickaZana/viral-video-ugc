import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { CurriculumModuleWithCounts } from '../lib/types'
import { CourseStatusBadge, TagBadge } from './parts'

/**
 * `/curriculum/projects` — an honest aggregate of the capstone projects across a
 * course's modules. Pick a course, then every module is listed with whether it
 * carries a project and how many lessons it holds. The project bodies themselves
 * live in <ModuleView/>, so a `hasProject` row links straight there — nothing is
 * fabricated here.
 */
export function ProjectsSection() {
  const navigate = useNavigate()
  const coursesState = useApi(() => api.curricula())
  const courses = coursesState.data?.courses ?? []

  const [selectedCourseId, setSelectedCourseId] = useState('')

  const modulesState = useApi(
    () =>
      selectedCourseId
        ? api.curriculumModules(selectedCourseId)
        : Promise.resolve<{ modules: CurriculumModuleWithCounts[] }>({ modules: [] }),
    [selectedCourseId]
  )
  const modules = modulesState.data?.modules ?? []
  const projectCount = modules.filter((m) => m.hasProject).length

  return (
    <div className="space-y-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
        Projects — capstone work by module
      </p>

      {coursesState.loading && courses.length === 0 && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading courses…</p>
      )}
      {coursesState.error && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {coursesState.error}</p>
      )}

      {!coursesState.loading && !coursesState.error && courses.length === 0 && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 space-y-2">
          <p className="text-sm text-[var(--color-muted-2)]">No courses yet.</p>
          <p className="text-[11px] text-[var(--color-muted-3)] max-w-lg">
            Create a course and generate its plan — capstone projects are built per module and show
            up here.
          </p>
        </div>
      )}

      {courses.length > 0 && (
        <div className="space-y-1">
          <label
            htmlFor="projects-course"
            className="block text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]"
          >
            Course
          </label>
          <select
            id="projects-course"
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="w-full max-w-md bg-[var(--color-bg)] border border-[var(--color-input)] p-2 text-sm text-[var(--color-text)]"
          >
            <option value="">Select a course…</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {courses.length > 0 && !selectedCourseId && (
        <p className="text-[11px] text-[var(--color-muted-3)]">
          Pick a course to see its modules and their capstone projects.
        </p>
      )}

      {selectedCourseId && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              {modules.length} {modules.length === 1 ? 'module' : 'modules'}
            </p>
            {courses
              .filter((c) => c.id === selectedCourseId)
              .map((c) => (
                <CourseStatusBadge key={c.id} status={c.status} />
              ))}
            <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-3)]">
              {projectCount} with a project
            </span>
          </div>

          {modulesState.loading && modules.length === 0 && (
            <p className="text-[11px] text-[var(--color-muted-3)]">Loading modules…</p>
          )}
          {modulesState.error && (
            <p className="text-[11px] text-[var(--color-red)]">Load error: {modulesState.error}</p>
          )}
          {!modulesState.loading && !modulesState.error && modules.length === 0 && (
            <p className="text-[11px] text-[var(--color-muted-3)]">
              No modules yet — generate and approve the course plan first.
            </p>
          )}

          {modules.length > 0 && (
            <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
              {modules.map((m) =>
                m.hasProject ? (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() =>
                      navigate(paths.curriculumModule(selectedCourseId, m.id))
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--color-raised)] transition-colors flex items-center gap-4"
                  >
                    <span className="text-[11px] font-mono text-[var(--color-muted-3)] w-8 shrink-0">
                      {String(m.order).padStart(2, '0')}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-[var(--color-text)] truncate">
                        {m.title}
                      </span>
                      <span className="block text-[11px] text-[var(--color-muted-3)] mt-0.5">
                        {m.lessonCount} {m.lessonCount === 1 ? 'lesson' : 'lessons'}
                      </span>
                    </span>
                    <TagBadge label="Project ✓" color="var(--color-lime)" />
                  </button>
                ) : (
                  <div
                    key={m.id}
                    className="px-4 py-3 flex items-center gap-4 opacity-70"
                  >
                    <span className="text-[11px] font-mono text-[var(--color-muted-3)] w-8 shrink-0">
                      {String(m.order).padStart(2, '0')}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-[var(--color-text)] truncate">
                        {m.title}
                      </span>
                      <span className="block text-[11px] text-[var(--color-muted-3)] mt-0.5">
                        {m.lessonCount} {m.lessonCount === 1 ? 'lesson' : 'lessons'}
                      </span>
                    </span>
                    <TagBadge label="No project" color="var(--color-muted-2)" />
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
