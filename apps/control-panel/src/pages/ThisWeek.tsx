import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'

/**
 * This Week — cadence home. Vanity stats live on Intel; this page is quota +
 * the single next action (start a run, or review what is waiting).
 */
export function ThisWeek() {
  const navigate = useNavigate()
  const queue = useApi(() => api.queue())
  const runs = useApi(() => api.runs())
  const items = queue.data ?? []
  const runList = runs.data ?? []
  const pending = items.filter((i) => i.status === 'pending').length
  const finished = items.filter((i) => i.status === 'approved').length
  const platforms = new Set(items.map((i) => i.platform)).size

  return (
    <div className="space-y-6">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 flex flex-wrap items-center gap-6">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">This week</p>
          <p className="text-sm mt-1 text-[var(--color-text)]">
            <span className="font-mono text-[var(--color-lime)]">{finished}</span> finished
            <span className="text-[var(--color-muted-3)]"> / </span>
            <span className="font-mono">{platforms || 3}</span> platforms
          </p>
        </div>
        <div className="h-8 w-px bg-[var(--color-border)] hidden sm:block" />
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Runs</p>
          <p className="text-sm mt-1 font-mono text-[var(--color-text)]">{runList.length}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Waiting</p>
          <p className="text-sm mt-1 font-mono" style={{ color: pending > 0 ? 'var(--color-orange)' : 'var(--color-text)' }}>
            {pending}
          </p>
        </div>
      </div>

      {pending > 0 ? (
        <button
          onClick={() => navigate(paths.review)}
          className="px-6 py-3 text-sm font-semibold uppercase tracking-widest transition-colors hover:brightness-110"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          Review {pending} waiting
        </button>
      ) : (
        <button
          onClick={() => navigate(paths.studio)}
          className="px-6 py-3 text-sm font-semibold uppercase tracking-widest transition-colors hover:brightness-110"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          Start this week&apos;s run
        </button>
      )}

      {(queue.error || runs.error) && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {queue.error || runs.error}</p>
      )}
    </div>
  )
}