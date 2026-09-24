import { useNavigate } from 'react-router-dom'
import { paths } from '../lib/paths'
import { useState, useCallback } from 'react'
import type { ReviewItem, RunSummary } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar, StatusBadge, formatCompact, formatRelative, formatUsd } from '../components/primitives'
import {
  exportSingleItemJson,
  exportSingleItemScript,
  downloadSingleVideo,
  exportBulkItemsJson,
  exportBulkItemsCsv,
  downloadBulkVideos,
  exportRunsJson
} from '../lib/export'

import { EmptyState } from '../components/EmptyState'
import { ReviewModal } from '../components/ReviewModal'
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
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const items = queue.data ?? []
  const runList = runs.data ?? []
  const [reviewItem, setReviewItem] = useState<ReviewItem | null>(null)
  const byRun = new Map(runList.map((r) => [r.runId, r]))
  const [cat, setCat] = useState<Category>('videos')

  // Show ALL items in the Videos tab, sorted so pending (needs review) comes
  // first — this makes the review queue visible to logged-in users without
  // requiring the separate Basic Auth operator dashboard.
  const STATUS_ORDER: Record<ReviewItem['status'], number> = { pending: 0, approved: 1, rejected: 2 }
  const videos = [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const scripts = items

  const counts: Record<Category, number> = {
    videos: videos.length,
    scripts: scripts.length,
    workflows: runList.length
  }

  const handleApprove = useCallback(async (id: string) => {
    setActionLoading(id + ':approve')
    try { await api.approve(id); queue.reload() } catch { /* ignore */ }
    finally { setActionLoading(null) }
  }, [queue])

  const handleReject = useCallback(async (id: string) => {
    setActionLoading(id + ':reject')
    try { await api.reject(id); queue.reload() } catch { /* ignore */ }
    finally { setActionLoading(null) }
  }, [queue])

  const handleDownload = useCallback((id: string) => {
    downloadSingleVideo(id)
  }, [])

  return (
    <div className="space-y-6">
      {/* Top bar: Category switcher + Bulk Export Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="toolbar-row flex flex-wrap gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] p-1 max-w-xl w-full">
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

        {/* Global Export Toolbar */}
        <div className="flex items-center gap-2">
          {cat === 'workflows' ? (
            <button
              onClick={() => exportRunsJson(runList)}
              disabled={runList.length === 0}
              className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors disabled:opacity-40"
              title="Export all workflow run logs as JSON"
            >
              ↓ Export Runs (JSON)
            </button>
          ) : (
            <>
              <button
                onClick={() => exportBulkItemsJson(items, `vvugc_${cat}`)}
                disabled={items.length === 0}
                className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors disabled:opacity-40"
                title="Export all items as JSON"
              >
                ↓ Export All (JSON)
              </button>
              <button
                onClick={() => exportBulkItemsCsv(items, `vvugc_${cat}`)}
                disabled={items.length === 0}
                className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors disabled:opacity-40"
                title="Export all items as CSV spreadsheet"
              >
                ↓ Export CSV
              </button>
              {cat === 'videos' && (
                <button
                  onClick={() => downloadBulkVideos(videos)}
                  disabled={videos.filter(v => Boolean(v.videoPath)).length === 0}
                  className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-40"
                  title="Download all rendered MP4 videos"
                >
                  ↓ Bulk Download Videos
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {queue.loading && items.length === 0 && (
        <div className="p-8 border border-[var(--color-border)] bg-[var(--color-surface)] text-center text-xs font-mono text-[var(--color-muted-2)] uppercase tracking-widest animate-pulse">
          Loading library assets &amp; demos…
        </div>
      )}

      {cat === 'videos' && <VideoDemos items={videos} onPreview={setReviewItem} onApprove={handleApprove} onReject={handleReject} actionLoading={actionLoading} />}
      {cat === 'scripts' && <ScriptDemos items={scripts} byRun={byRun} onApprove={handleApprove} onReject={handleReject} actionLoading={actionLoading} onPreview={setReviewItem} />}
      {cat === 'workflows' && <WorkflowDemos runs={runList} />}

      {(queue.error || runs.error) && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">
          Load error: {queue.error || runs.error}
        </p>
      )}

      {reviewItem && (
        <ReviewModal
          item={reviewItem}
          onClose={() => setReviewItem(null)}
          onApprove={() => { setReviewItem(null); queue.reload() }}
          onReject={() => { setReviewItem(null); queue.reload() }}
          onDownload={handleDownload}
        />
      )}
    </div>
  )
}

function VideoDemos({ items, onPreview, onApprove, onReject, actionLoading }: {
  items: ReviewItem[]
  onPreview: (item: ReviewItem) => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  actionLoading: string | null
}) {
  const navigate = useNavigate()
  const pendingCount = items.filter(i => i.status === 'pending').length
  return (
    <Panel
      title="MY VIDEOS"
      action={
        <span className="text-[10px] font-mono" style={{ color: pendingCount > 0 ? 'var(--color-orange)' : 'var(--color-muted-4)' }}>
          {pendingCount > 0 ? `${pendingCount} awaiting review` : `${items.length} total`}
        </span>
      }
    >
      <div className="divide-y divide-[var(--color-raised)]">
        {items.map((v) => (
          <div key={v.id} className="px-5 py-4 flex flex-wrap items-center gap-4 cursor-pointer hover:bg-[var(--color-raised)] transition-colors" onClick={() => onPreview(v)}>
            {/* Status band — colour-coded so pending items are immediately visible */}
            <div
              className="w-1 self-stretch rounded-sm shrink-0"
              style={{
                backgroundColor:
                  v.status === 'pending'  ? 'var(--color-orange)' :
                  v.status === 'approved' ? 'var(--color-lime)'   : 'var(--color-red)'
              }}
            />
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
            {/* Inline actions: approve/reject + single download/export buttons */}
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              {v.status === 'pending' && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove(v.id) }}
                    disabled={actionLoading === v.id + ':approve'}
                    className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
                    title="Approve for production"
                  >
                    {actionLoading === v.id + ':approve' ? '...' : '✓ APPROVE'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject(v.id) }}
                    disabled={actionLoading === v.id + ':reject'}
                    className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
                    title="Reject"
                  >
                    {actionLoading === v.id + ':reject' ? '...' : '✗ REJECT'}
                  </button>
                </>
              )}
              {v.videoPath && (
                <button
                  onClick={() => downloadSingleVideo(v.id)}
                  className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors"
                  title="Download MP4 Video"
                >
                  ↓ MP4
                </button>
              )}
              <button
                onClick={() => exportSingleItemScript(v)}
                className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-border)] text-[var(--color-muted-2)] hover:border-[var(--color-text)] hover:text-[var(--color-text)] transition-colors"
                title="Export Script as TXT"
              >
                ↓ SCRIPT
              </button>
              <button
                onClick={() => exportSingleItemJson(v)}
                className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-border)] text-[var(--color-muted-2)] hover:border-[var(--color-text)] hover:text-[var(--color-text)] transition-colors"
                title="Export Full JSON Data"
              >
                ↓ JSON
              </button>
            </div>
            <span className="text-[10px] font-mono text-[var(--color-muted-4)] w-16 text-right">
              {formatRelative(v.createdAt)}
            </span>
          </div>
        ))}
        {items.length === 0 && (
          <EmptyState
            icon="▶"
            title="NO VIDEOS YET"
            description="Run a pipeline from the Video Generator to produce your first batch. Pending videos will appear here for you to approve or reject."
            actionLabel="RUN PIPELINE"
            onAction={() => navigate(paths.studio)}
          />
        )}
      </div>
    </Panel>
  )
}

