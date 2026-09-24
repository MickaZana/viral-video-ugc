import { useNavigate } from 'react-router-dom'
import { paths } from '../lib/paths'
import { useEffect, useState } from 'react'
import type { DiscoverResponse, DiscoverBrief, TrendsResponse } from '../lib/types'
import { api } from '../lib/api'
import { PlatformBadge, formatCompact } from './primitives'

/**
 * Discovery — "what's working now" panel. Runs the real /accounts/discover call,
 * explains WHY each found video works (hook / format / pattern), and produces a
 * riff-able brief the operator can edit before kicking off a run. Shared by the
 * Intel (Spy) tab and the Studio so discovery is one continuous step in the
 * through-line rather than a siloed screen.
 */
export function DiscoverPanel() {
  const navigate = useNavigate()
  const [niche, setNiche] = useState('')
  const [platform, setPlatform] = useState<'tiktok' | 'youtube_shorts' | 'instagram_reels'>('tiktok')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<DiscoverResponse | null>(null)
  const [brief, setBrief] = useState<DiscoverBrief | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [trends, setTrends] = useState<TrendsResponse | null>(null)

  // Proactive discovery — seed the niche box with what's already working in this
  // org's history so the operator can start from a suggestion instead of a blank.
  useEffect(() => {
    api.trends().then(setTrends).catch(() => {})
  }, [])

  async function runDiscover() {
    if (!niche.trim()) return
    setLoading(true)
    setErr(null)
    try {
      const res = await api.discover({ niche: niche.trim(), platform })
      setData(res)
      setBrief(res.brief)
    } catch {
      setErr('Discovery failed — try again')
    } finally {
      setLoading(false)
    }
  }

  async function startFromBrief() {
    setLoading(true)
    try {
      const { runId } = await api.start({ niche: niche.trim(), brief: brief ?? undefined })
      navigate(paths.studioRun(runId), { state: { brief: brief ?? undefined } })
    } catch {
      setLoading(false)
    }
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 bg-[var(--color-lime)]" />
        <span className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">Discovery — what's working now</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          placeholder="Enter a niche (e.g. anti-anxiety dog gear)"
          className="flex-1 min-w-[200px] bg-[var(--color-raised)] border border-[var(--color-faint)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted-3)] focus:border-[var(--color-lime)] outline-none"
        />
        {trends && trends.suggestedNiches.length > 0 && (
          <div className="w-full flex flex-wrap items-center gap-1.5 mt-1">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-3)]">Trending:</span>
            {trends.suggestedNiches.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNiche(n)}
                className="text-[10px] font-mono px-2 py-0.5 border border-[var(--color-faint)] text-[var(--color-lime)] hover:border-[var(--color-lime)] transition-colors"
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as 'tiktok' | 'youtube_shorts' | 'instagram_reels')}
          aria-label="Platform to discover"
          className="bg-[var(--color-raised)] border border-[var(--color-faint)] px-2 py-2 text-sm text-[var(--color-text)]"
        >
          <option value="tiktok">TikTok</option>
          <option value="youtube_shorts">YouTube Shorts</option>
          <option value="instagram_reels">Instagram Reels</option>
        </select>
        <button
          onClick={runDiscover}
          disabled={loading}
          className="px-4 py-2 text-sm font-semibold uppercase tracking-widest disabled:opacity-50"
          style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
        >
          {loading ? '…' : 'Discover'}
        </button>
      </div>
      {err && <p className="text-[11px] font-mono text-[var(--color-red)]">{err}</p>}
      {data && (
        <div className="space-y-4">
          <div className="border border-[var(--color-raised)] p-4 space-y-3">
            <p className="text-[10px] uppercase tracking-widest text-[var(--color-lime)]">Brief — riff on this</p>
            {brief && (
              <>
                <label className="block">
                  <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Angle</span>
                  <input
                    value={brief.angle}
                    onChange={(e) => setBrief({ ...brief, angle: e.target.value })}
                    className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-2 focus:outline-none focus:border-[var(--color-lime)]"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Hook template</span>
                  <input
                    value={brief.hookTemplate}
                    onChange={(e) => setBrief({ ...brief, hookTemplate: e.target.value })}
                    className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-2 focus:outline-none focus:border-[var(--color-lime)]"
                  />
                </label>
                <div>
                  <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Structure</span>
                  <div className="mt-1">
                    <EditableList items={brief.structure} onChange={(structure) => setBrief({ ...brief, structure })} placeholder="Add a step" />
                  </div>
                </div>
                <label className="block">
                  <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Patterns (comma-separated)</span>
                  <input
                    value={brief.patterns.join(', ')}
                    onChange={(e) => setBrief({ ...brief, patterns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                    className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-2 focus:outline-none focus:border-[var(--color-lime)]"
                  />
                </label>
                <div>
                  <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest">Do</span>
                  <div className="mt-1">
                    <EditableList items={brief.dos} onChange={(dos) => setBrief({ ...brief, dos })} placeholder="Add a do" />
                  </div>
                </div>
                <div>
                  <span className="text-[10px] font-mono text-[var(--color-red)] uppercase tracking-widest">Don't</span>
                  <div className="mt-1">
                    <EditableList items={brief.donts} onChange={(donts) => setBrief({ ...brief, donts })} placeholder="Add a don't" />
                  </div>
                </div>
              </>
            )}
            <button
              onClick={startFromBrief}
              disabled={loading}
              className="px-4 py-2 text-sm font-semibold uppercase tracking-widest disabled:opacity-50"
              style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
            >
              Start a run from this brief
            </button>
          </div>
          {data.videos.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {data.videos.map((v) => (
                <div key={v.id} className="border border-[var(--color-raised)] p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-mono text-[var(--color-text)]">{v.author}</span>
                    <PlatformBadge platform={v.platform} />
                  </div>
                  <p className="text-[10px] font-mono text-[var(--color-muted-2)]">{formatCompact(v.metrics.views)} views · {formatCompact(v.metrics.likes)} likes</p>
                  <div className="mt-2 space-y-1.5">
                    <WhyGroup label="Hook" items={v.whyItWorks.hook} />
                    <WhyGroup label="Format" items={v.whyItWorks.format} />
                    <WhyGroup label="Pattern" items={v.whyItWorks.pattern} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--color-muted-4)]">No live sources returned (offline or no API keys) — the brief above is still a solid starting point.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** Labelled "why it works" group — hook / format / pattern. */
export function WhyGroup({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)]">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] text-[var(--color-muted-4)]">• {it}</li>
        ))}
      </ul>
    </div>
  )
}

/** Inline editable string list used by the riff-able brief editor. */
export function EditableList({ items, onChange, placeholder }: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={it}
            placeholder={placeholder}
            onChange={(e) => {
              const next = [...items]
              next[i] = e.target.value
              onChange(next)
            }}
            className="flex-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-[11px] p-1.5 focus:outline-none focus:border-[var(--color-lime)]"
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="text-[var(--color-muted-3)] hover:text-[var(--color-red)] text-sm px-1"
            aria-label="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, ''])}
        className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]"
      >
        + Add
      </button>
    </div>
  )
}
