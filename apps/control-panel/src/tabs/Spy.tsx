import { useState } from 'react'
import type { TrackedCreator } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar, TrendIcon, formatCompact, formatRelative } from '../components/primitives'
import { creatorScore } from './Dashboard'

type PlatformFilter = 'all' | 'youtube_shorts' | 'instagram_reels' | 'tiktok'

/**
 * Creator Spy — real tracked creators derived from the backend's /creators
 * connection (real discovery candidates recorded in run manifests). Selecting a
 * creator shows its real metrics, source posts, and platform. No mock data.
 */
export function Spy() {
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
            <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-4 py-6">No discovered sources yet.</p>
          )}
        </div>
      </div>

      {/* creator detail */}
      <div className="lg:col-span-2 space-y-4">
        {selected ? (
          <CreatorDetail c={selected} />
        ) : (
          <Panel title="NO SOURCE SELECTED">
            <p className="text-[11px] font-mono text-[var(--color-muted-2)] px-5 py-6">No discovered creators to inspect.</p>
          </Panel>
        )}
      </div>

      {creators.error && <p className="text-[11px] font-mono text-[var(--color-red)]">{creators.error}</p>}
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
            <h2 className="text-4xl font-black mt-2" style={{ fontFamily: 'Barlow Condensed', color: 'var(--color-text)' }}>
              {c.label}
            </h2>
            <p className="text-sm font-mono text-[var(--color-muted-2)] mt-1">{c.niche} · {formatCompact(c.views)} views</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Viral Score</p>
            <p className="text-6xl font-black" style={{ fontFamily: 'Barlow Condensed', color: 'var(--color-lime)' }}>
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
        <p className="text-sm font-black uppercase tracking-widest mb-3" style={{ fontFamily: 'Barlow Condensed' }}>
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
