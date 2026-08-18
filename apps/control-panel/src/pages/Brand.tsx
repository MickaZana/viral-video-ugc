import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { paths } from '../lib/paths'
import type { AgencyClient } from '../lib/types'

export function Brand() {
  const navigate = useNavigate()
  const clients = useApi<{ clients: AgencyClient[] }>(() => api.clients())
  const list = clients.data?.clients ?? []

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-muted-2)]">
        Brand kit and clients. Assembly will burn logo, color, and captions from this kit.
      </p>
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-raised)]">
        {list.map((c) => (
          <button
            key={c.id}
            onClick={() => navigate(paths.brandClient(c.id))}
            className="w-full text-left px-5 py-4 hover:bg-[var(--color-raised)] transition-colors"
          >
            <p className="text-sm">{c.name}</p>
            <p className="text-[11px] text-[var(--color-muted-3)] mt-0.5">{c.niche}</p>
          </button>
        ))}
        {list.length === 0 && !clients.loading && (
          <p className="px-5 py-6 text-[11px] text-[var(--color-muted-3)]">
            No clients yet. Create one in Studio.
          </p>
        )}
      </div>
      {clients.error && <p className="text-[11px] text-[var(--color-red)]">Load error: {clients.error}</p>}
    </div>
  )
}

export function BrandClient() {
  const { id } = useParams()
  const navigate = useNavigate()
  const clients = useApi<{ clients: AgencyClient[] }>(() => api.clients())
  const client = (clients.data?.clients ?? []).find((c) => c.id === id)

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate(paths.brand)}
        className="text-[11px] uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-text)]"
      >
        Back to brand
      </button>
      {client ? (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-2">
          <p className="text-lg font-semibold">{client.name}</p>
          <p className="text-sm text-[var(--color-muted-2)]">{client.niche}</p>
          <p className="text-[11px] font-mono text-[var(--color-muted-3)]">{client.id}</p>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-muted-2)]">Client not found.</p>
      )}
    </div>
  )
}