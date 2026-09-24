import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { CurriculumLessonPatch, KnowledgeCheckQuestion, LessonScriptResult } from '../lib/types'
import { InlineEdit, RegenButton, TagBadge, splitComma } from './parts'

const CONTENT_STATUS_COLOR: Record<string, string> = {
  draft: 'var(--color-muted-2)',
  approved: 'var(--color-blue)',
  scripted: 'var(--color-blue)',
  queued: 'var(--color-orange)',
  generated: 'var(--color-orange)',
  review: 'var(--color-orange)',
  published: 'var(--color-lime)'
}
const statusColor = (s: string) => CONTENT_STATUS_COLOR[s] ?? 'var(--color-muted-2)'

/**
 * `/curriculum/courses/:courseId/lessons/:lessonId` — lesson content editor
 * with field-granular inline edits (§18) and the two regenerate actions
 * (short script + knowledge check), each surfacing its own busy/error state
 * and, for the script, the similarity report.
 */
export function LessonView() {
  const { courseId = '', lessonId = '' } = useParams<{ courseId: string; lessonId: string }>()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useApi(
    () => api.curriculumLesson(courseId, lessonId),
    [courseId, lessonId]
  )

  const [scriptBusy, setScriptBusy] = useState(false)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [similarity, setSimilarity] = useState<LessonScriptResult['similarity'] | null>(null)
  const [kcBusy, setKcBusy] = useState(false)
  const [kcError, setKcError] = useState<string | null>(null)

  const save = (patch: CurriculumLessonPatch) =>
    api.updateCurriculumLesson(courseId, lessonId, patch).then(() => reload())

  async function regenerateScript() {
    setScriptBusy(true)
    setScriptError(null)
    try {
      const result = await api.generateLessonScript(courseId, lessonId)
      setSimilarity(result.similarity)
      reload()
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : String(err))
    } finally {
      setScriptBusy(false)
    }
  }

  async function regenerateKnowledgeCheck() {
    setKcBusy(true)
    setKcError(null)
    try {
      await api.generateLessonKnowledgeCheck(courseId, lessonId, { count: 3 })
      reload()
    } catch (err) {
      setKcError(err instanceof Error ? err.message : String(err))
    } finally {
      setKcBusy(false)
    }
  }

  const lesson = data?.lesson

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() =>
          lesson
            ? navigate(paths.curriculumModule(courseId, lesson.moduleId))
            : navigate(paths.curriculumCourse(courseId))
        }
        className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        ← Module
      </button>

      {loading && !lesson && <p className="text-[11px] text-[var(--color-muted-3)]">Loading lesson…</p>}
      {error && <p className="text-[11px] text-[var(--color-red)]">Load error: {error}</p>}

      {lesson && (
        <>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[var(--color-muted-3)]">
              Lesson #{lesson.globalOrder} · module {lesson.moduleOrder}.{lesson.lessonOrder}
            </span>
            <TagBadge label={lesson.status} color={statusColor(lesson.status)} />
          </div>

          {/* Editable content fields (§18) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5">
            <InlineEdit label="Title" value={lesson.title} onSave={(next) => save({ title: next })} />
            <InlineEdit
              label="Learning objective"
              value={lesson.learningObjective}
              multiline
              onSave={(next) => save({ learningObjective: next })}
            />
            <InlineEdit
              label="Explanation"
              value={lesson.explanation ?? ''}
              multiline
              onSave={(next) => save({ explanation: next })}
            />
            <InlineEdit
              label="Example"
              value={lesson.example ?? ''}
              multiline
              onSave={(next) => save({ example: next })}
            />
            <InlineEdit
              label="Exercise"
              value={lesson.exercise ?? ''}
              multiline
              onSave={(next) => save({ exercise: next })}
            />
            <InlineEdit
              label="Key takeaway"
              value={lesson.keyTakeaway ?? ''}
              multiline
              onSave={(next) => save({ keyTakeaway: next })}
            />
            <InlineEdit
              label="Next lesson hook"
              value={lesson.nextLessonHook ?? ''}
              multiline
              onSave={(next) => save({ nextLessonHook: next })}
            />
            <InlineEdit
              label="Visual plan"
              value={lesson.visualPlan ?? ''}
              multiline
              onSave={(next) => save({ visualPlan: next })}
            />
            <InlineEdit
              label="Code example"
              value={lesson.codeExample ?? ''}
              multiline
              mono
              onSave={(next) => save({ codeExample: next })}
            />
            <InlineEdit
              label="Concepts (comma-separated)"
              value={lesson.concepts.join(', ')}
              onSave={(next) => save({ concepts: splitComma(next) })}
            />
            <InlineEdit
              label="Prerequisites (comma-separated)"
              value={lesson.prerequisites.join(', ')}
              onSave={(next) => save({ prerequisites: splitComma(next) })}
            />
          </div>

          {/* Regenerate actions (§18) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Regenerate
            </p>
            <div className="flex flex-wrap gap-3">
              <RegenButton
                label="Regenerate short script"
                onClick={regenerateScript}
                busy={scriptBusy}
                error={scriptError}
              />
              <RegenButton
                label="Regenerate knowledge check"
                onClick={regenerateKnowledgeCheck}
                busy={kcBusy}
                error={kcError}
              />
            </div>

            {similarity && (
              <div
                className="border p-3 space-y-1"
                style={{
                  borderColor: similarity.flagged ? 'var(--color-orange)' : 'var(--color-border)'
                }}
              >
                {similarity.flagged ? (
                  <p className="text-[12px] text-[var(--color-orange)]">
                    High similarity ({Math.round(similarity.maxPct)}%)
                    {similarity.nearestLessonGlobalOrder !== null
                      ? ` to lesson #${similarity.nearestLessonGlobalOrder}`
                      : ''}{' '}
                    — review for repetition.
                  </p>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted-2)]">
                    Similarity {Math.round(similarity.maxPct)}%
                    {similarity.nearestLessonGlobalOrder !== null
                      ? ` (nearest: lesson #${similarity.nearestLessonGlobalOrder})`
                      : ''}{' '}
                    — within range.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Short-script panel */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
                Short script
              </p>
              <TagBadge label={lesson.status} color={statusColor(lesson.status)} />
            </div>
            {lesson.shortScript ? (
              <pre className="max-h-96 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] p-3 text-[12px] font-mono whitespace-pre-wrap text-[var(--color-text)]">
                {lesson.shortScript}
              </pre>
            ) : (
              <p className="text-[11px] text-[var(--color-muted-3)]">
                No short script yet — use “Regenerate short script” above.
              </p>
            )}
          </div>

          {/* Knowledge-check panel (read-only in this unit) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Knowledge check ({lesson.knowledgeCheck.length})
            </p>
            {lesson.knowledgeCheck.length === 0 ? (
              <p className="text-[11px] text-[var(--color-muted-3)]">No questions yet.</p>
            ) : (
              <ol className="space-y-4">
                {lesson.knowledgeCheck.map((q, i) => (
                  <QuestionCard key={i} q={q} />
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function QuestionCard({ q }: { q: KnowledgeCheckQuestion }) {
  return (
    <li className="border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        <TagBadge label={q.kind} color="var(--color-blue)" />
      </div>
      <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{q.prompt}</p>
      {q.options.length > 0 && (
        <ol className="space-y-1">
          {q.options.map((opt, i) => {
            const correct = q.answerIndex === i
            return (
              <li
                key={i}
                className="text-[13px]"
                style={{ color: correct ? 'var(--color-lime)' : 'var(--color-muted-2)' }}
              >
                <span className="font-mono mr-2">{i + 1}.</span>
                {opt}
                {correct && <span className="ml-2 font-mono text-[10px] uppercase">✓ answer</span>}
              </li>
            )
          })}
        </ol>
      )}
      {q.rationale && (
        <p className="text-[12px] text-[var(--color-muted-3)] whitespace-pre-wrap">
          Rationale: {q.rationale}
        </p>
      )}
    </li>
  )
}
