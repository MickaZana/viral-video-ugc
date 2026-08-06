import { useState } from 'react'
import type { ModelKind, ModelOption, ModelsResponse } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel } from '../components/primitives'

/**
 * Video Generator — pick a model by the result you want. Reads the real backend
 * /models catalog and lets you choose a model for each stage (script, image,
 * video, voiceover). Every model shows its per-consumption USD price; the actual
 * runtime metering is done by the backend's CostLedger + overage ledger.
 */
const KIND_ORDER: ModelKind[] = ['text', 'image', 'video', 'voiceover']
const KIND_LABEL: Record<ModelKind, string> = {
  text: 'Script & Judgment',
  image: 'Thumbnail / Reference',
  video: 'Video Clips',
  voiceover: 'Voiceover'
}

export function VideoGenerator() {
  const models = useApi<ModelsResponse>(() => api.models())
  const grouped = models.data?.grouped
  // Per-kind selection keyed by ModelKind; default to the first of each group.
  const [selected, setSelected] = useState<Partial<Record<ModelKind, string>>>({})

  return (
    <div className="space-y-8">
      <Panel title="CHOOSE MODELS BY RESULT">
        <div className="divide-y divide-[var(--color-raised)]">
          {KIND_ORDER.map((kind) => {
            const list = grouped?.[kind] ?? []
            const chosenId = selected[kind] ?? list[0]?.id
            const chosen = list.find((m) => m.id === chosenId)
            return (
              <div key={kind} className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Barlow Condensed', color: 'var(--color-text)' }}>
                    {KIND_LABEL[kind]}
                  </span>
                  {chosen && (
                    <span className="text-[11px] font-mono text-[var(--color-lime)]">
                      ~${chosen.priceUsdPerUnit.toFixed(4)}/{chosen.unit}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-[var(--color-border)]">
                  {list.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setSelected((s) => ({ ...s, [kind]: m.id }))}
                      className="text-left bg-[var(--color-bg)] p-4 hover:bg-[var(--color-raised)] transition-colors"
                      style={{ borderLeft: chosenId === m.id ? '2px solid var(--color-lime)' : '2px solid transparent' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">{m.vendor}</span>
                        {chosenId === m.id && <span className="text-[9px] font-mono text-[var(--color-on-accent)] bg-[var(--color-lime)] px-1.5 py-0.5">SELECTED</span>}
                      </div>
                      <p className="text-sm font-mono text-[var(--color-text)] mt-1 truncate">{m.model}</p>
                      <p className="text-[10px] font-mono text-[var(--color-muted-2)] mt-1 leading-relaxed">{m.description}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] font-mono text-[var(--color-lime)]">${m.priceUsdPerUnit.toFixed(4)}</span>
                        <span className="text-[10px] font-mono text-[var(--color-muted-3)]">per {m.unit}</span>
                      </div>
                    </button>
                  ))}
                  {list.length === 0 && (
                    <p className="bg-[var(--color-bg)] p-4 text-[11px] font-mono text-[var(--color-muted-2)]">No {KIND_LABEL[kind]} models available.</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-[10px] font-mono text-[var(--color-muted-3)] px-5 py-3">
          Consumption billing: each selected model meters real usage (tokens / clips / characters) into USD via the backend cost ledger. Run to start generating.
        </p>
      </Panel>

      {models.error && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">Load error: {models.error}</p>
      )}
    </div>
  )
}
