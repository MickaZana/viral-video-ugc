import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { Panel } from '../components/primitives'
import { paths } from '../lib/paths'
import type { BatchProgress as BatchProgressData } from '@vvugc/shared-schema'

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function isTerminal(data: BatchProgressData): boolean {
  return data.planned === 0 && data.queued === 0 && data.running === 0
}

function statusFor(data: BatchProgressData): string {
  if (data.running > 0) return 'running'
  if (data.queued > 0) return 'queued'
  if (data.failed > 0 && data.completed > 0) return 'partial'
  if (data.cancelled > 0 && data.completed === 0) return 'cancelled'
  if (data.completed === data.totalVariations && data.totalVariations > 0) return 'completed'
  return 'planned'
}

/* ─── Component ──────────────────────────────────────────────────────── */

export function BatchProgress() {
  const { batchId } = useParams<{ batchId: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<BatchProgressData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startPolling = useCallback(() => {
    if (!batchId) return
    if (pollRef.current) return // Already polling

    async function poll() {
      try {
        const result = await api.batchProgress(batchId!)
        setData(result)
        setError(null)
        // Stop polling if terminal
        if (isTerminal(result)) {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    // Initial fetch
    void poll()
    // Poll every 3 seconds
    pollRef.current = setInterval(poll, 3000)
  }, [batchId])

  useEffect(() => {
    startPolling()
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [startPolling])

  const handleCancel = useCallback(async () => {
    if (!batchId) return
    setCancelling(true)
    try {
      await api.batchCancel(batchId)
      void api.batchProgress(batchId).then(setData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }, [batchId])

  /* ─── Render ─────────────────────────────────────────────────────── */

  if (!batchId) {
    return (
      <div className="text-[11px] font-mono text-[var(--color-muted-2)]">No batch ID provided.</div>
    )
  }

  if (error && !data) {
    return (
      <Panel title="BATCH PROGRESS">
        <div className="px-5 py-5">
          <p className="text-[11px] font-mono text-[var(--color-red)]">Error: {error}</p>
          <button
            onClick={startPolling}
            className="mt-3 text-[10px] font-mono text-[var(--color-lime)] hover:underline"
          >
            Retry
          </button>
        </div>
      </Panel>
    )
  }

  if (!data) {
    return (
      <Panel title="BATCH PROGRESS">
        <div className="px-5 py-5">
          <p className="text-[11px] font-mono text-[var(--color-muted-2)]">Loading batch progress…</p>
        </div>
      </Panel>
    )
  }

  const progressPct = data.totalVariations > 0 ? Math.round(((data.completed + data.failed + data.cancelled) / data.totalVariations) * 100) : 0
  const terminal = isTerminal(data)
  const hasFailures = data.failed > 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
            Batch Progress
          </h2>
          <p className="text-[10px] font-mono text-[var(--color-muted-3)] mt-1">
            {batchId.slice(0, 12)}… • Started {data.startedAt ? new Date(data.startedAt).toLocaleString() : 'pending'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (!data) return
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `batch_${batchId.slice(0, 8)}_export.json`
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
            className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors"
            title="Export full batch results as JSON"
          >
            ↓ Export Batch (JSON)
          </button>
          {!terminal && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
            >
              {cancelling ? 'Cancelling...' : 'Cancel Batch'}
            </button>
          )}
          <button
            onClick={() => navigate(paths.studioBatch)}
            className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)] transition-colors"
          >
            ← New batch
          </button>
        </div>
      </div>

      {/* Main progress panel */}
      <Panel title="PROGRESS">
        <div className="px-5 py-5 space-y-5">

          {/* Status badge */}
          <div className="flex items-center gap-3">
            <StatusBadge status={statusFor(data)} />
            {!terminal && (
              <span className="text-[10px] font-mono text-[var(--color-muted-2)] animate-pulse">
                Processing…
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">
                {data.completed} / {data.totalVariations} completed
              </span>
              <span className="text-[11px] font-mono text-[var(--color-lime)]">{progressPct}%</span>
            </div>
            <div className="w-full h-2 bg-[var(--color-border)] relative overflow-hidden">
              <div
                className="h-full transition-all duration-500"
                style={{
                  width: `${progressPct}%`,
                  backgroundColor: hasFailures ? 'var(--color-orange)' : 'var(--color-lime)'
                }}
              />
              {/* Failed portion overlay */}
              {data.failed > 0 && data.totalVariations > 0 && (
                <div
                  className="absolute top-0 h-full bg-[var(--color-red)]"
                  style={{
                    left: `${progressPct}%`,
                    width: `${Math.round((data.failed / data.totalVariations) * 100)}%`
                  }}
                />
              )}
            </div>
          </div>

          {/* Status counts */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatusCount label="Planned" count={data.planned} color="var(--color-muted-2)" />
            <StatusCount label="Queued" count={data.queued} color="var(--color-muted-2)" />
            <StatusCount label="Running" count={data.running} color="var(--color-lime)" pulse={data.running > 0} />
            <StatusCount label="Completed" count={data.completed} color="var(--color-lime)" />
            <StatusCount label="Failed" count={data.failed} color="var(--color-red)" />
          </div>

          {/* Cost tracking */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Actual cost</p>
              <p className="text-2xl font-black font-mono text-[var(--color-lime)] mt-1">
                ${data.totalActualCost.toFixed(2)}
              </p>
            </div>
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Estimated total</p>
              <p className="text-2xl font-black font-mono text-[var(--color-text)] mt-1">
                ${data.totalEstimatedCost.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Review queue link */}
          <button
            onClick={() => navigate(`${paths.review}?batchId=${encodeURIComponent(batchId)}`)}
            className="w-full px-4 py-3 text-[11px] font-mono uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors text-center"
          >
            View in Review Queue →
          </button>
        </div>
      </Panel>

    </div>
  )
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { color: string; label: string }> = {
    queued: { color: 'var(--color-muted-2)', label: 'QUEUED' },
    running: { color: 'var(--color-lime)', label: 'RUNNING' },
    completed: { color: 'var(--color-lime)', label: 'COMPLETED' },
    cancelled: { color: 'var(--color-red)', label: 'CANCELLED' },
    partial: { color: 'var(--color-orange)', label: 'PARTIAL' }
  }
  const s = meta[status] ?? meta.queued
  return (
    <span
      className="text-[10px] font-mono px-2 py-0.5 uppercase tracking-widest border"
      style={{ color: s.color, borderColor: s.color + '44', backgroundColor: s.color + '11' }}
    >
      {s.label}
    </span>
  )
}

function StatusCount({ label, count, color, pulse }: { label: string; count: number; color: string; pulse?: boolean }) {
  return (
    <div className="bg-[var(--color-bg)] p-3 text-center">
      <p
        className={`text-xl font-black font-mono ${pulse ? 'animate-pulse' : ''}`}
        style={{ color }}
      >
        {count}
      </p>
      <p className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest mt-1">{label}</p>
    </div>
  )
}
