import { useState } from 'react'
import type {
  AgencyClient,
  ClientCadence,
  CreateClientInput,
  ModelKind,
  ModelsResponse,
  Platform,
  RunResponse,
  VideoVendor,
  VoiceVendor
} from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel } from '../components/primitives'

/**
 * Video Generator — pick a model by the result you want, then run the real
 * pipeline. Reads the real backend /models catalog and the org's real
 * /accounts/clients. The video + voiceover picks become the run's vendors
 * (persisted onto the selected client via the clients API when they differ);
 * script/thumbnail/caption stages always use the catalog's fixed models (the
 * picker shows them for price transparency). RUN NOW hits the real
 * POST /accounts/run endpoint — dry run by default (full pipeline, real
 * manifest + cost ledger, no vendor spend), with a live option.
 */
const KIND_ORDER: ModelKind[] = ['text', 'image', 'video', 'voiceover']
const KIND_LABEL: Record<ModelKind, string> = {
  text: 'Script & Judgment',
  image: 'Thumbnail / Reference',
  video: 'Video Clips',
  voiceover: 'Voiceover'
}

const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
  instagram_reels: 'Instagram Reels',
  facebook: 'Facebook'
}
const PLATFORMS: Platform[] = ['tiktok', 'youtube_shorts', 'instagram_reels', 'facebook']

/** Catalog model id -> vendor enum (the RunConfig vendor string). Both video and
 *  voiceover catalog ids are "<vendor>:<model>" (or just "<vendor>"), so the
 *  prefix is the vendor. */
function vendorForModelId(id: string): string {
  return id.split(':')[0]
}

const EMPTY_FORM = {
  name: '',
  niche: '',
  brandVoice: 'energetic, direct, conversational',
  platforms: [] as Platform[],
  targetDurationSec: 30,
  cadence: 'manual' as ClientCadence
}

