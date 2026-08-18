import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { ReviewModal } from '../components/ReviewModal'
import { paths } from '../lib/paths'

export function ReviewDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queue = useApi(() => api.queue())
  const item = (queue.data ?? []).find((i) => i.id === id)

  const handleDownload = useCallback((itemId: string) => {
    const url = api.mediaUrl(itemId)
    const a = document.createElement('a')
    a.href = url
    a.download = `video_${itemId.slice(0, 8)}.mp4`
    a.click()
  }, [])

  if (queue.loading && !item) {
    return <p className="text-[11px] text-[var(--color-muted-2)]">Loading review…</p>
  }
  if (!item) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Review item not found.</p>
        <button
          onClick={() => navigate(paths.review)}
          className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)]"
        >
          Back to review
        </button>
      </div>
    )
  }

  return (
    <ReviewModal
      item={item}
      onClose={() => navigate(paths.review)}
      onApprove={() => navigate(paths.review)}
      onReject={() => navigate(paths.review)}
      onDownload={handleDownload}
    />
  )
}