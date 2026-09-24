import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { KnowledgeCheckQuestion, LessonCompletion } from '../lib/types'
import { TagBadge } from './parts'

/**
 * `learn/:courseId/:lessonId` — the learner's view of a single lesson (§19).
 * Walks the lesson top to bottom the way a student reads it, renders the
 * knowledge check as answerable MCQs (concept/coding questions are shown but not
 * gradable), and lets the caller mark the lesson complete. Completion state is
 * read back from `api.curriculumProgress`; everything is real api.* data.
 */
export function LessonLearnView() {
  const { courseId = '', lessonId = '' } = useParams<{ courseId: string; lessonId: string }>()
  const navigate = useNavigate()

  const lessonState = useApi(() => api.curriculumLesson(courseId, lessonId), [courseId, lessonId])
  const progressState = useApi(() => api.curriculumProgress(courseId), [courseId])

  // question index -> chosen option index (MCQ only)
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [completion, setCompletion] = useState<LessonCompletion | null>(null)
  const [justCompleted, setJustCompleted] = useState(false)

  const lesson = lessonState.data?.lesson
  const prog = progressState.data
  const kc = lesson?.knowledgeCheck ?? []
  const hasKc = kc.length > 0

  // Best-effort "already completed" read from progress: the progress endpoint
  // exposes the caller's next uncompleted lesson (first by globalOrder) but no
  // completed-id set, so an in-order learner is detected here and any learner is
  // covered by `justCompleted` after they submit.
  const completedFromProgress =
    !!lesson &&
    !!prog &&
    (prog.learning.nextLesson === null ||
      lesson.globalOrder < prog.learning.nextLesson.globalOrder)
  const isComplete = justCompleted || completedFromProgress

  async function submit() {
    if (!lesson) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      let result
      if (hasKc) {
        // Positionally aligned to lesson.knowledgeCheck: one entry per question,
        // the chosen option index for an MCQ, -1 for concept/coding (which the
        // backend never grades — it only scores kind==="mcq" && answerIndex!==null).
        const answers = kc.map((q, i) => (q.kind === 'mcq' ? selected[i] ?? -1 : -1))
        result = await api.completeLesson(courseId, lessonId, { answers })
      } else {
        result = await api.completeLesson(courseId, lessonId, {})
      }
      setCompletion(result.completion)
      setJustCompleted(true)
      progressState.reload()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(paths.curriculumLearn)}
          className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
        >
          ← Back to Learn
        </button>
        <button
          type="button"
          onClick={() => navigate(paths.curriculumLesson(courseId, lessonId))}
          className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-3)] hover:text-[var(--color-lime)]"
        >
          Open full editor →
        </button>
      </div>

      {lessonState.loading && !lesson && (
        <p className="text-[11px] text-[var(--color-muted-3)]">Loading lesson…</p>
      )}
      {lessonState.error && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {lessonState.error}</p>
      )}

      {lesson && (
        <>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-[var(--color-muted-3)]">
                Lesson #{lesson.globalOrder} · module {lesson.moduleOrder}.{lesson.lessonOrder}
              </span>
              {isComplete ? (
                <TagBadge label="completed ✓" color="var(--color-lime)" />
              ) : (
                <TagBadge label="not yet completed" color="var(--color-muted-2)" />
              )}
            </div>
            <h3 className="text-2xl font-black uppercase text-[var(--color-text)]">{lesson.title}</h3>
          </div>

          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-6">
            <Section label="Learning objective">
              <Prose text={lesson.learningObjective} />
            </Section>

            {lesson.concepts.length > 0 && (
              <Section label="Concepts">
                <div className="flex flex-wrap gap-1.5">
                  {lesson.concepts.map((c) => (
                    <TagBadge key={c} label={c} color="var(--color-blue)" />
                  ))}
                </div>
              </Section>
            )}

            {lesson.explanation && (
              <Section label="Explanation">
                <Prose text={lesson.explanation} />
              </Section>
            )}

            {lesson.example && (
              <Section label="Example">
                <Prose text={lesson.example} />
              </Section>
            )}

            {lesson.exercise && (
              <Section label="Exercise">
                <Prose text={lesson.exercise} />
              </Section>
            )}

            {lesson.codeExample && (
              <Section label="Code example">
                <pre className="max-h-96 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] p-3 text-[12px] font-mono whitespace-pre-wrap text-[var(--color-text)]">
                  {lesson.codeExample}
                </pre>
              </Section>
            )}

            {lesson.keyTakeaway && (
              <Section label="Key takeaway">
                <Prose text={lesson.keyTakeaway} />
              </Section>
            )}

            {lesson.nextLessonHook && (
              <Section label="Next lesson hook">
                <Prose text={lesson.nextLessonHook} />
              </Section>
            )}
          </div>

          {/* Knowledge check (§19) */}
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 space-y-5">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
              Knowledge check{hasKc ? ` (${kc.length})` : ''}
            </p>

            {!hasKc && (
              <p className="text-[12px] text-[var(--color-muted-2)]">
                This lesson has no knowledge check — mark it complete when you have worked through it.
              </p>
            )}

            {hasKc && (
              <ol className="space-y-5">
                {kc.map((q, i) => (
                  <QuestionCard
                    key={i}
                    q={q}
                    index={i}
                    selected={selected[i]}
                    disabled={submitting || isComplete}
                    onSelect={(optionIndex) =>
                      setSelected((prev) => ({ ...prev, [i]: optionIndex }))
                    }
                  />
                ))}
              </ol>
            )}

            {isComplete ? (
              <div className="space-y-1">
                <p className="text-[13px] text-[var(--color-lime)]">Lesson complete ✓</p>
                {completion && completion.knowledgeCheckScore !== undefined && (
                  <p className="text-[12px] text-[var(--color-muted-2)]">
                    Knowledge-check score: {completion.knowledgeCheckScore}%
                  </p>
                )}
                {completion && completion.knowledgeCheckScore === undefined && hasKc && (
                  <p className="text-[12px] text-[var(--color-muted-3)]">
                    No gradable (MCQ) questions — no score recorded.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={submit}
                  className="px-5 py-2.5 text-[11px] font-mono uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                >
                  {submitting
                    ? 'Working…'
                    : hasKc
                      ? 'Submit & complete lesson'
                      : 'Mark lesson complete'}
                </button>
                {submitError && (
                  <p className="text-[11px] text-[var(--color-red)]">{submitError}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
        {label}
      </p>
      {children}
    </div>
  )
}

function Prose({ text }: { text: string }) {
  return (
    <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap break-words leading-relaxed">
      {text}
    </p>
  )
}

function QuestionCard({
  q,
  index,
  selected,
  disabled,
  onSelect
}: {
  q: KnowledgeCheckQuestion
  index: number
  selected: number | undefined
  disabled: boolean
  onSelect: (optionIndex: number) => void
}) {
  const gradable = q.kind === 'mcq' && q.options.length > 0
  return (
    <li className="border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-[var(--color-muted-3)]">{index + 1}.</span>
        <TagBadge label={q.kind} color="var(--color-blue)" />
      </div>
      <p className="text-sm text-[var(--color-text)] whitespace-pre-wrap">{q.prompt}</p>
      {gradable ? (
        <div className="space-y-1.5 pt-1">
          {q.options.map((opt, oi) => (
            <label
              key={oi}
              className="flex items-start gap-2 text-[13px] text-[var(--color-muted-2)] cursor-pointer"
            >
              <input
                type="radio"
                name={`kc-${index}`}
                checked={selected === oi}
                disabled={disabled}
                onChange={() => onSelect(oi)}
                className="mt-0.5"
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-[var(--color-muted-3)]">
          Reflective question — not auto-graded.
        </p>
      )}
    </li>
  )
}
