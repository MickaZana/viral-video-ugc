import { useNavigate } from 'react-router-dom'
import { paths } from '../lib/paths'
import { useState } from 'react'
import type { TrackedCreator, DiscoverResponse, DiscoverBrief } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar, TrendIcon, formatCompact, formatRelative } from '../components/primitives'
import { creatorScore } from './Dashboard'
import { EmptyState } from '../components/EmptyState'

type PlatformFilter = 'all' | 'youtube_shorts' | 'instagram_reels' | 'tiktok'

/**
 * Creator Spy — real tracked creators derived from the backend's /creators
 * connection (real discovery candidates recorded in run manifests). Selecting a
 * creator shows its real metrics, source posts, and platform. No mock data.
 */
export function Spy() {
  const navigate = useNavigate()
  const creators = useApi(() => api.creators())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [platform, setPlatform] = useState<PlatformFilter>('all')

  const list = creators.data ?? []
  const selected = list.find((c) => platformKey(c) === selectedId) ?? list[0] ?? null

  const filtered = list.filter((c) => platform === 'all' || c.platform === platform)

  function select(c: TrackedCreator) {
    setSelectedId(platformKey(c))
  }

  return (
    <div className="space-y-6">
      <DiscoverPanel />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
      {/* creator list */}
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] px-4 py-3 flex items-center gap-2">
          {(['all', 'youtube_shorts', 'instagram_reels', 'tiktok'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 border transition-colors"
              style={{
                color: platform === p ? 'var(--color-on-accent)' : 'var(--color-muted)',
                backgroundColor: platform === p ? 'var(--color-lime)' : 'transparent',
                borderColor: platform === p ? 'var(--color-lime)' : 'var(--color-faint)'
              }}
            >
              {platformShort(p)}
            </button>
          ))}
          <span className="ml-auto text-[10px] font-mono text-[var(--color-muted-2)]">{filtered.length} sources</span>
        </div>
        <div>
          {filtered.map((c) => (
            <div
              key={platformKey(c)}
              onClick={() => select(c)}
              className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--color-raised)] cursor-pointer transition-colors"
              style={{
                backgroundColor: selected && platformKey(selected) === platformKey(c) ? 'var(--color-raised)' : 'transparent',
                borderLeft: selected && platformKey(selected) === platformKey(c) ? '2px solid var(--color-lime)' : '2px solid transparent'
              }}
            >
              <div className="w-8 h-8 rounded-none bg-[var(--color-faint)] flex items-center justify-center text-[10px] font-mono text-[var(--color-muted-4)] uppercase shrink-0">
                {initials(c.label)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono text-[var(--color-text)] truncate">{c.label}</p>
                <p className="text-[10px] font-mono text-[var(--color-muted-2)]">{c.niche} · {formatCompact(c.views)} views</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <PlatformBadge platform={c.platform} />
                <TrendIcon trend={c.views > 0 ? 'up' : 'neutral'} />
              </div>
            </div>
          ))}
          {filtered.length === 0 && !creators.loading && (
            <EmptyState
              icon="◈"
              title="NO SOURCES DISCOVERED"
              description="Run the pipeline to discover viral creators. The Creator Spy fills up automatically as you track more niches."
              actionLabel="RUN PIPELINE"
              onAction={() => navigate(paths.studio)}
            />
          )}
        </div>
      </div>

      {/* creator detail */}
      <div className="lg:col-span-2 space-y-4">
        {selected ? (
          <CreatorDetail c={selected} />
        ) : (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
            <EmptyState
              icon="◈"
              title="SELECT A SOURCE"
              description="Click a creator from the list to see their viral metrics, tracked runs, and AI intel summary."
            />
          </div>
        )}
      </div>

      {creators.error && <p className="text-[11px] font-mono text-[var(--color-red)]">{creators.error}</p>}
      </div>
    </div>
  )
}

function DiscoverPanel() {
  const navigate = useNavigate()
  const [niche, setNiche] = useState('')
  const [platform, setPlatform] = useState<'tiktok' | 'youtube_shorts' | 'instagram_reels'>('tiktok')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<DiscoverResponse | null>(null)
  const [brief, setBrief] = useState<DiscoverBrief | null>(null)
  const [err, setErr] = useState<string | null>(null)

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
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as 'tiktok' | 'youtube_shorts' | 'instagram_reels')}
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

function CreatorDetail({ c }: { c: TrackedCreator }) {
  const score = creatorScore(c)
  const topics = c.niche.split(/[,\s]+/).filter(Boolean).slice(0, 3)

  const meta = [
    { label: 'Last Source', value: formatRelative(c.publishedAt) },
    { label: 'Peak Views', value: formatCompact(c.views) },
    { label: 'Velocity', value: c.velocityScore > 0 ? formatCompact(c.velocityScore) : '—' }
  ]

  return (
    <>
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <PlatformBadge platform={c.platform} />
              <span className="text-[10px] font-mono text-[var(--color-muted-2)]">SURVEILLANCE ACTIVE</span>
              <span className="text-[10px] font-mono text-[var(--color-lime)] pulse-lime">●</span>
            </div>
            <h2 className="text-4xl font-black mt-2" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-text)' }}>
              {c.label}
            </h2>
            <p className="text-sm font-mono text-[var(--color-muted-2)] mt-1">{c.niche} · {formatCompact(c.views)} views</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Viral Score</p>
            <p className="text-6xl font-black" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-lime)' }}>
              {score}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-6">
          {meta.map((m) => (
            <div key={m.label} className="border border-[var(--color-raised)] p-3">
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mb-1">{m.label}</p>
              <p className="text-lg font-mono text-[var(--color-text)]">{m.value}</p>
            </div>
          ))}
        </div>

        <div>
          <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mb-2">Tracked In</p>
          <div className="flex flex-wrap gap-2">
            {c.runs.map((r) => (
              <span key={r} className="text-[11px] font-mono px-2 py-1 border border-[var(--color-faint)] text-[var(--color-muted-4)] uppercase tracking-wider">
                {r}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="text-sm font-black uppercase tracking-widest mb-3" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
          AI INTEL SUMMARY
        </p>
        <p className="text-sm font-mono text-[var(--color-muted-4)] leading-relaxed">
          Source <span className="text-[var(--color-lime)]">{c.label}</span> is tracked in{' '}
          <span className="text-[var(--color-lime)]">{c.runs.length} run(s)</span> across{' '}
          <span className="text-[var(--color-lime)]">{c.platform}</span>. Discovered source views:{' '}
          <span className="text-[var(--color-lime)]">{formatCompact(c.views)}</span>. Primary topics:{' '}
          <span className="text-[var(--color-orange)]">{topics.length ? topics.join(', ') : c.niche}</span>.
        </p>
        <div className="mt-4">
          <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mb-2">Viral Score</p>
          <ScoreBar score={score} />
        </div>
      </div>
    </>
  )
}

/** Stable key for a creator: platform + source id. */
function platformKey(c: TrackedCreator): string {
  return `${c.platform}:${c.sourceId}`
}

function initials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

function platformShort(p: PlatformFilter): string {
  if (p === 'all') return 'ALL'
  if (p === 'youtube_shorts') return 'YT'
  if (p === 'instagram_reels') return 'IG'
  return 'TT'
}

/** Labelled "why it works" group — hook / format / pattern. */
function WhyGroup({ label, items }: { label: string; items: string[] }) {
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
function EditableList({ items, onChange, placeholder }: {
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
