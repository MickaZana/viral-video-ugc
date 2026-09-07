import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { CurriculumModulePatch } from '../lib/types'
import { InlineEdit, RegenButton, TagBadge, splitComma, splitLines } from './parts'

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

/**
 * `/curriculum/courses/:courseId/modules/:moduleId` — module content editor:
 * field-granular inline edits (§17), the long-form script panel with its
 * generate/regenerate action, the lesson table, and the capstone project.
 */
export function ModuleView() {
  const { courseId = '', moduleId = '' } = useParams<{ courseId: string; moduleId: string }>()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useApi(
    () => api.curriculumModule(courseId, moduleId),
    [courseId, moduleId]
  )

  const [scriptOpen, setScriptOpen] = useState(false)
  const [lfBusy, setLfBusy] = useState(false)
  const [lfError, setLfError] = useState<string | null>(null)

  const save = (patch: CurriculumModulePatch) =>
    api.updateCurriculumModule(courseId, moduleId, patch).then(() => reload())

  async function generateLongForm() {
    setLfBusy(true)
    setLfError(null)
    try {
      await api.generateModuleLongForm(courseId, moduleId)
      reload()
    } catch (err) {
      setLfError(err instanceof Error ? err.message : String(err))
    } finally {
      setLfBusy(false)
    }
  }

  const mod = data?.module
  const lessons = data?.lessons ?? []
  const project = data?.project ?? null

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate(paths.curriculumCourse(courseId))}
        className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        ← Course overview
      </button>

      {loading && !mod && <p className="text-[11px] text-[var(--color-muted-3)]">Loading module…</p>}
      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}

      {mod && (
        <>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--color-muted-3)]">
              Module {String(mod.order).padStart(2, '0')}
            </span>
            <TagBadge label={mod.status} color={statusColor(mod.status)} />
          </div>

          {/* Editable content fields (§17) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5">
            <InlineEdit label="Title" value={mod.title} onSave={(next) => save({ title: next })} />
            <InlineEdit
              label="Description"
              value={mod.description}
              multiline
              onSave={(next) => save({ description: next })}
            />
            <InlineEdit label="Goal" value={mod.goal} multiline onSave={(next) => save({ goal: next })} />
            <InlineEdit
              label="Prerequisites (comma-separated)"
              value={mod.prerequisites.join(', ')}
              onSave={(next) => save({ prerequisites: splitComma(next) })}
            />
            <InlineEdit
              label="Learning objectives (one per line)"
              value={mod.learningObjectives.join('\n')}
              multiline
              onSave={(next) => save({ learningObjectives: splitLines(next) })}
            />
            <InlineEdit
              label="Concepts (comma-separated)"
              value={mod.concepts.join(', ')}
              onSave={(next) => save({ concepts: splitComma(next) })}
            />
          </div>

          {/* Long-form script panel */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
                Long-form script
              </p>
              <TagBadge
                label={mod.longFormScriptStatus}
                color={statusColor(mod.longFormScriptStatus)}
              />
            </div>

            {mod.longFormScript ? (
              <>
                <button
                  type="button"
                  onClick={() => setScriptOpen((v) => !v)}
                  className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
                >
                  {scriptOpen ? '▾ Hide script' : '▸ Show script'}
                </button>
                {scriptOpen && (
                  <pre className="max-h-96 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] p-3 text-[12px] font-mono whitespace-pre-wrap text-[var(--color-text)]">
                    {mod.longFormScript}
                  </pre>
                )}
              </>
            ) : (
              <p className="text-[11px] text-[var(--color-muted-3)]">No long-form script yet.</p>
            )}

            <RegenButton
              label={mod.longFormScript ? 'Regenerate long-form script' : 'Generate long-form script'}
              onClick={generateLongForm}
              busy={lfBusy}
              error={lfError}
            />
            {lfBusy && <p className="text-[11px] text-[var(--color-muted-3)]">Generating…</p>}
          </div>

          {/* Lessons table */}
          <div className="space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Lessons
            </p>
            {lessons.length === 0 ? (
              <p className="text-[11px] text-[var(--color-muted-3)]">No lessons in this module.</p>
            ) : (
              <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
                {lessons.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => navigate(paths.curriculumLesson(courseId, l.id))}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--color-raised)] transition-colors flex items-center gap-4"
                  >
                    <span className="text-[11px] font-mono text-[var(--color-muted-3)] w-8 shrink-0">
                      {String(l.globalOrder).padStart(2, '0')}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-[var(--color-text)] truncate">{l.title}</span>
                      <span className="block text-[11px] text-[var(--color-muted-3)] mt-0.5">
                        {l.shortScript ? 'script ✓' : 'no script'} · {l.knowledgeCheck.length} KC
                      </span>
                    </span>
                    <TagBadge label={l.status} color={statusColor(l.status)} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Project panel */}
          {project && (
            <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-4">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
                Capstone project — {project.title}
              </p>
              <div className="space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                  Objective
                </p>
                <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{project.objective}</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                  Outcome
                </p>
                <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{project.outcome}</p>
              </div>
              {project.steps.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                    Steps
                  </p>
                  <ol className="space-y-2">
                    {project.steps
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((s) => (
                        <li key={s.order} className="text-sm text-[var(--color-text)]">
                          <span className="font-mono text-[var(--color-muted-3)] mr-2">
                            {String(s.order).padStart(2, '0')}
                          </span>
                          <span className="font-semibold">{s.title}</span>
                          {s.detail && (
                            <span className="block text-[12px] text-[var(--color-muted-2)] mt-0.5 pl-8 whitespace-pre-wrap">
                              {s.detail}
                            </span>
                          )}
                        </li>
                      ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
