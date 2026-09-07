import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type {
  CurriculumCostEstimate,
  CurriculumModuleWithCounts,
  CurriculumQueueResult,
  LessonProduceResult
} from '../lib/types'
import { TagBadge } from './parts'

/** Backend PRODUCED_ASSET_STATUSES — an asset counts as produced once it has
 *  reached a review-or-later state. */
const PRODUCED_ASSET_STATUSES = ['review', 'generated', 'approved', 'published']

const shortId = (id: string | undefined): string => (id ? id.slice(0, 8) : '—')
const usd = (n: number): string => `$${n.toFixed(4)}`

/**
 * `produce/:courseId` — the production dashboard (§27): a labelled cost ESTIMATE,
 * per-module queue / long-form actions, a course-level batch queue, and the
 * read-only asset ledger. Every figure and action is real api.* data.
 */
export function ProduceDashboard() {
  const { courseId = '' } = useParams<{ courseId: string }>()
  const navigate = useNavigate()

  const courseState = useApi(() => api.curriculum(courseId), [courseId])
  const modulesState = useApi(() => api.curriculumModules(courseId), [courseId])
  const progressState = useApi(() => api.curriculumProgress(courseId), [courseId])
  const assetsState = useApi(() => api.curriculumAssets(courseId), [courseId])

  const [estimate, setEstimate] = useState<CurriculumCostEstimate | null>(null)
  const [estBusy, setEstBusy] = useState(false)
  const [estError, setEstError] = useState<string | null>(null)

  const [courseQueueBusy, setCourseQueueBusy] = useState(false)
  const [courseQueueError, setCourseQueueError] = useState<string | null>(null)
  const [courseQueueResult, setCourseQueueResult] = useState<CurriculumQueueResult | null>(null)

  const course = courseState.data?.course
  const modules = modulesState.data?.modules ?? []
  const assets = assetsState.data?.assets ?? []
  const prog = progressState.data

  function reloadProduceLoaders() {
    modulesState.reload()
    progressState.reload()
    assetsState.reload()
    courseState.reload()
  }

  async function estimateCost() {
    setEstBusy(true)
    setEstError(null)
    try {
      const result = await api.curriculumCostEstimate(courseId, { scope: 'course' })
      setEstimate(result)
    } catch (err) {
      setEstError(err instanceof Error ? err.message : String(err))
    } finally {
      setEstBusy(false)
    }
  }

  async function queueWholeCourse() {
    if (
      !window.confirm(
        'Queue the entire approved course? This runs a production pass over every scripted lesson (dry-run).'
      )
    ) {
      return
    }
    setCourseQueueBusy(true)
    setCourseQueueError(null)
    try {
      const result = await api.queueApprovedCourse(courseId)
      setCourseQueueResult(result)
      reloadProduceLoaders()
    } catch (err) {
      setCourseQueueError(err instanceof Error ? err.message : String(err))
    } finally {
      setCourseQueueBusy(false)
    }
  }

  const producedShortByModule = (moduleId: string): number =>
    assets.filter(
      (a) =>
        a.moduleId === moduleId &&
        a.assetType === 'short_video' &&
        PRODUCED_ASSET_STATUSES.includes(a.status)
    ).length

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate(paths.curriculumProduce)}
        className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        ← All courses
      </button>

      {courseState.loading && !course && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading course…</p>
      )}
      {courseState.error && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {courseState.error}</p>
      )}

      {course && (
        <>
          <div className="space-y-1">
            <h3 className="text-xl font-semibold text-[var(--color-text)]">{course.title}</h3>
            <p className="text-[11px] text-[var(--color-muted-3)]">
              Status: {course.status}
              {prog
                ? ` · ${prog.production.lessonsScripted} scripted · ${prog.production.lessonsProduced} produced · ${prog.production.assetsTotal} assets`
                : ''}
            </p>
          </div>

          {/* Cost preview (§27) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
                Cost estimate
              </p>
              <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-orange)]">
                Estimate only
              </span>
            </div>
            <button
              type="button"
              disabled={estBusy}
              onClick={estimateCost}
              className="px-4 py-2 text-[11px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
            >
              {estBusy ? 'Working…' : 'Estimate course cost'}
            </button>
            {estError && <p className="text-[11px] text-[var(--color-red)]">{estError}</p>}

            {estimate && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-6">
                  <Figure label="Total (est.)" value={usd(estimate.totalUsd)} />
                  <Figure label="Per lesson (est.)" value={usd(estimate.perLessonUsd)} />
                  <Figure
                    label="Scope"
                    value={`${estimate.scope} · ${estimate.counts.lessons} lessons / ${estimate.counts.modules} modules`}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <LineItem label="Script" value={usd(estimate.lineItems.scriptUsd)} />
                  <LineItem label="Video" value={usd(estimate.lineItems.videoUsd)} />
                  <LineItem label="Voice" value={usd(estimate.lineItems.voiceUsd)} />
                  <LineItem
                    label="Long-form script"
                    value={usd(estimate.lineItems.longFormScriptUsd)}
                  />
                </div>

                <div
                  className="border p-3 text-[12px]"
                  style={{
                    borderColor: estimate.cap.withinCap
                      ? 'var(--color-border)'
                      : 'var(--color-red)',
                    color: estimate.cap.withinCap
                      ? 'var(--color-muted-2)'
                      : 'var(--color-red)'
                  }}
                >
                  {estimate.cap.maxGenerationSpendUsd === null ? (
                    <span>No spend cap set on this course.</span>
                  ) : estimate.cap.withinCap ? (
                    <span>
                      Within cap ({usd(estimate.cap.maxGenerationSpendUsd)}) —{' '}
                      {estimate.cap.remainingUsd === null
                        ? '—'
                        : `${usd(estimate.cap.remainingUsd)} remaining`}
                      .
                    </span>
                  ) : (
                    <span>
                      OVER the spend cap of {usd(estimate.cap.maxGenerationSpendUsd)}
                      {estimate.cap.remainingUsd === null
                        ? ''
                        : ` by ${usd(Math.abs(estimate.cap.remainingUsd))}`}
                      .
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                    Assumptions
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    {estimate.assumptions.map((a, i) => (
                      <li key={i} className="text-[12px] text-[var(--color-muted-2)]">
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="text-[11px] text-[var(--color-muted-3)] italic">
                  {estimate.disclaimer}
                </p>
              </div>
            )}
          </div>

          {/* Per-module actions */}
          <div className="space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Modules
            </p>
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
            {modules.map((m) => (
              <ModuleRow
                key={m.id}
                courseId={courseId}
                module={m}
                producedShortCount={producedShortByModule(m.id)}
                onDone={reloadProduceLoaders}
              />
            ))}
          </div>

          {/* Course-level batch queue */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Queue entire approved course
            </p>
            <p className="text-[12px] text-[var(--color-muted-2)]">
              Runs a production pass over every scripted lesson in the course. Available only once
              the course is <span className="font-mono">active</span> (approved &amp; locked).
            </p>
            <button
              type="button"
              disabled={courseQueueBusy || course.status !== 'active'}
              onClick={queueWholeCourse}
              className="px-5 py-2.5 text-[11px] font-mono uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
              style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
            >
              {courseQueueBusy ? 'Working…' : 'Queue entire approved course'}
            </button>
            {course.status !== 'active' && (
              <p className="text-[11px] text-[var(--color-muted-3)]">
                Course is <span className="font-mono">{course.status}</span> — approve it to enable
                this.
              </p>
            )}
            {courseQueueError && (
              <p className="text-[11px] text-[var(--color-red)]">{courseQueueError}</p>
            )}
            {courseQueueResult && <QueueResultView result={courseQueueResult} />}
          </div>

          {/* Asset ledger (read-only) */}
          <div className="space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Assets ({assets.length})
            </p>
            {assetsState.loading && assets.length === 0 && (
              <p className="text-[11px] text-[var(--color-muted-3)]">Loading assets…</p>
            )}
            {assetsState.error && (
              <p className="text-[11px] text-[var(--color-red)]">Load error: {assetsState.error}</p>
            )}
            {!assetsState.loading && !assetsState.error && assets.length === 0 && (
              <p className="text-[11px] text-[var(--color-muted-3)]">
                No assets produced yet — queue a module or a lesson to create some.
              </p>
            )}
            {assets.length > 0 && (
              <div className="overflow-x-auto border border-[var(--color-border)] bg-[var(--color-surface)]">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Lesson</th>
                      <th className="px-3 py-2">Module</th>
                      <th className="px-3 py-2">Dry-run</th>
                      <th className="px-3 py-2">Review item</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-[var(--color-raised)] text-[var(--color-text)]"
                      >
                        <td className="px-3 py-2 font-mono">{a.assetType}</td>
                        <td className="px-3 py-2">
                          <TagBadge label={a.status} />
                        </td>
                        <td className="px-3 py-2 font-mono text-[var(--color-muted-2)]">
                          {shortId(a.lessonId)}
                        </td>
                        <td className="px-3 py-2 font-mono text-[var(--color-muted-2)]">
                          {shortId(a.moduleId)}
                        </td>
                        <td className="px-3 py-2 font-mono text-[var(--color-muted-2)]">
                          {a.meta.dryRun === true
                            ? 'yes'
                            : a.meta.dryRun === false
                              ? 'no'
                              : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-[var(--color-muted-2)]">
                          {shortId(a.reviewItemId)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ModuleRow({
  courseId,
  module,
  producedShortCount,
  onDone
}: {
  courseId: string
  module: CurriculumModuleWithCounts
  producedShortCount: number
  onDone: () => void
}) {
  const [queueBusy, setQueueBusy] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [queueResult, setQueueResult] = useState<CurriculumQueueResult | null>(null)

  const [lfBusy, setLfBusy] = useState(false)
  const [lfError, setLfError] = useState<string | null>(null)
  const [lfResult, setLfResult] = useState<LessonProduceResult | null>(null)

  async function queueModule() {
    setQueueBusy(true)
    setQueueError(null)
    try {
      const result = await api.queueModule(courseId, module.id)
      setQueueResult(result)
      onDone()
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : String(err))
    } finally {
      setQueueBusy(false)
    }
  }

  async function produceLongForm() {
    setLfBusy(true)
    setLfError(null)
    try {
      const result = await api.produceModuleLongForm(courseId, module.id)
      setLfResult(result)
      onDone()
    } catch (err) {
      setLfError(err instanceof Error ? err.message : String(err))
    } finally {
      setLfBusy(false)
    }
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-[var(--color-text)]">
            <span className="font-mono text-[var(--color-muted-3)] mr-2">
              {String(module.order).padStart(2, '0')}
            </span>
            {module.title}
          </p>
          <p className="text-[11px] text-[var(--color-muted-3)] mt-0.5">
            {module.lessonCount} {module.lessonCount === 1 ? 'lesson' : 'lessons'} ·{' '}
            {producedShortCount} short video{producedShortCount === 1 ? '' : 's'} produced
          </p>
        </div>
        <TagBadge label={`LF ${module.longFormScriptStatus}`} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={queueBusy}
          onClick={queueModule}
          className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
        >
          {queueBusy ? 'Working…' : 'Queue module'}
        </button>
        <button
          type="button"
          disabled={lfBusy}
          onClick={produceLongForm}
          className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-muted-2)] hover:text-[var(--color-text)] hover:border-[var(--color-text)] transition-colors disabled:opacity-50"
        >
          {lfBusy ? 'Working…' : 'Produce long-form'}
        </button>
      </div>

      {queueError && <p className="text-[11px] text-[var(--color-red)]">{queueError}</p>}
      {queueResult && <QueueResultView result={queueResult} />}

      {lfError && <p className="text-[11px] text-[var(--color-red)]">{lfError}</p>}
      {lfResult && (
        <div className="border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-muted-2)] space-y-1">
          <p>
            Long-form asset <span className="font-mono">{shortId(lfResult.asset.id)}</span> ·{' '}
            {lfResult.asset.assetType} · {lfResult.asset.status}
          </p>
          <p>
            Run <span className="font-mono">{shortId(lfResult.run.runId)}</span> ·{' '}
            {lfResult.run.dryRun ? 'dry-run' : 'live'} · {lfResult.run.reviewItemsCreated} review
            item(s)
          </p>
        </div>
      )}
    </div>
  )
}

function QueueResultView({ result }: { result: CurriculumQueueResult }) {
  const groupedSkips = result.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="border border-[var(--color-border)] p-3 text-[12px] space-y-1.5">
      <p className="text-[var(--color-text)]">
        {result.dryRun ? 'Dry-run' : 'Live'} queue ({result.scope}) — {result.produced.length}{' '}
        produced, {result.skipped.length} skipped of {result.eligible} eligible.
      </p>
      <p className="text-[var(--color-muted-2)]">
        Estimated spend: {usd(result.estimatedSpendUsd)} · max concurrent {result.maxConcurrent}
        {result.cap.maxGenerationSpendUsd === null
          ? ''
          : ` · cap ${usd(result.cap.maxGenerationSpendUsd)}`}
      </p>
      {Object.keys(groupedSkips).length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5 text-[var(--color-muted-2)]">
          {Object.entries(groupedSkips).map(([reason, count]) => (
            <li key={reason}>
              {reason}: {count}
            </li>
          ))}
        </ul>
      )}
      {result.stoppedByCap && (
        <p className="text-[var(--color-red)]">Stopped by spend cap before all lessons were queued.</p>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
        {label}
      </p>
      <p className="text-lg font-black font-mono text-[var(--color-text)] mt-0.5">{value}</p>
    </div>
  )
}

function LineItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border border-[var(--color-border)] px-3 py-1.5">
      <span className="text-[11px] text-[var(--color-muted-2)]">{label}</span>
      <span className="text-[12px] font-mono text-[var(--color-text)]">{value}</span>
    </div>
  )
}