function ScriptDemos({ items, byRun, onApprove, onReject, actionLoading, onPreview }: {
  items: ReviewItem[];
  byRun: Map<string, RunSummary>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  actionLoading: string | null;
  onPreview: (item: ReviewItem) => void;
}) {
  const navigate = useNavigate()
  return (
    <Panel
      title="SCRIPT DEMOS"
      action={<span className="text-[10px] font-mono text-[var(--color-muted-4)]">{items.length} rewritten</span>}
    >
      <div className="divide-y divide-[var(--color-raised)]">
        {items.map((v) => {
          const run = byRun.get(v.runId)
          return (
            <div
              key={v.id}
              className="px-5 py-4 flex flex-wrap items-center gap-4 cursor-pointer hover:bg-[var(--color-raised)] transition-colors"
              onClick={() => onPreview(v)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono text-[var(--color-text)]">{v.script.hook}</p>
                <p className="text-[10px] font-mono text-[var(--color-muted-4)] mt-0.5">
                  {v.runId} · {run?.platforms.join(', ') ?? ''}
                </p>
              </div>
              <span className="text-[11px] font-mono text-[var(--color-muted-2)]">{v.niche}</span>
              <PlatformBadge platform={v.platform} />
              <StatusBadge status={v.status} />
              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {v.status === 'pending' && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); onPreview(v) }}
                      className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-faint)] text-[var(--color-muted-4)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors"
                      title="Preview before deciding"
                    >
                      👁 REVIEW
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onApprove(v.id) }}
                      disabled={actionLoading === v.id + ':approve'}
                      className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
                      title="Approve for production"
                    >
                      {actionLoading === v.id + ':approve' ? '...' : '✓ APPROVE'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onReject(v.id) }}
                      disabled={actionLoading === v.id + ':reject'}
                      className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
                      title="Reject"
                    >
                      {actionLoading === v.id + ':reject' ? '...' : '✗ REJECT'}
                    </button>
                  </>
                )}
                {v.videoPath && (
                  <button
                    onClick={() => downloadSingleVideo(v.id)}
                    className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors"
                    title="Download MP4 video"
                  >
                    ↓ MP4
                  </button>
                )}
                <button
                  onClick={() => exportSingleItemScript(v)}
                  className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-border)] text-[var(--color-muted-2)] hover:border-[var(--color-text)] hover:text-[var(--color-text)] transition-colors"
                  title="Export Script TXT"
                >
                  ↓ SCRIPT
                </button>
                <button
                  onClick={() => exportSingleItemJson(v)}
                  className="text-[9px] font-mono uppercase tracking-widest px-2 py-1 border border-[var(--color-border)] text-[var(--color-muted-2)] hover:border-[var(--color-text)] hover:text-[var(--color-text)] transition-colors"
                  title="Export JSON"
                >
                  ↓ JSON
                </button>
              </div>
              <span className="text-[10px] font-mono text-[var(--color-muted-4)] w-16 text-right">
                {formatRelative(v.createdAt)}
              </span>
            </div>
          )
        })}
        {items.length === 0 && (
          <EmptyState
            icon="⌥"
            title="NO REWRITTEN SCRIPTS"
            description="Use the Script Rewriter to regenerate viral scripts for your niche, or Remix a URL to auto-adapt a video."
            actionLabel="OPEN REWRITER"
            onAction={() => navigate(paths.studio)}
          />
        )}
      </div>
    </Panel>
  )
}

function WorkflowDemos({ runs }: { runs: RunSummary[] }) {
  const navigate = useNavigate()
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
          <EmptyState
            icon="↗"
            title="NO WORKFLOW RUNS"
            description="Launch a pipeline run from the Video Generator tab to see workflow executions here. Each run produces candidates for review."
            actionLabel="RUN PIPELINE"
            onAction={() => navigate(paths.studio)}
          />
        )}
      </div>
    </Panel>
  )
}
