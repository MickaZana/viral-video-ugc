import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReviewItem } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { EmptyState } from '../components/EmptyState'
import { ReviewModal } from '../components/ReviewModal'
import { PlatformBadge, ScoreBar, StatusBadge, formatRelative } from '../components/primitives'
import { paths } from '../lib/paths'

const COLUMNS: { key: ReviewItem['status'] | 'published'; label: string }[] = [
  { key: 'pending', label: 'Needs QA' },
  { key: 'rejected', label: 'Changes' },
  { key: 'approved', label: 'Approved' },
  { key: 'published', label: 'Published' }
]

/**
 * HITL queue as a place (not only a modal). Modal remains a quick action.
 */
export function ReviewPage() {
  const navigate = useNavigate()
  const queue = useApi(() => api.queue())
  const items = queue.data ?? []
  const [quick, setQuick] = useState<ReviewItem | null>(null)

  const handleDownload = useCallback((id: string) => {
    const url = api.mediaUrl(id)
    const a = document.createElement('a')
    a.href = url
    a.download = `video_${id.slice(0, 8)}.mp4`
    a.click()
  }, [])

  function group(key: (typeof COLUMNS)[number]['key']) {
    if (key === 'published') return items.filter((i) => Boolean(i.publishedPostId))
    if (key === 'approved') return items.filter((i) => i.status === 'approved' && !i.publishedPostId)
    return items.filter((i) => i.status === key && !i.publishedPostId)
  }

  return (
    <div className="space-y-4">
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
                {list.map((item) => (
                  <div key={item.id} className="px-4 py-3 space-y-2">
                    <button
                      onClick={() => navigate(paths.reviewItem(item.id))}
                      className="text-left w-full"
                    >
                      <p className="text-sm text-[var(--color-text)]">{item.script.hook}</p>
                      <p className="text-[10px] text-[var(--color-muted-3)] mt-1">
                        {item.niche} · {formatRelative(item.createdAt)}
                      </p>
                    </button>
                    <div className="flex items-center gap-2">
                      <PlatformBadge platform={item.platform} />
                      <div className="w-16">
                        <ScoreBar score={item.score} />
                      </div>
                      <StatusBadge status={item.status} />
                      <button
                        onClick={() => setQuick(item)}
                        className="ml-auto text-[10px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)]"
                      >
                        Quick
                      </button>
                    </div>
                  </div>
                ))}
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
          onDownload={handleDownload}
        />
      )}
    </div>
  )
}