import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { paths } from '../lib/paths'
import type { CreateCurriculumCourseInput, GeneratePlanResult } from '../lib/types'

const MIN_LEN = 3

interface FormState {
  title: string
  topic: string
  audience: string
  endGoal: string
  description: string
  startingKnowledge: string
  moduleCount: number
  lessonsPerModule: number
  shortDurationSec: number
  longFormTargetMin: number
  maxGenerationSpendUsd: string
  useStarter: boolean
}

const INITIAL: FormState = {
  title: '',
  topic: '',
  audience: '',
  endGoal: '',
  description: '',
  startingKnowledge: '',
  moduleCount: 20,
  lessonsPerModule: 10,
  shortDurationSec: 60,
  longFormTargetMin: 12,
  maxGenerationSpendUsd: '',
  useStarter: false
}

const TEXT_FIELDS = [
  { key: 'title', label: 'Title', placeholder: 'Agentic AI, from first principles' },
  { key: 'topic', label: 'Topic', placeholder: 'Building and shipping AI agents' },
  { key: 'audience', label: 'Audience', placeholder: 'Working software engineers new to LLMs' },
  { key: 'endGoal', label: 'End goal', placeholder: 'Ship a production agent with tools, memory and evals' }
] as const

const NUMBER_FIELDS = [
  { key: 'moduleCount', label: 'Modules', min: 1, max: 50 },
  { key: 'lessonsPerModule', label: 'Lessons / module', min: 1, max: 20 },
  { key: 'shortDurationSec', label: 'Short video (sec)', min: 15, max: 180 },
  { key: 'longFormTargetMin', label: 'Long-form target (min)', min: 3, max: 60 }
] as const

type NumberKey = (typeof NUMBER_FIELDS)[number]['key']

interface PlanSummary {
  counts: GeneratePlanResult['counts']
  warnings: string[]
  courseId: string
}

/**
 * `/curriculum/courses/new` — a single-page form that builds a
 * CreateCurriculumCourseInput. When "starter outline" is checked it also runs
 * `generateCurriculumPlan(id, { seed: 'agentic-ai' })` and surfaces the plan
 * counts + QA warnings before handing off to the course page.
 */
