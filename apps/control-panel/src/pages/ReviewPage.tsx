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
  const queue = useApi(() => api.queue())
  const items = queue.data ?? []
  const [quick, setQuick] = useState<ReviewItem | null>(null)
  const [hideMock, setHideMock] = useState(true)
  const [sort, setSort] = useState<SortKey>('score')
  const [busyId, setBusyId] = useState<string | null>(null)

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
    const sorted = [...filtered]
    if (sort === 'score') sorted.sort((a, b) => b.score - a.score)
    else sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return sorted
  }, [items, hideMock, sort])

  const handleApprove = useCallback(
    async (id: string) => {
      setBusyId(id)
      try {
        await api.approve(id)
      } catch {
        /* surfaced via reload */
      } finally {
        setBusyId(null)
        queue.reload()
      }
    },
    [queue]
  )

  const handleReject = useCallback(
    async (id: string) => {
      setBusyId(id)
      try {
        await api.reject(id)
      } catch {
        /* surfaced via reload */
      } finally {
        setBusyId(null)
        queue.reload()
      }
    },
    [queue]
  )

  const handlePublish = useCallback(
    async (id: string) => {
      setBusyId(id)
      try {
        await api.publish(id)
      } catch {
        /* surfaced via reload */
      } finally {
        setBusyId(null)
        queue.reload()
      }
    },
    [queue]
  )

  function group(key: (typeof COLUMNS)[number]['key']) {
    if (key === 'published') return visible.filter((i) => Boolean(i.publishedPostId))
    if (key === 'approved') return visible.filter((i) => i.status === 'approved' && !i.publishedPostId)
    return visible.filter((i) => i.status === key && !i.publishedPostId)
  }

  return (
    <div className="space-y-4">
      {/* Triage toolbar — keep the board focused on what matters */}
      <div className="flex flex-wrap items-center gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
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
        {mockCount > 0 && (
          <span className="text-[10px] font-mono text-[var(--color-orange)]">
            {hideMock
              ? `${mockCount} mock run${mockCount === 1 ? '' : 's'} hidden — toggle to show`
              : `${mockCount} mock run${mockCount === 1 ? '' : 's'} shown`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const list = group(col.key)
          return (
            <div key={col.key} className="border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="border-b border-[var(--color-border)] px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest">{col.label}</span>
                <span className="text-[11px] font-mono text-[var(--color-muted-2)]">{list.length}</span>
              </div>
              <div className="divide-y divide-[var(--color-raised)] min-h-[8rem]">
                {list.map((item) => {
                  const isBusy = busyId === item.id
                  const isMock = Boolean(item.dryRun)
                  const canPublish = item.status === 'approved' && !item.publishedPostId && !isMock
                  return (
                    <div key={item.id} className="px-4 py-3 space-y-2">
                      <button onClick={() => navigate(paths.reviewItem(item.id))} className="text-left w-full">
                        <p className="text-sm text-[var(--color-text)]">{item.script.hook}</p>
                        <p className="text-[10px] text-[var(--color-muted-3)] mt-1">
                          {item.niche} · {formatRelative(item.createdAt)}
                        </p>
                      </button>
                      <div className="flex items-center gap-2 flex-wrap">
                        <PlatformBadge platform={item.platform} />
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
                        {canPublish && (
                          <button
                            onClick={() => handlePublish(item.id)}
                            disabled={isBusy}
                            className="flex-1 px-2 py-1.5 text-[10px] font-black uppercase tracking-widest bg-[var(--color-lime)] text-[var(--color-on-accent)] hover:brightness-110 transition-colors disabled:opacity-50"
                          >
                            {isBusy ? 'PUBLISHING…' : '↗ Publish'}
                          </button>
                        )}
                        {item.status === 'approved' && isMock && (
                          <span className="text-[9px] font-mono text-[var(--color-orange)] uppercase tracking-widest">
                            Mock — regenerate live to publish
                          </span>
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
          onDownload={handleDownload}
        />
      )}
    </div>
  )
}
