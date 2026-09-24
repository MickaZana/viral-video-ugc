import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import { PlatformBadge, StatusBadge, formatRelative } from '../components/primitives'

/**
 * This Week — cadence home. Vanity stats live on Intel; this page is quota +
 * the single next action (start a run, or review what is waiting), plus a
 * compact recent-activity feed so home isn't just numbers — the most recent
 * finished/queued items are one click from here, mirroring the review board's
 * inline-preview pattern.
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
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null)

  const recent = [...items]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6)

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

      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Recent activity</p>
        {recent.length === 0 ? (
          !queue.loading && (
            <p className="text-[11px] text-[var(--color-muted-3)]">No activity yet — start a run to see it here.</p>
          )
        ) : (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
            {recent.map((item) => (
              <div key={item.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  {!item.dryRun && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreviewVideoId(previewVideoId === item.id ? null : item.id)
                      }}
                      className="shrink-0 w-9 h-12 rounded-lg bg-black/60 border border-[var(--color-border)] flex items-center justify-center hover:border-[var(--color-blue)] hover:shadow-lg hover:shadow-[var(--color-blue)]/20 transition-all group/play"
                      title="Preview video"
                    >
                      <span className="text-[var(--color-muted-3)] group-hover/play:text-[var(--color-blue)] text-base transition-colors">▶</span>
                    </button>
                  )}
                  <button onClick={() => navigate(paths.reviewItem(item.id))} className="text-left flex-1 min-w-0">
                    <p className="text-sm text-[var(--color-text)] truncate">{item.script.hook}</p>
                    <div className="flex items-center gap-2 flex-wrap mt-1.5">
                      <PlatformBadge platform={item.platform} />
                      <StatusBadge status={item.status} />
                      <span className="text-[10px] text-[var(--color-muted-3)]">{formatRelative(item.createdAt)}</span>
                    </div>
                  </button>
                </div>
                {previewVideoId === item.id && !item.dryRun && (
                  <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                    <video
                      src={api.mediaUrl(item.id)}
                      controls
                      autoPlay
                      className="w-full max-h-[280px] rounded-lg bg-black object-contain"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {(queue.error || runs.error) && (
        <p className="text-[11px] text-[var(--color-red)]">Load error: {queue.error || runs.error}</p>
      )}
    </div>
  )
}
