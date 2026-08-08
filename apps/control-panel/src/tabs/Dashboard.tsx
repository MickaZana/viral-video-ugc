import type { TrackedCreator } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar, StatCard, TrendIcon, formatCompact, formatRelative } from '../components/primitives'

/**
 * Dashboard — aggregates the real backend's /stats, /runs, /creators and /queue.
 * Nothing here is mocked: every number is derived from actual backend responses.
 */
export function Dashboard({ onOpenHistory }: { onOpenHistory?: () => void } = {}) {
  const stats = useApi(() => api.stats())
  const runs = useApi(() => api.runs())
  const creators = useApi(() => api.creators())
  const queue = useApi(() => api.queue())

  const items = queue.data ?? []
  const creatorList = creators.data ?? []
  const runList = runs.data ?? []

  // Average virality score across real queued items.
  const avgScore = items.length
    ? Math.round(items.reduce((s, i) => s + i.score, 0) / items.length)
    : 0
  // Sum of source views across tracked creators (real discovery metrics).
  const totalSourceViews = creatorList.reduce((s, c) => s + c.views, 0)

  const statCards = [
    { label: 'Creators Tracked', value: String(creatorList.length), sub: 'source videos discovered', accent: 'var(--color-lime)' },
    { label: 'Scripts Rewritten', value: String(items.length), sub: 'in review queue', accent: 'var(--color-lime)' },
    { label: 'Total Source Views', value: formatCompact(totalSourceViews), sub: 'across tracked creators', accent: 'var(--color-orange)' },
    { label: 'Avg Viral Score', value: String(avgScore), sub: 'queued items', accent: 'var(--color-lime)' }
  ]

  // Real activity log — derived from the backend's run history and queue.
  const activity: { time: string; msg: string; type: 'alert' | 'done' | 'scan' }[] = []
  const typeColor: Record<string, string> = { alert: 'var(--color-red)', done: 'var(--color-lime)', scan: 'var(--color-orange)' }
  for (const r of runList.slice(0, 3)) {
    if (r.reviewItemsCreated > 0) {
      activity.push({ time: formatRelative(r.createdAt), msg: `Run complete — ${r.reviewItemsCreated} item(s) queued (${r.niche})`, type: 'done' })
    } else if ((r.candidatesFailed ?? 0) > 0) {
      activity.push({ time: formatRelative(r.createdAt), msg: `Run ${r.runId} — ${r.candidatesFailed} candidate(s) failed`, type: 'alert' })
    } else {
      activity.push({ time: formatRelative(r.createdAt), msg: `Run ${r.runId} — ${r.niche}, ${r.candidatesFound} candidates`, type: 'scan' })
    }
  }
  for (const i of items.filter((x) => x.status === 'pending').slice(0, 3)) {
    activity.push({ time: formatRelative(i.createdAt), msg: `New review item — "${i.script.hook}" (${i.platform})`, type: 'alert' })
  }
  const topActivity = activity.slice(0, 6)

  return (
    <div className="space-y-8">
      {/* stat row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--color-border)]">
        {statCards.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} accent={s.accent} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* top creators */}
        <Panel
          title="TOP SOURCES BY VIEWS"
          className="lg:col-span-3"
          action={
            <span className="text-[10px] font-mono text-[var(--color-lime)] pulse-lime">● LIVE</span>
          }
        >
          <div>
            {creatorList.length === 0 && !creators.loading && (
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-4">No discovered sources yet.</p>
            )}
            {creatorList.slice(0, 4).map((c) => (
              <div
                key={c.platform + ':' + c.sourceId}
                className="flex items-center gap-4 px-5 py-3 border-b border-[var(--color-raised)] hover:bg-[var(--color-raised)] transition-colors"
              >
                <TrendIcon trend={c.views > 0 ? 'up' : 'neutral'} />
                <PlatformBadge platform={c.platform} />
                <span className="text-sm font-mono text-[var(--color-text)] flex-1 truncate">{c.label}</span>
                <div className="w-32 hidden sm:block">
                  <ScoreBar score={creatorScore(c)} />
                </div>
                <span className="text-[11px] font-mono text-[var(--color-muted-2)] w-16 text-right">{formatCompact(c.views)}</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* activity feed */}
        <Panel title="ACTIVITY LOG" className="lg:col-span-2">
          <div className="divide-y divide-[var(--color-raised)]">
            {topActivity.map((a, i) => (
              <div key={i} className="px-5 py-3 flex gap-3">
                <span className="text-[10px] font-mono text-[var(--color-muted-3)] mt-0.5 shrink-0">{a.time}</span>
                <span className="text-[11px] font-mono leading-relaxed" style={{ color: typeColor[a.type] }}>
                  {a.msg}
                </span>
              </div>
            ))}
            {topActivity.length === 0 && (
              <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-4">No activity recorded yet.</p>
            )}
          </div>
        </Panel>
      </div>

      {/* Completed work now lives in History; keep this surface focused on live
          creation and intelligence. */}
      <Panel
        title="WORKFLOW RUNS"
        action={
          <button
            onClick={() => onOpenHistory?.()}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)] hover:underline"
          >
            Open History ↗
          </button>
        }
      >
        <div className="px-5 py-4">
          <p className="text-[11px] font-mono text-[var(--color-muted-2)]">
            {runList.length} run(s) recorded — see them under History → Workflow Demos.
          </p>
        </div>
      </Panel>

      {(stats.error || runs.error || creators.error || queue.error) && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">
          Load error: {[stats.error, runs.error, creators.error, queue.error].find(Boolean)}
        </p>
      )}
    </div>
  )
}

/** Derive a 0-100 score from real metrics (velocity/views). Pure, deterministic. */
export function creatorScore(c: TrackedCreator): number {
  if (c.views <= 0) return 0
  const v = Math.log10(c.views)
  const velocityBoost = c.velocityScore > 0 ? Math.min(20, Math.log10(c.velocityScore + 1) * 3) : 0
  return Math.max(0, Math.min(100, Math.round(v * 14 + velocityBoost)))
}
