import { useState } from 'react'
import type { RemixPreviewResponse, RunSummary } from '../lib/types'
import { api } from '../lib/api'
import { Panel, PlatformBadge } from '../components/primitives'
/**
 * Remix from URL — the "adapt a viral video to my niche" flow.
 * Paste a TikTok / YouTube / Instagram (Reels) link, and the backend fetches its
 * transcript, adapts it to your niche, and (optionally) generates a finished
 * video from that single source. Two steps:
 *   PREVIEW REMIX  → one cheap LLM call, no video spend; shows the adapted script.
 *   GENERATE VIDEO → runs the full pipeline from that source into the review queue.
 */
export function Remix() {
  const [sourceUrl, setSourceUrl] = useState('')
  const [niche, setNiche] = useState('')
  const [brandVoice, setBrandVoice] = useState('energetic, direct, conversational')
  const [preview, setPreview] = useState<RemixPreviewResponse | null>(null)
  const [run, setRun] = useState<(RunSummary & { overage?: { priceUsdPerRun: number } | null }) | null>(null)
  const [loading, setLoading] = useState<'preview' | 'generate' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handlePreview() {
    if (!sourceUrl.trim()) return
    setLoading('preview')
    setError(null)
    setRun(null)
    try {
      setPreview(await api.remixPreview({ sourceUrl: sourceUrl.trim(), niche, brandVoice }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(null)
    }
  }

  async function handleGenerate() {
    if (!sourceUrl.trim()) return
    setLoading('generate')
    setError(null)
    try {
      setRun(await api.remix({ sourceUrl: sourceUrl.trim(), niche, brandVoice }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-6">
      <Panel title="REMIX A VIRAL VIDEO TO YOUR NICHE">
        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Source video URL</span>
            <input
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-lime)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              placeholder="https://www.tiktok.com/@user/video/... or YouTube / Instagram"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Niche</span>
              <input
                className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                placeholder="e.g. fitness, SaaS onboarding, personal finance"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Brand voice</span>
              <input
                className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
              />
            </label>
          </div>
          <p className="text-[10px] font-mono text-[var(--color-muted-2)]">
            Preview is a single cheap LLM call — no video spend. Generate runs the full pipeline from this source into your review queue.
          </p>
        </div>

        <div className="flex items-center gap-3 px-5 pb-5">
          <button
            onClick={handlePreview}
            disabled={loading !== null || !sourceUrl.trim()}
            className="px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
            style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            {loading === 'preview' ? 'FETCHING...' : 'PREVIEW REMIX'}
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading !== null || !sourceUrl.trim()}
            className="px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
            style={{ fontFamily: 'Barlow Condensed', backgroundColor: 'var(--color-input)', color: 'var(--color-text)' }}
          >
            {loading === 'generate' ? 'GENERATING...' : 'GENERATE VIDEO'}
          </button>
          <div className="flex-1" />
          {preview && (
            <PlatformBadge platform="tiktok" />
          )}
        </div>
      </Panel>

      {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}

      {preview && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Barlow Condensed' }}>
              ADAPTED SCRIPT <span className="text-[var(--color-lime)]">FOR {niche.toUpperCase() || 'YOUR NICHE'}</span>
            </p>
            <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest">✓ READY TO REVIEW</span>
          </div>
          <div className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-4">
            <div className="text-[var(--color-lime)]">Hook: {preview.script.hook}</div>
            {preview.script.points.map((p, i) => (
              <div key={i} className="mt-1">Point {i + 1}: {p}</div>
            ))}
            <div className="mt-1 text-[var(--color-orange)]">CTA: {preview.script.cta}</div>
          </div>
          <details className="mt-4">
            <summary className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest cursor-pointer">Source transcript ({preview.transcript.videoId})</summary>
            <p className="text-[10px] font-mono text-[var(--color-muted-2)] mt-2 leading-relaxed">{preview.transcript.text}</p>
          </details>
        </div>
      )}

      {run && (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="text-sm font-black uppercase tracking-widest mb-3" style={{ fontFamily: 'Barlow Condensed' }}>
            RUN COMPLETE
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-mono">
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Run</span><div className="text-[var(--color-text)]">{run.runId.slice(0, 8)}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Queued for review</span><div className="text-[var(--color-lime)]">{run.reviewItemsCreated}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Est. cost</span><div className="text-[var(--color-text)]">${run.estimatedCostUsd?.toFixed(2) ?? 'n/a'}</div></div>
            <div><span className="text-[var(--color-muted-2)] uppercase tracking-widest">Overage</span><div className="text-[var(--color-orange)]">{run.overage ? `$${run.overage.priceUsdPerRun}/run` : 'none'}</div></div>
          </div>
        </div>
      )}
    </div>
  )
}