export function VideoGenerator() {
  const models = useApi<ModelsResponse>(() => api.models())
  const clients = useApi<{ clients: AgencyClient[] }>(() => api.clients())
  const grouped = models.data?.grouped
  const [selected, setSelected] = useState<Partial<Record<ModelKind, string>>>({})
  const [clientId, setClientId] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState(false)
  const [run, setRun] = useState<RunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const clientList = clients.data?.clients ?? []
  const selectedClient = clientList.find((c) => c.id === clientId) ?? clientList[0] ?? null

  // The effective video/voiceover picks. An explicit picker click wins; otherwise
  // they follow the selected client's saved vendors so the run matches the client.
  const videoList = grouped?.video ?? []
  const voiceList = grouped?.voiceover ?? []
  const videoChosenId =
    selected.video ??
    (selectedClient ? videoList.find((m) => vendorForModelId(m.id) === selectedClient.videoVendor)?.id : undefined) ??
    videoList[0]?.id
  const voiceChosenId =
    selected.voiceover ??
    (selectedClient?.voiceVendor ? voiceList.find((m) => vendorForModelId(m.id) === selectedClient.voiceVendor)?.id : undefined) ??
    voiceList[0]?.id
  const videoChosen = videoList.find((m) => m.id === videoChosenId)
  const voiceChosen = voiceList.find((m) => m.id === voiceChosenId)

  function togglePlatform(p: Platform) {
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p]
    }))
  }

  async function handleCreateClient() {
    setCreating(true)
    setError(null)
    try {
      const videoVendor = (videoChosen ? vendorForModelId(videoChosen.id) : 'higgsfield') as VideoVendor
      const voiceVendor = voiceChosen ? (vendorForModelId(voiceChosen.id) as VoiceVendor) : undefined
      const created = await api.createClient({
        name: form.name.trim(),
        niche: form.niche.trim(),
        brandVoice: form.brandVoice.trim(),
        locale: 'en',
        platforms: form.platforms,
        targetDurationSec: form.targetDurationSec,
        videoVendor,
        voiceVendor,
        cadence: form.cadence,
        active: true
      })
      setClientId(created.client.id)
      setForm(EMPTY_FORM)
      setRun(null)
      clients.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleRun() {
    if (!selectedClient) return
    setRunning(true)
    setError(null)
    setRun(null)
    try {
      const videoVendor = (videoChosen ? vendorForModelId(videoChosen.id) : selectedClient.videoVendor) as VideoVendor
      const voiceVendor = voiceChosen ? (vendorForModelId(voiceChosen.id) as VoiceVendor) : selectedClient.voiceVendor
      let target = selectedClient
      // The video/voiceover picker drives what the run spends on — persist the
      // choice into the client so the run config and the picker agree.
      if (videoVendor !== selectedClient.videoVendor || voiceVendor !== selectedClient.voiceVendor) {
        const body: CreateClientInput = {
          name: selectedClient.name,
          niche: selectedClient.niche,
          brandVoice: selectedClient.brandVoice,
          brandKit: selectedClient.brandKit,
          locale: selectedClient.locale,
          platforms: selectedClient.platforms,
          targetDurationSec: selectedClient.targetDurationSec,
          videoVendor,
          voiceVendor,
          cadence: selectedClient.cadence,
          active: selectedClient.active
        }
        const updated = await api.updateClient(selectedClient.id, body)
        target = updated.client
        clients.reload()
      }
      const result = await api.run({ clientId: target.id, dryRun: !live })
      setRun(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-8">
      <Panel title="CHOOSE MODELS BY RESULT">
        <div className="divide-y divide-[var(--color-raised)]">
          {KIND_ORDER.map((kind) => {
            const list = grouped?.[kind] ?? []
            const chosenId =
              kind === 'video'
                ? videoChosenId
                : kind === 'voiceover'
                  ? voiceChosenId
                  : (selected[kind] ?? list[0]?.id)
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
          Script, thumbnail and caption stages always use the catalog's fixed models (Anthropic script/QA/caption, Gemini reference image) — shown above for price transparency. The video and voiceover picks are what a run actually spends on, and they become your selected client's vendors. Runs default to DRY-RUN: the full pipeline with real manifests and cost ledger, no vendor spend.
        </p>
      </Panel>

      <Panel title="RUN PIPELINE">
        {clientList.length === 0 ? (
          <div className="px-5 py-4 space-y-4">
            {clients.loading ? (
              <p className="text-[11px] font-mono text-[var(--color-muted-2)]">Loading clients…</p>
            ) : (
              <>
                <p className="text-[11px] font-mono text-[var(--color-muted-2)]">
                  No client yet — a client holds the niche, platforms and vendors a run is built from. Create one to run the pipeline; your selected video/voiceover model becomes its vendor.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Client name</span>
                    <input
                      className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                      placeholder="e.g. FitFuel Brand"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Niche</span>
                    <input
                      className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                      placeholder="e.g. fitness, SaaS onboarding, personal finance"
                      value={form.niche}
                      onChange={(e) => setForm((f) => ({ ...f, niche: e.target.value }))}
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Brand voice</span>
                    <input
                      className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                      value={form.brandVoice}
                      onChange={(e) => setForm((f) => ({ ...f, brandVoice: e.target.value }))}
                    />
                  </label>
                </div>
                <div>
                  <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Platforms</span>
                  <div className="flex flex-wrap gap-3 mt-2">
                    {PLATFORMS.map((p) => (
                      <label key={p} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.platforms.includes(p)}
                          onChange={() => togglePlatform(p)}
                          className="accent-[var(--color-lime)]"
                        />
                        <span className="text-[11px] font-mono text-[var(--color-text)]">{PLATFORM_LABEL[p]}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Target duration (seconds)</span>
                    <input
                      type="number"
                      min={15}
                      max={60}
                      className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                      value={form.targetDurationSec}
                      onChange={(e) => setForm((f) => ({ ...f, targetDurationSec: Math.min(60, Math.max(15, Number(e.target.value) || 15)) }))}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Cadence</span>
                    <select
                      className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                      value={form.cadence}
                      onChange={(e) => setForm((f) => ({ ...f, cadence: e.target.value as ClientCadence }))}
                    >
                      <option value="manual">Manual (only when you run)</option>
                      <option value="weekly">Weekly (auto-scheduled)</option>
                    </select>
                  </label>
                </div>
                <button
                  onClick={handleCreateClient}
                  disabled={creating || !form.name.trim() || !form.niche.trim() || !form.brandVoice.trim() || form.platforms.length === 0}
                  className="px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
                  style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                >
                  {creating ? 'CREATING...' : 'CREATE CLIENT'}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <label className="block">
                <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Client</span>
                <select
                  className="mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                  value={selectedClient?.id ?? ''}
                  onChange={(e) => {
                    setClientId(e.target.value)
                    // A different client means different saved vendors — drop any
                    // explicit picker override so the picks re-derive from it.
                    setSelected((s) => ({ ...s, video: undefined, voiceover: undefined }))
                  }}
                >
                  {clientList.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedClient && (
                <span className="text-[10px] font-mono text-[var(--color-muted-2)]">
                  {selectedClient.platforms.map((p) => PLATFORM_LABEL[p]).join(' · ')} · {selectedClient.targetDurationSec}s · {selectedClient.cadence}
                </span>
              )}
            </div>

            {selectedClient && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-mono border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                  <div>
                    <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Niche</span>
                    <div className="text-[var(--color-text)] mt-1 truncate">{selectedClient.niche}</div>
                  </div>
                  <div>
                    <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Video vendor</span>
                    <div className="text-[var(--color-text)] mt-1">{videoChosen ? `${videoChosen.vendor} (${videoChosen.model})` : selectedClient.videoVendor}</div>
                  </div>
                  <div>
                    <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Voiceover</span>
                    <div className="text-[var(--color-text)] mt-1">{voiceChosen ? `${voiceChosen.vendor} (${voiceChosen.model})` : 'none'}</div>
                  </div>
                  <div>
                    <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Video est. cost</span>
                    <div className="text-[var(--color-lime)] mt-1">{videoChosen ? `~$${videoChosen.priceUsdPerUnit.toFixed(4)}/${videoChosen.unit}` : '—'}</div>
                  </div>
                </div>

                <div className="flex items-center gap-4 flex-wrap">
                  <button
                    onClick={handleRun}
                    disabled={running}
                    className="px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
                    style={{ fontFamily: 'Barlow Condensed', backgroundColor: live ? 'var(--color-orange)' : 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                  >
                    {running ? 'RUNNING...' : live ? 'RUN LIVE' : 'RUN DRY-RUN'}
                  </button>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={live}
                      onChange={(e) => setLive(e.target.checked)}
                      className="accent-[var(--color-orange)]"
                    />
                    <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Live run (real vendor spend)</span>
                  </label>
                </div>
                <p className="text-[10px] font-mono text-[var(--color-muted-3)]">
                  Dry run: full pipeline end-to-end (discovery → script → video → QA → review queue) with no vendor spend. Live run attempts real vendor calls and is billed.
                </p>
              </>
            )}
          </div>
        )}
      </Panel>

      {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}

      {run && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Barlow Condensed' }}>
              RUN COMPLETE <span className="text-[var(--color-lime)]">({live ? 'LIVE' : 'DRY-RUN'})</span>
            </p>
            <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest">✓ QUEUED FOR REVIEW</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-mono">
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Run</span><div className="text-[var(--color-text)]">{run.runId.slice(0, 8)}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Queued for review</span><div className="text-[var(--color-lime)]">{run.reviewItemsCreated}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Candidates found</span><div className="text-[var(--color-text)]">{run.candidatesFound}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Est. cost</span><div className="text-[var(--color-text)]">${run.estimatedCostUsd?.toFixed(2) ?? 'n/a'}</div></div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-mono mt-3">
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Overage</span><div className="text-[var(--color-orange)]">{run.overage ? `$${run.overage.priceUsdPerRun}/run` : 'none'}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Candidates failed</span><div className="text-[var(--color-text)]">{run.candidatesFailed ?? 0}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Platforms failed</span><div className="text-[var(--color-text)]">{run.platformsFailed ?? 0}</div></div>
          </div>
        </div>
      )}

      {models.error && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">Load error: {models.error}</p>
      )}
      {clients.error && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">Load error: {clients.error}</p>
      )}
    </div>
  )
}
