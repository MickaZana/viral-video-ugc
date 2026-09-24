import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReviewItem } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { EmptyState } from '../components/EmptyState'
import { ReviewModal } from '../components/ReviewModal'
import {
  PlatformBadge,
  ScoreBar,
  StatusBadge,
  MockBadge,
  formatRelative
} from '../components/primitives'
import { paths } from '../lib/paths'
import {
  exportBulkItemsJson,
  exportBulkItemsCsv,
} from '../lib/export'

const COLUMNS: { key: ReviewItem['status'] | 'published'; label: string }[] = [
  { key: 'pending', label: 'Needs QA' },
  { key: 'rejected', label: 'Changes' },
  { key: 'approved', label: 'Approved' },
  { key: 'published', label: 'Published' }
]

type SortKey = 'score' | 'createdAt'

/**
 * HITL queue as a place (not only a modal). Modal remains a quick action.
 * Mock (dry-run) items are flagged with a MOCK badge and hidden by default so the
 * board surfaces only real, publishable work — "surface only what's worth attention".
 */
export function ReviewPage() {
  const navigate = useNavigate()
  const queue = useApi(() => api.queue(hideMock ? { dryRun: false } : undefined))
  const stats = useApi(() => api.stats())
  const liveMode = stats.data?.isLLMLive
  const items = useMemo(() => queue.data ?? [], [queue.data])
  const [quick, setQuick] = useState<ReviewItem | null>(null)
  const [hideMock, setHideMock] = useState(false)
  const [sort, setSort] = useState<SortKey>('score')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null)
  // Track items that have been actioned this session (optimistic UI)
  const [localOverrides, setLocalOverrides] = useState<Map<string, ReviewItem['status']>>(new Map())

  const handleDownload = useCallback((id: string) => {
    const url = api.mediaUrl(id)
    const a = document.createElement('a')
    a.href = url
    a.download = `video_${id.slice(0, 8)}.mp4`
    a.click()
  }, [])

  const mockCount = useMemo(() => items.filter((i) => i.dryRun).length, [items])

  const visible = useMemo(() => {
    const filtered = hideMock ? items.filter((i) => !i.dryRun) : items
    // Apply optimistic local overrides so items move columns immediately
    const withOverrides = filtered.map((i) => {
      const override = localOverrides.get(i.id)
      return override ? { ...i, status: override } : i
    })
    const sorted = [...withOverrides]
    if (sort === 'score') sorted.sort((a, b) => b.score - a.score)
    else sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return sorted
  }, [items, hideMock, sort, localOverrides])

  const handleApprove = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      // Optimistic: immediately move item to 'approved' column
      setLocalOverrides((prev) => new Map(prev).set(id, 'approved'))
      try {
        await api.approve(id)
      } catch (e) {
        // Revert optimistic update on failure
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        queue.reload()
      }
    },
    [queue]
  )

  const handleReject = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      // Optimistic: immediately move item to 'rejected' column
      setLocalOverrides((prev) => new Map(prev).set(id, 'rejected'))
      try {
        await api.reject(id)
      } catch (e) {
        // Revert optimistic update on failure
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        queue.reload()
      }
    },
    [queue]
  )

  const handlePublish = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        await api.publish(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
        queue.reload()
      }
    },
    [queue]
  )

  const handleRegenerateLive = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        await api.regenerateLive(id)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      } finally {
        setBusyId(null)
        queue.reload()
      }
    },
    [queue]
  )

  const handleSendBack = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      // Optimistic: move item back to 'pending'
      setLocalOverrides((prev) => new Map(prev).set(id, 'pending'))
      try {
        await api.sendBack(id)
      } catch (e) {
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
        setLocalOverrides((prev) => { const next = new Map(prev); next.delete(id); return next })
        queue.reload()
      }
    },
    [queue]
  )

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleColumn = (key: (typeof COLUMNS)[number]['key']) => {
    const colIds = group(key).map((i) => i.id)
    if (!colIds.length) return
    const allSelected = colIds.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) colIds.forEach((id) => next.delete(id))
      else colIds.forEach((id) => next.add(id))
      return next
    })
  }

  const handleBulkApprove = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (!ids.length) return
    setBusyId('__bulk__')
    setError(null)
    try {
      await api.bulkApprove(ids)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      setBusyId(null)
      setSelectedIds(new Set())
      queue.reload()
    }
  }, [selectedIds, queue])

  const handleBulkReject = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (!ids.length) return
    setBusyId('__bulk__')
    setError(null)
    try {
      await api.bulkReject(ids)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      setBusyId(null)
      setSelectedIds(new Set())
      queue.reload()
    }
  }, [selectedIds, queue])

  const handleBulkPublish = useCallback(async () => {
    const ids = Array.from(selectedIds).filter((id) => {
      const item = visible.find((i) => i.id === id)
      return item && item.status === 'approved' && !item.publishedPostId && !item.dryRun
    })
    if (!ids.length) return
    setBusyId('__bulk__')
    setError(null)
    try {
      await api.bulkPublish(ids)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
      setSelectedIds(new Set())
      queue.reload()
    }
  }, [selectedIds, visible, queue])

  function group(key: (typeof COLUMNS)[number]['key']) {
    if (key === 'published') return visible.filter((i) => Boolean(i.publishedPostId))
    if (key === 'approved') return visible.filter((i) => i.status === 'approved' && !i.publishedPostId)
    return visible.filter((i) => i.status === key && !i.publishedPostId)
  }

  return (
    <div className="space-y-4">

      {error && (
        <div className="border border-[var(--color-red)] bg-[var(--color-red)]/10 px-4 py-2 text-[11px] font-mono text-[var(--color-red)]">
          {error}
        </div>
      )}
      {/* Triage toolbar — keep the board focused on what matters */}
      <div className="toolbar-row flex flex-wrap items-center gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideMock}
            onChange={(e) => setHideMock(e.target.checked)}
            style={{ accentColor: 'var(--color-lime)' }}
          />
          Hide mock runs
        </label>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-[var(--color-bg)] border border-[var(--color-faint)] text-[var(--color-text)] text-[11px] px-2 py-1 uppercase tracking-widest"
          >
            <option value="score">Top score</option>
            <option value="createdAt">Newest</option>
          </select>
        </div>
        {hideMock ? (
          <span className="text-[10px] font-mono text-[var(--color-orange)]">Mock runs hidden — toggle to show</span>
        ) : (
          mockCount > 0 && (
            <span className="text-[10px] font-mono text-[var(--color-orange)]">
              {mockCount} mock run{mockCount === 1 ? '' : 's'} shown
            </span>
          )
        )}
        {liveMode === false && (
          <span className="text-[10px] font-mono text-[var(--color-orange)]">
            Mock mode — Publish &amp; Regenerate live disabled (set VVUGC_LLM_LIVE=true)
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button
            onClick={() => exportBulkItemsJson(visible, 'vvugc_review_queue')}
            disabled={visible.length === 0}
            className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors disabled:opacity-40"
            title="Export all visible queue items as JSON"
          >
            ↓ JSON
          </button>
          <button
            onClick={() => exportBulkItemsCsv(visible, 'vvugc_review_queue')}
            disabled={visible.length === 0}
            className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors disabled:opacity-40"
            title="Export all visible queue items as CSV"
          >
            ↓ CSV
          </button>
        </div>
      </div>

      {queue.loading && items.length === 0 && (
        <div className="review-grid grid gap-4" aria-label="Loading review queue" role="status">
          {COLUMNS.map((col) => (
            <div key={col.key} className="border border-[var(--color-border)] bg-[var(--color-surface)] animate-pulse">
              <div className="border-b border-[var(--color-border)] px-4 py-3">
                <span className="text-[11px] uppercase tracking-widest text-[var(--color-muted-3)]">{col.label}</span>
              </div>
              <div className="p-4 space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 bg-[var(--color-raised)] rounded-md" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!(queue.loading && items.length === 0) && (
      <div className="review-grid grid gap-4">
        {COLUMNS.map((col) => {
          const list = group(col.key)
          return (
            <div key={col.key} className="border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="border-b border-[var(--color-border)] px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={list.length > 0 && list.every((i) => selectedIds.has(i.id))}
                    ref={(el) => {
                      if (el) {
                        const some = list.some((i) => selectedIds.has(i.id))
                        const all = list.every((i) => selectedIds.has(i.id))
                        el.indeterminate = some && !all
                      }
                    }}
                    onChange={() => toggleColumn(col.key)}
                    disabled={list.length === 0}
                    aria-label={`Select all in ${col.label}`}
                    style={{ accentColor: 'var(--color-lime)' }}
                    className="shrink-0"
                  />
                  <span className="text-[11px] uppercase tracking-widest">{col.label}</span>
                </div>
                <span className="text-[11px] font-mono text-[var(--color-muted-2)]">{list.length}</span>
              </div>
              <div className="divide-y divide-[var(--color-raised)] min-h-[8rem]">
                {list.map((item) => {
                  const isBusy = busyId === item.id
                  const isMock = Boolean(item.dryRun)
                  const canPublish = item.status === 'approved' && !item.publishedPostId && !isMock
                  return (
                    <div key={item.id} className="px-4 py-3 space-y-2">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          aria-label={`Select ${item.id}`}
                          style={{ accentColor: 'var(--color-lime)' }}
                          className="mt-1 shrink-0"
                        />
                        {/* Video preview thumbnail */}
                        {!item.dryRun && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setPreviewVideoId(previewVideoId === item.id ? null : item.id) }}
                            className="shrink-0 w-10 h-14 rounded-lg bg-black/60 border border-[var(--color-border)] flex items-center justify-center hover:border-[var(--color-blue)] hover:shadow-lg hover:shadow-[var(--color-blue)]/20 transition-all group/play"
                            title="Preview video"
                          >
                            <span className="text-[var(--color-muted-3)] group-hover/play:text-[var(--color-blue)] text-lg transition-colors">▶</span>
                          </button>
                        )}
                        <button onClick={() => navigate(paths.reviewItem(item.id))} className="text-left flex-1 min-w-0">
                          <p className="text-sm text-[var(--color-text)]">{item.script.hook}</p>
                          <p className="text-[10px] text-[var(--color-muted-3)] mt-1">
                            {item.niche} · {formatRelative(item.createdAt)}
                          </p>
                        </button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <PlatformBadge platform={item.platform} />
                        {item.template && (
                          <span
                            className="text-[9px] font-mono px-1.5 py-0.5 border border-[var(--color-lime)] text-[var(--color-lime)]"
                            title={item.template.description}
                          >
                            {item.template.name}
                          </span>
                        )}
                        <div className="w-16">
                          <ScoreBar score={item.score} />
                        </div>
                        <StatusBadge status={item.status} />
                        {isMock && <MockBadge />}
                        <button
                          onClick={() => setQuick(item)}
                          className="ml-auto text-[10px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)]"
                        >
                          Review
                        </button>
                      </div>
                      {/* One-click actions — obvious, no modal required */}
                      <div className="flex items-center gap-2 pt-1">
                        {item.status === 'pending' && (
                          <>
                            <button
                              onClick={() => handleApprove(item.id)}
                              disabled={isBusy}
                              className="flex-1 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
                            >
                              ✓ Approve
                            </button>
                            <button
                              onClick={() => handleReject(item.id)}
                              disabled={isBusy}
                              className="flex-1 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
                            >
                              ✗ Reject
                            </button>
                          </>
                        )}
                        {(item.status === 'approved' || item.status === 'rejected') && !item.publishedPostId && (
                          <button
                            onClick={() => handleSendBack(item.id)}
                            disabled={isBusy}
                            className="px-2 py-1.5 text-[10px] font-black uppercase tracking-widest border border-[var(--color-muted-3)] text-[var(--color-muted-3)] hover:border-[var(--color-text)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
                          >
                            ↩ Send Back
                          </button>
                        )}
                        {canPublish && (
                          <button
                            onClick={() => handlePublish(item.id)}
                            disabled={isBusy || liveMode === false}
                            className="flex-1 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 transition-colors disabled:opacity-50"
                          >
                            {isBusy ? 'PUBLISHING…' : '↗ Publish'}
                          </button>
                        )}
                        {isMock && !item.publishedPostId && (
                          <button
                            onClick={() => handleRegenerateLive(item.id)}
                            disabled={isBusy || liveMode === false}
                            className="flex-1 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest border border-[var(--color-orange)] text-[var(--color-orange)] hover:bg-[var(--color-orange)] hover:text-black transition-colors disabled:opacity-50"
                          >
                            {isBusy ? 'REGENERATING…' : '↻ Regenerate live'}
                          </button>
                        )}
                        {Boolean(item.publishedPostId) && (
                          <a
                            href={item.publishedUrl ?? '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)] hover:underline"
                          >
                            ↗ View post
                          </a>
                        )}
                      </div>
                      {/* Inline video preview player */}
                      {previewVideoId === item.id && !item.dryRun && (
                        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                          <video
                            src={api.mediaUrl(item.id)}
                            controls
                            autoPlay
                            className="w-full max-h-[320px] rounded-lg bg-black object-contain"
                            onError={() => setError(`Video preview unavailable for "${item.script.hook.slice(0, 40)}…"`)}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
                {list.length === 0 && (
                  <p className="text-[11px] text-[var(--color-muted-3)] px-4 py-6">None</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}

      {selectedIds.size > 0 && (
        <div className="sticky bottom-0 z-40 flex items-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-lg rounded-t-xl">
          <span className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)]">{selectedIds.size} selected</span>
          {/* Context-aware bulk actions based on what's selected */}
          {(() => {
            const selected = visible.filter((i) => selectedIds.has(i.id))
            const hasPending = selected.some((i) => i.status === 'pending')
            const hasPublishable = selected.some((i) => i.status === 'approved' && !i.publishedPostId && !i.dryRun)
            const publishableCount = selected.filter((i) => i.status === 'approved' && !i.publishedPostId && !i.dryRun).length
            return (
              <>
                {hasPending && (
                  <>
                    <button
                      onClick={handleBulkApprove}
                      disabled={busyId === '__bulk__'}
                      className="flex-1 px-3 py-2 text-[10px] font-black uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors disabled:opacity-50"
                    >
                      ✓ Approve selected
                    </button>
                    <button
                      onClick={handleBulkReject}
                      disabled={busyId === '__bulk__'}
                      className="flex-1 px-3 py-2 text-[10px] font-black uppercase tracking-widest border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
                    >
                      ✗ Reject selected
                    </button>
                  </>
                )}
                {hasPublishable && (
                  <button
                    onClick={handleBulkPublish}
                    disabled={busyId === '__bulk__' || liveMode === false}
                    className="flex-1 px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 transition-colors disabled:opacity-50"
                  >
                    {busyId === '__bulk__' ? 'PUBLISHING…' : `↗ Publish ${publishableCount > 1 ? publishableCount + ' ' : ''}selected`}
                  </button>
                )}
              </>
            )
          })()}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="px-3 py-2 text-[10px] uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-muted-2)] hover:text-[var(--color-text)] hover:border-[var(--color-text)] transition-colors"
          >
            Clear selection
          </button>
        </div>
      )}

      {items.length === 0 && !queue.loading && (
        <EmptyState
          icon=""
          title="Nothing to review"
          description="Start a studio run. Finished 9:16 masters land here for QA."
          actionLabel="Open studio"
          onAction={() => navigate(paths.studio)}
        />
      )}

      {queue.error && <p className="text-[11px] text-[var(--color-red)]">Load error: {queue.error}</p>}

      {quick && (
        <ReviewModal
          item={quick}
          onClose={() => setQuick(null)}
          onApprove={() => {
            setQuick(null)
            queue.reload()
          }}
          onReject={() => {
            setQuick(null)
            queue.reload()
          }}
          onPublish={() => {
            setQuick(null)
            queue.reload()
          }}
          onRegenerateLive={() => {
            setQuick(null)
            queue.reload()
          }}
          liveMode={liveMode}
          onDownload={handleDownload}
        />
      )}
    </div>
  )
}
