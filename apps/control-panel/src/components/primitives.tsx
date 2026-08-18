import type { ReactNode } from 'react'
import type { Platform, ReviewItemStatus } from '../lib/types'

/** 0-100 progress bar — lime by default, any color allowed. */
export function ScoreBar({ score, color = 'var(--color-lime)' }: { score: number; color?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-[var(--color-faint)] rounded-none relative overflow-hidden">
        <div
          className="h-full transition-all duration-700"
          style={{ width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-mono text-[var(--color-lime)]">{score}</span>
    </div>
  )
}

const PLATFORM_META: Record<Platform, { label: string; color: string }> = {
  youtube_shorts: { label: 'YT', color: 'var(--color-red)' },
  instagram_reels: { label: 'IG', color: '#e1306c' },
  tiktok: { label: 'TT', color: '#00f0ff' },
  facebook: { label: 'FB', color: '#1877f2' }
}

export function PlatformBadge({ platform }: { platform: Platform }) {
  const meta = PLATFORM_META[platform] ?? { label: '??', color: 'var(--color-muted-4)' }
  return (
    <span
      className="text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-widest border"
      style={{
        color: meta.color,
        borderColor: meta.color + '44',
        backgroundColor: meta.color + '11'
      }}
    >
      {meta.label}
    </span>
  )
}

const STATUS_META: Record<ReviewItemStatus, { color: string; label: string }> = {
  pending: { color: 'var(--color-orange)', label: 'PENDING' },
  approved: { color: 'var(--color-lime)', label: 'READY' },
  rejected: { color: 'var(--color-muted)', label: 'REJECTED' }
}

export function StatusBadge({ status }: { status: ReviewItemStatus }) {
  const s = STATUS_META[status] ?? STATUS_META.pending
  return (
    <span
      className="text-[10px] font-mono px-1.5 py-0.5 uppercase tracking-widest border"
      style={{ color: s.color, borderColor: s.color + '44', backgroundColor: s.color + '11' }}
    >
      {s.label}
    </span>
  )
}

export function TrendIcon({ trend }: { trend: 'up' | 'down' | 'neutral' }) {
  if (trend === 'up') return <span className="text-[var(--color-lime)] text-sm">▲</span>
  if (trend === 'down') return <span className="text-[var(--color-red)] text-sm">▼</span>
  return <span className="text-[var(--color-muted-2)] text-sm">●</span>
}

export function Panel({
  title,
  action,
  children,
  className = ''
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <div className="border-b border-[var(--color-border)] px-5 py-3 flex items-center justify-between">
        <span className="text-sm font-semibold uppercase tracking-widest">
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  accent = 'var(--color-lime)'
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="bg-[var(--color-bg)] p-6 space-y-2">
      <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">{label}</p>
      <p className="text-5xl font-black leading-none font-mono" style={{ color: accent }}>
        {value}
      </p>
      {sub && <p className="text-[11px] font-mono text-[var(--color-muted-2)]">{sub}</p>}
    </div>
  )
}

/** Compact number formatting: 1200000 -> "1.2M", 82000000 -> "82M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

export function formatRelative(iso: string | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const days = Math.floor(diff / 86_400_000)
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diff / 3_600_000))
    return `${hours}h ago`
  }
  return `${days}d ago`
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return '$' + n.toFixed(2)
}

/** Derive a pseudo-handle from a real candidate id/title (server data only). */
export function platformLabel(p: Platform): 'youtube' | 'instagram' | 'tiktok' {
  if (p === 'youtube_shorts') return 'youtube'
  if (p === 'instagram_reels') return 'instagram'
  if (p === 'tiktok') return 'tiktok'
  return 'tiktok'
}
