import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { CurriculumQaIssue } from '../lib/types'
import { CourseStatusBadge, ScorePctBar, TagBadge } from './parts'

const CONTENT_STATUS_COLOR: Record<string, string> = {
  draft: 'var(--color-muted-2)',
  approved: 'var(--color-blue)',
  scripted: 'var(--color-blue)',
  queued: 'var(--color-orange)',
  generated: 'var(--color-orange)',
  review: 'var(--color-orange)',
  published: 'var(--color-lime)',
  producing: 'var(--color-orange)',
  completed: 'var(--color-lime)'
}

const statusColor = (s: string) => CONTENT_STATUS_COLOR[s] ?? 'var(--color-muted-2)'
const pctOf = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0)

/**
 * `/curriculum/courses/:courseId` — the course overview: header, F2 learn/
 * produce/publish progress rollup, the module list, and the lifecycle-gated
 * structural actions (generate plan / approve & lock).
 */
export function CourseOverview() {
  const { courseId = '' } = useParams<{ courseId: string }>()
  const navigate = useNavigate()

  const course = useApi(() => api.curriculum(courseId), [courseId])
  const modules = useApi(() => api.curriculumModules(courseId), [courseId])
  const progress = useApi(() => api.curriculumProgress(courseId), [courseId])

  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [planWarnings, setPlanWarnings] = useState<CurriculumQaIssue[] | null>(null)

  function reloadAll() {
    course.reload()
    modules.reload()
    progress.reload()
  }

  async function generatePlan() {
    setActionBusy(true)
    setActionError(null)
    try {
      const result = await api.generateCurriculumPlan(courseId, { seed: undefined })
      setPlanWarnings(result.qa.warnings)
      reloadAll()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  async function approve() {
    if (!window.confirm('Approve & lock this course? The module/lesson structure can no longer change.')) {
      return
    }
    setActionBusy(true)
    setActionError(null)
    try {
      await api.approveCurriculum(courseId)
      reloadAll()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const data = course.data
  const moduleRows = modules.data?.modules ?? []
  const prog = progress.data

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate(paths.curriculumCourses)}
        className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        ← All courses
      </button>

      {course.loading && !data && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading course…</p>
      )}
      {course.error && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {course.error}</p>
      )}

      {data && (
        <>
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-xl font-semibold text-[var(--color-text)] leading-snug">
                  {data.course.title}
                </h3>
                <p className="text-sm text-[var(--color-muted-2)]">{data.course.topic}</p>
              </div>
              <CourseStatusBadge status={data.course.status} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Meta label="Audience" value={data.course.audience} />
              <Meta label="End goal" value={data.course.endGoal} />
              <Meta
                label="Shape"
                value={`${data.course.moduleCount} modules × ${data.course.lessonsPerModule} lessons`}
              />
              <Meta
                label="Spend cap"
                value={
                  data.course.maxGenerationSpendUsd === null
                    ? 'No cap'
                    : `$${data.course.maxGenerationSpendUsd.toFixed(2)}`
                }
              />
            </div>

            <div className="flex flex-wrap gap-6">
              {[
                { label: 'Modules', value: data.counts.modules },
                { label: 'Lessons', value: data.counts.lessons },
                { label: 'Projects', value: data.counts.projects }
              ].map((c) => (
                <div key={c.label}>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                    {c.label}
                  </p>
                  <p className="text-2xl font-black font-mono text-[var(--color-text)] mt-1">{c.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Progress rollup (§16) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Progress
            </p>
            {progress.loading && !prog && (
              <p className="text-[11px] text-[var(--color-muted-3)]">Loading progress…</p>
            )}
            {progress.error && (
              <p className="text-[11px] text-[var(--color-muted-3)]">Progress unavailable — showing —</p>
            )}

            <ScorePctBar label="Learning — lessons completed" pct={prog ? prog.learning.pct : 0} />

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                  Production
                </p>
                <ScorePctBar
                  label="Lessons scripted"
                  pct={prog ? pctOf(prog.production.lessonsScripted, prog.learning.lessonsTotal) : 0}
                  color="var(--color-blue)"
                />
                <ScorePctBar
                  label="Lessons produced"
                  pct={prog ? pctOf(prog.production.lessonsProduced, prog.learning.lessonsTotal) : 0}
                  color="var(--color-blue)"
                />
                <div className="flex flex-wrap gap-6 pt-1">
                  <Figure label="Scripted" value={prog ? prog.production.lessonsScripted : null} />
                  <Figure label="Produced" value={prog ? prog.production.lessonsProduced : null} />
                  <Figure label="Assets total" value={prog ? prog.production.assetsTotal : null} />
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                  Publishing
                </p>
                <ScorePctBar
                  label="Assets published"
                  pct={prog ? pctOf(prog.publishing.assetsPublished, prog.production.assetsTotal) : 0}
                />
                <div className="flex flex-wrap gap-6 pt-1">
                  <Figure label="Published" value={prog ? prog.publishing.assetsPublished : null} />
                  <Figure label="Of total" value={prog ? prog.production.assetsTotal : null} />
                </div>
              </div>
            </div>
          </div>

          {/* Actions bar (§16) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Actions
            </p>
            {data.course.status === 'draft' && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={generatePlan}
                className="px-6 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                {actionBusy ? 'Generating…' : 'Generate plan'}
              </button>
            )}
            {data.course.status === 'planned' && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={approve}
                className="px-6 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
              >
                {actionBusy ? 'Approving…' : 'Approve & lock'}
              </button>
            )}
            {(data.course.status === 'active' || data.course.status === 'completed') && (
              <p className="text-[12px] text-[var(--color-muted-2)]">
                Locked — content edits still allowed per lesson.
              </p>
            )}
            {data.course.status !== 'draft' &&
              data.course.status !== 'planned' &&
              data.course.status !== 'active' &&
              data.course.status !== 'completed' && (
                <p className="text-[12px] text-[var(--color-muted-3)]">No structural actions in this state.</p>
              )}
            {actionError && <p className="text-[11px] text-[var(--color-red)]">{actionError}</p>}
          </div>

          {/* QA warnings from the last generate-plan (§16 — non-blocking, dismissible) */}
          {planWarnings && (
            <div className="border border-[var(--color-orange)] bg-[var(--color-surface)] p-5 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-orange)]">
                  {planWarnings.length} QA warning{planWarnings.length === 1 ? '' : 's'} — plan still applied
                </p>
                <button
                  type="button"
                  onClick={() => setPlanWarnings(null)}
                  className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-3)] hover:text-[var(--color-text)]"
                >
                  Dismiss
                </button>
              </div>
              {planWarnings.length === 0 ? (
                <p className="text-[12px] text-[var(--color-muted-2)]">No warnings — clean plan.</p>
              ) : (
                <ul className="list-disc pl-5 space-y-1">
                  {planWarnings.map((w, i) => (
                    <li key={i} className="text-[12px] text-[var(--color-muted-2)]">
                      {w.message}
                      {w.moduleOrder !== undefined && (
                        <span className="text-[var(--color-muted-3)]"> (module {w.moduleOrder})</span>
                      )}
                      {w.lessonGlobalOrder !== undefined && (
                        <span className="text-[var(--color-muted-3)]"> (lesson #{w.lessonGlobalOrder})</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Module list */}
          <div className="space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Modules
            </p>
            {modules.loading && moduleRows.length === 0 && (
              <p className="text-[11px] text-[var(--color-muted-3)]">Loading modules…</p>
            )}
            {modules.error && (
              <p className="text-[11px] text-[var(--color-red)]">Load error: {modules.error}</p>
            )}
            {!modules.loading && !modules.error && moduleRows.length === 0 && (
              <p className="text-[11px] text-[var(--color-muted-3)]">
                No modules yet — generate the plan to build them.
              </p>
            )}
            {moduleRows.length > 0 && (
              <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
                {moduleRows.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => navigate(paths.curriculumModule(courseId, m.id))}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--color-raised)] transition-colors flex items-center gap-4"
                  >
                    <span className="text-[11px] font-mono text-[var(--color-muted-3)] w-8 shrink-0">
                      {String(m.order).padStart(2, '0')}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-[var(--color-text)] truncate">{m.title}</span>
                      <span className="block text-[11px] text-[var(--color-muted-3)] mt-0.5">
                        {m.lessonCount} {m.lessonCount === 1 ? 'lesson' : 'lessons'}
                        {m.hasProject ? ' · project' : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <TagBadge label={m.status} color={statusColor(m.status)} />
                      <TagBadge
                        label={`LF ${m.longFormScriptStatus}`}
                        color={statusColor(m.longFormScriptStatus)}
                      />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">{label}</p>
      <p className="text-sm text-[var(--color-text)] break-words">{value || '—'}</p>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">{label}</p>
      <p className="text-xl font-black font-mono text-[var(--color-text)] mt-0.5">
        {value === null ? '—' : value}
      </p>
    </div>
  )
}
