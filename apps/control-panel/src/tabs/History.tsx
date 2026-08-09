import { useState } from 'react'
import type { ReviewItem, RunSummary } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar, StatusBadge, formatCompact, formatRelative, formatUsd } from '../components/primitives'

type Category = 'videos' | 'scripts' | 'workflows'

const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'videos', label: 'VIDEO DEMOS', icon: '▶' },
  { id: 'scripts', label: 'SCRIPT DEMOS', icon: '⌥' },
  { id: 'workflows', label: 'WORKFLOW DEMOS', icon: '↗' }
]

/**
 * History — a tidy hub for everything the pipeline has produced, grouped into
 * three clean categories (video demos / script demos / workflow demos) so the
 * rest of the workspace stays focused on creation. Every row maps to real data
 * from the backend's /queue (review items) and /runs (workflow runs).
 */
export function History() {
  const queue = useApi(() => api.queue())
  const runs = useApi(() => api.runs())
  const items = queue.data ?? []
  const runList = runs.data ?? []
  const byRun = new Map(runList.map((r) => [r.runId, r]))
  const [cat, setCat] = useState<Category>('videos')

  // A "video demo" is a remake that reached a publishable state (approved or
  // already published). Script demos are every rewritten script in the queue.
  const videos = items.filter((i) => i.status === 'approved' || i.publishedAt)
  const scripts = items

  const counts: Record<Category, number> = {
    videos: videos.length,
    scripts: scripts.length,
    workflows: runList.length
  }

  return (
    <div className="space-y-6">
      {/* category switcher */}
      <div className="flex gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] p-1 max-w-xl">
        {CATS.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 transition-colors"
            style={{
              color: cat === c.id ? 'var(--color-on-accent)' : 'var(--color-muted-2)',
              backgroundColor: cat === c.id ? 'var(--color-lime)' : 'transparent'
            }}
          >
            <span className="text-xs">{c.icon}</span>
            <span className="text-[10px] font-mono uppercase tracking-widest">{c.label}</span>
            <span
              className="text-[10px] font-mono"
              style={{ color: cat === c.id ? 'var(--color-on-accent)' : 'var(--color-muted-4)' }}
            >
              {counts[c.id]}
            </span>
          </button>
        ))}
      </div>

      {cat === 'videos' && <VideoDemos items={videos} />}
      {cat === 'scripts' && <ScriptDemos items={scripts} byRun={byRun} />}
      {cat === 'workflows' && <WorkflowDemos runs={runList} />}

      {(queue.error || runs.error) && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">
          Load error: {queue.error || runs.error}
        </p>
      )}
    </div>
  )
}

function VideoDemos({ items }: { items: ReviewItem[] }) {
  return (
    <Panel
      title="VIDEO DEMOS"
      action={<span className="text-[10px] font-mono text-[var(--color-muted-4)]">{items.length} ready</span>}
    >
      <div className="divide-y divide-[var(--color-raised)]">
        {items.map((v) => (
          <div key={v.id} className="px-5 py-4 flex flex-wrap items-center gap-4">
            {v.videoPath ? (
              <video
                className="h-20 w-36 shrink-0 rounded-sm bg-black object-contain"
                controls
                preload="metadata"
                src={api.mediaUrl(v.id)}
                aria-label={`Play rendered video for ${v.script.hook}`}
              />
            ) : (
              <span className="text-sm text-[var(--color-muted-4)] shrink-0 w-9 text-center" aria-hidden="true">
                ·
              </span>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-[var(--color-text)]">{v.script.hook}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-4)] mt-0.5">
                {v.niche} · {v.videoPath ? 'rendered' : 'script + voiceover'}
              </p>
            </div>
            <PlatformBadge platform={v.platform} />
            <div className="w-24">
              <ScoreBar score={v.score} />
            </div>
            <StatusBadge status={v.status} />
            <span className="text-[10px] font-mono text-[var(--color-muted-4)] w-16 text-right">
              {formatRelative(v.createdAt)}
            </span>
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-6">
            No finished videos yet. Approve a remake to see it here.
          </p>
        )}
      </div>
    </Panel>
  )
}

function ScriptDemos({ items, byRun }: { items: ReviewItem[]; byRun: Map<string, RunSummary> }) {
  return (
    <Panel
      title="SCRIPT DEMOS"
      action={<span className="text-[10px] font-mono text-[var(--color-muted-4)]">{items.length} rewritten</span>}
    >
      <div className="divide-y divide-[var(--color-raised)]">
        {items.map((v) => {
          const run = byRun.get(v.runId)
          return (
            <div key={v.id} className="px-5 py-4 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono text-[var(--color-text)]">{v.script.hook}</p>
                <p className="text-[10px] font-mono text-[var(--color-muted-4)] mt-0.5">
                  {v.runId} · {run?.platforms.join(', ') ?? ''}
                </p>
              </div>
              <span className="text-[11px] font-mono text-[var(--color-muted-2)]">{v.niche}</span>
              <PlatformBadge platform={v.platform} />
              <StatusBadge status={v.status} />
              <span className="text-[10px] font-mono text-[var(--color-muted-4)] w-16 text-right">
                {formatRelative(v.createdAt)}
              </span>
            </div>
          )
        })}
        {items.length === 0 && (
          <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-6">
            No rewritten scripts yet. Use Script Rewriter or Remix to create one.
          </p>
        )}
      </div>
    </Panel>
  )
}

function WorkflowDemos({ runs }: { runs: RunSummary[] }) {
  return (
    <Panel
      title="WORKFLOW DEMOS"
      action={<span className="text-[10px] font-mono text-[var(--color-muted-4)]">{runs.length} runs</span>}
    >
      <div className="divide-y divide-[var(--color-raised)]">
        {runs.map((r) => (
          <div key={r.runId} className="px-5 py-4 flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-[var(--color-text)]">{r.niche}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-4)] mt-0.5">
                {r.runId} · {r.platforms.join(', ')}
              </p>
            </div>
            <div className="flex items-center gap-4 text-[11px] font-mono">
              <span className="text-[var(--color-muted-4)]">{formatCompact(r.candidatesFound)} candidates</span>
              <span className="text-[var(--color-lime)]">{r.reviewItemsCreated} queued</span>
              <span className="text-[var(--color-muted-2)]">{formatUsd(r.estimatedCostUsd)}</span>
            </div>
            <span className="text-[10px] font-mono text-[var(--color-muted-4)] w-20 text-right">
              {formatRelative(r.createdAt)}
            </span>
          </div>
        ))}
        {runs.length === 0 && (
          <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-6">
            No workflow runs yet. Launch a run to see it here.
          </p>
        )}
      </div>
    </Panel>
  )
}
