import { useState } from 'react'
import type { CurriculumStatus } from '../lib/types'

const STATUS_COLOR: Record<CurriculumStatus, string> = {
  draft: 'var(--color-muted-2)',
  planning: 'var(--color-orange)',
  planned: 'var(--color-blue)',
  producing: 'var(--color-orange)',
  active: 'var(--color-lime)',
  completed: 'var(--color-lime)',
  archived: 'var(--color-muted-3)'
}

/** Course lifecycle badge — matches the house `StatusBadge` look in primitives.tsx
 *  but keyed on the 7-value CurriculumStatus rather than ReviewItemStatus. */
export function CourseStatusBadge({ status }: { status: CurriculumStatus }) {
  const color = STATUS_COLOR[status] ?? 'var(--color-muted-2)'
  return (
    <span
      className="text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-widest border"
      style={{ color, borderColor: color + '44', backgroundColor: color + '11' }}
    >
      {status}
    </span>
  )
}

/** Generic labelled micro-badge for the smaller content/module status enums. */
export function TagBadge({ label, color = 'var(--color-muted-2)' }: { label: string; color?: string }) {
  return (
    <span
      className="text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-widest border"
      style={{ color, borderColor: color + '44', backgroundColor: color + '11' }}
    >
      {label}
    </span>
  )
}

/** Labelled 0–100 progress bar with the percent figure alongside the label. */
export function ScorePctBar({
  label,
  pct,
  color = 'var(--color-lime)'
}: {
  label: string
  pct: number
  color?: string
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
          {label}
        </span>
        <span className="text-[10px] font-mono text-[var(--color-muted-2)]">{clamped}%</span>
      </div>
      <div className="h-1 bg-[var(--color-faint)] overflow-hidden">
        <div
          className="h-full transition-all duration-700"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

/** Split a comma-separated field into a trimmed, non-empty string list. */
export const splitComma = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean)

/** Split a newline-separated field (one item per line) into a trimmed list. */
export const splitLines = (s: string): string[] =>
  s.split('\n').map((x) => x.trim()).filter(Boolean)

/**
 * Inline text/textarea editor. Renders the current value read-only with an
 * "Edit" toggle; on save it awaits `onSave(next)` (which is expected to PATCH
 * the backend and reload) and only then leaves edit mode. A rejected save shows
 * the server error and keeps the draft open. `mono` renders the textarea in a
 * monospace face and, when set, the raw draft is passed to `onSave` untrimmed.
 */
export function InlineEdit({
  label,
  value,
  onSave,
  multiline = false,
  mono = false,
  placeholder
}: {
  label: string
  value: string
  onSave: (next: string) => Promise<void>
  multiline?: boolean
  mono?: boolean
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function begin() {
    setDraft(value)
    setError(null)
    setEditing(true)
  }

  async function save() {
    if (draft === value) {
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(draft)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
          {label}
        </span>
        {!editing && (
          <button
            type="button"
            onClick={begin}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-3)] hover:text-[var(--color-lime)] transition-colors"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          {multiline ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              className={[
                'w-full min-h-24 bg-[var(--color-bg)] border border-[var(--color-input)] p-2 text-sm',
                mono ? 'font-mono' : ''
              ].join(' ')}
            />
          ) : (
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] p-2 text-sm"
            />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest transition-colors hover:brightness-110 disabled:opacity-50"
              style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
        </div>
      ) : (
        <p
          className={[
            'text-sm text-[var(--color-text)] whitespace-pre-wrap break-words',
            mono ? 'font-mono' : ''
          ].join(' ')}
        >
          {value ? value : <span className="text-[var(--color-muted-3)]">—</span>}
        </p>
      )}
    </div>
  )
}

/**
 * A single field-granular regenerate action. Owns only its label/press; the
 * caller passes `busy`/`error` so an in-flight call disables just this button
 * and a failure renders inline beneath it without disturbing the view.
 */
export function RegenButton({
  label,
  onClick,
  busy,
  error
}: {
  label: string
  onClick: () => void
  busy: boolean
  error?: string | null
}) {
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        className="px-4 py-2 text-[11px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
      >
        {busy ? 'Working…' : label}
      </button>
      {error && <p className="text-[11px] text-[var(--color-red)]">{error}</p>}
    </div>
  )
}
