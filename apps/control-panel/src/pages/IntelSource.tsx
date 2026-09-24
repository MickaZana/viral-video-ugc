import { useNavigate, useParams } from 'react-router-dom'
import { Spy } from '../tabs/Spy'
import { paths } from '../lib/paths'

/** Source detail + Remix into this week. Spy remains the inbox body. */
export function IntelSource() {
  const { sourceId } = useParams()
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <p className="text-sm">
          Source <span className="font-mono text-[var(--color-muted-2)]">{sourceId}</span>
        </p>
        <button
          onClick={() => navigate(paths.intelRemix)}
          className="px-4 py-2 text-[11px] font-semibold uppercase tracking-widest"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          Remix into this week
        </button>
      </div>
      <Spy />
    </div>
  )
}