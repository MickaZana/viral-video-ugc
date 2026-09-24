import { useNavigate, useParams } from 'react-router-dom'
import { History } from '../tabs/History'
import { paths } from '../lib/paths'

export function LibraryItem() {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <p className="text-sm">
          Asset <span className="font-mono text-[var(--color-muted-2)]">{id}</span>
        </p>
        <button
          onClick={() => navigate(paths.library)}
          className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
        >
          Back to library
        </button>
      </div>
      <History />
    </div>
  )
}