export function CourseWizard() {
  const navigate = useNavigate()
  const [state, setState] = useState<FormState>(INITIAL)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<PlanSummary | null>(null)

  function setText(key: keyof FormState, value: string) {
    setState((s) => ({ ...s, [key]: value }))
  }
  function setNumber(key: NumberKey, value: string) {
    setState((s) => ({ ...s, [key]: Number(value) }))
  }

  function validate(): Partial<Record<keyof FormState, string>> {
    const next: Partial<Record<keyof FormState, string>> = {}
    for (const field of TEXT_FIELDS) {
      if (state[field.key].trim().length < MIN_LEN) {
        next[field.key] = `Enter at least ${MIN_LEN} characters.`
      }
    }
    for (const field of NUMBER_FIELDS) {
      const value = state[field.key]
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        next[field.key] = `Must be a whole number ${field.min}–${field.max}.`
      }
    }
    const spend = state.maxGenerationSpendUsd.trim()
    if (spend !== '') {
      const parsed = Number(spend)
      if (!Number.isFinite(parsed) || parsed < 0) {
        next.maxGenerationSpendUsd = 'Enter a positive dollar amount, or leave blank for no cap.'
      }
    }
    return next
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setServerError(null)
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const spend = state.maxGenerationSpendUsd.trim()
    const knowledge = state.startingKnowledge
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const body: CreateCurriculumCourseInput = {
      title: state.title.trim(),
      topic: state.topic.trim(),
      audience: state.audience.trim(),
      endGoal: state.endGoal.trim(),
      moduleCount: state.moduleCount,
      lessonsPerModule: state.lessonsPerModule,
      shortDurationSec: state.shortDurationSec,
      longFormTargetMin: state.longFormTargetMin,
      maxGenerationSpendUsd: spend === '' ? null : Number(spend)
    }
    const description = state.description.trim()
    if (description) body.description = description
    if (knowledge.length > 0) body.startingKnowledge = knowledge

    setBusy(true)
    try {
      const { course } = await api.createCurriculum(body)
      if (state.useStarter) {
        const plan = await api.generateCurriculumPlan(course.id, { seed: 'agentic-ai' })
        const warnings = plan.qa.warnings.map((w) => w.message)
        if (warnings.length > 0) {
          setSummary({ counts: plan.counts, warnings, courseId: course.id })
          return
        }
      }
      navigate(paths.curriculumCourse(course.id))
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (summary) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="border border-[var(--color-lime)] bg-[var(--color-surface)] p-6 space-y-4">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
            Starter plan generated
          </p>
          <div className="flex flex-wrap gap-6">
            {[
              { label: 'Modules', value: summary.counts.modules },
              { label: 'Lessons', value: summary.counts.lessons },
              { label: 'Projects', value: summary.counts.projects }
            ].map((c) => (
              <div key={c.label}>
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
                  {c.label}
                </p>
                <p className="text-2xl font-black font-mono text-[var(--color-text)] mt-1">{c.value}</p>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-orange)]">
              {summary.warnings.length} QA warning{summary.warnings.length === 1 ? '' : 's'}
            </p>
            <ul className="list-disc pl-5 space-y-1">
              {summary.warnings.map((w, i) => (
                <li key={i} className="text-[12px] text-[var(--color-muted-2)]">
                  {w}
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => navigate(paths.curriculumCourse(summary.courseId))}
            className="px-6 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            View course →
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5">
      <button
        type="button"
        onClick={() => navigate(paths.curriculumCourses)}
        className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        ← All courses
      </button>

      {TEXT_FIELDS.map((field) => (
        <Field key={field.key} label={field.label} error={errors[field.key]}>
          <input
            value={state[field.key]}
            onChange={(e) => setText(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm"
          />
        </Field>
      ))}

      <Field label="Description (optional)">
        <textarea
          value={state.description}
          onChange={(e) => setText('description', e.target.value)}
          placeholder="What this course covers and why it exists."
          className="w-full min-h-24 bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm"
        />
      </Field>

      <Field label="Starting knowledge (comma-separated)">
        <input
          value={state.startingKnowledge}
          onChange={(e) => setText('startingKnowledge', e.target.value)}
          placeholder="Python, HTTP APIs, basic Git"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBER_FIELDS.map((field) => (
          <Field key={field.key} label={`${field.label} (${field.min}–${field.max})`} error={errors[field.key]}>
            <input
              type="number"
              min={field.min}
              max={field.max}
              value={state[field.key]}
              onChange={(e) => setNumber(field.key, e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm font-mono"
            />
          </Field>
        ))}
        <Field label="Max generation spend USD (optional)" error={errors.maxGenerationSpendUsd}>
          <input
            type="number"
            min={0}
            step="0.01"
            value={state.maxGenerationSpendUsd}
            onChange={(e) => setText('maxGenerationSpendUsd', e.target.value)}
            placeholder="No cap"
            className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] p-3 text-sm font-mono"
          />
        </Field>
      </div>

      <label className="flex items-start gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 cursor-pointer">
        <input
          type="checkbox"
          checked={state.useStarter}
          onChange={(e) => setState((s) => ({ ...s, useStarter: e.target.checked }))}
          className="mt-0.5"
        />
        <span className="text-[12px] text-[var(--color-muted-2)]">
          Use the &lsquo;Agentic AI Simplified&rsquo; starter outline — generates a full module &amp;
          lesson plan right after the course is created.
        </span>
      </label>

      {serverError && <p className="text-[11px] text-[var(--color-red)]">{serverError}</p>}

      <button
        type="submit"
        disabled={busy}
        className="px-8 py-3 text-sm font-black uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
        style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
      >
        {busy ? 'Creating…' : 'Create course'}
      </button>
    </form>
  )
}

function Field({
  label,
  error,
  children
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
        {label}
      </span>
      {children}
      {error && <span className="block text-[11px] text-[var(--color-red)]">{error}</span>}
    </label>
  )
}
