import { useEffect, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import type { DiscoverBrief } from '../lib/types'
import { api } from '../lib/api'
import { PipelineProgress } from '../components/PipelineProgress'

/**
 * Live 9-stage factory floor. Deep-linkable; step 2 will wire durable SSE.
 * PipelineProgress already reconnects via the existing run-progress endpoint.
 * When the run was kicked off from a riffed discovery brief, that brief arrives
 * in the navigation state so the through-line (discover → riff → run) is visible
 * here alongside the live progress. If the page is reached by a hard refresh (no
 * navigation state), we fall back to the brief stored on the run manifest.
 */
export function StudioRun() {
  const { runId } = useParams()
  const loc = useLocation()
  const stateBrief = (loc.state as { brief?: DiscoverBrief } | null)?.brief
  const [fetchedBrief, setFetchedBrief] = useState<DiscoverBrief | null | undefined>(undefined)

  useEffect(() => {
    if (stateBrief || !runId) return
    let cancelled = false
    api
      .runs()
      .then((runs) => {
        if (cancelled) return
        const match = runs.find((r) => r.runId === runId)
        setFetchedBrief((match?.discoveryBrief as DiscoverBrief) ?? null)
      })
      .catch(() => {
        if (!cancelled) setFetchedBrief(null)
      })
    return () => {
      cancelled = true
    }
  }, [runId, stateBrief])

  const brief = stateBrief ?? fetchedBrief ?? undefined
  return (
    <div className="space-y-4">
      {brief && <BriefCard brief={brief} />}
      <p className="text-[11px] text-[var(--color-muted-2)] uppercase tracking-widest">
        Run <span className="font-mono text-[var(--color-text)]">{runId}</span>
      </p>
      <PipelineProgress active={Boolean(runId)} runId={runId} />
    </div>
  )
}

/** Surfaces the riffed discovery brief on the live run page. */
function BriefCard({ brief }: { brief: DiscoverBrief }) {
  return (
    <div className="border border-[var(--color-lime)] bg-[var(--color-surface)] p-5 space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-[var(--color-lime)]">Your brief — from discovery</p>
      <p className="text-sm text-[var(--color-text)]"><span className="text-[var(--color-muted-2)]">Angle:</span> {brief.angle}</p>
      <p className="text-sm text-[var(--color-text)]"><span className="text-[var(--color-muted-2)]">Hook:</span> {brief.hookTemplate}</p>
      <p className="text-[11px] text-[var(--color-muted-4)]">Structure: {brief.structure.join(' → ')}</p>
      <div className="flex flex-wrap gap-1.5 mt-1">
        {brief.patterns.map((p, i) => (
          <span key={i} className="text-[10px] font-mono px-2 py-0.5 border border-[var(--color-faint)] text-[var(--color-lime)]">{p}</span>
        ))}
      </div>
    </div>
  )
}