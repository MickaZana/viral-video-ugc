import { useState, useRef, useEffect } from 'react'
import type { ReviewItem, RunSummary } from '../lib/types'
import {
  exportBulkItemsJson,
  exportBulkItemsCsv,
  downloadBulkVideos,
  exportRunsJson
} from '../lib/export'

interface GlobalExportButtonProps {
  items: ReviewItem[]
  runs: RunSummary[]
}

/**
 * GlobalExportButton — A prominent, always-visible download/export dropdown
 * that lives in the top nav bar. Provides one-click access to all export
 * formats without needing to navigate to the History tab.
 */
export function GlobalExportButton({ items, runs }: GlobalExportButtonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const videoCount = items.filter((i) => Boolean(i.videoPath)).length
  const totalItems = items.length
  const hasContent = totalItems > 0 || runs.length > 0

  return (
    <div ref={ref} className="relative">
      {/* Main Export Button — prominent, always visible */}
      <button
        onClick={() => setOpen(!open)}
        disabled={!hasContent}
        className="flex items-center gap-2 px-4 py-2.5 border-2 transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
        style={{
          borderColor: 'var(--color-lime)',
          color: open ? 'var(--color-on-accent)' : 'var(--color-lime)',
          backgroundColor: open ? 'var(--color-lime)' : 'transparent',
        }}
        title="Download & Export all content"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 2v9M4.5 7.5 8 11l3.5-3.5M3 13h10" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="header-export-label text-[11px] font-mono uppercase tracking-widest font-bold">
          Export
        </span>
        {hasContent && (
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded-sm"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            {totalItems}
          </span>
        )}
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-72 border z-50 shadow-xl"
          style={{
            borderColor: 'var(--color-border)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          {/* Header */}
          <div
            className="px-4 py-3 border-b"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--color-muted-2)' }}>
              Quick Export
            </p>
            <p className="text-[11px] font-mono mt-1" style={{ color: 'var(--color-text)' }}>
              {totalItems} items · {videoCount} videos · {runs.length} runs
            </p>
          </div>

          {/* Export Options */}
          <div className="p-2 space-y-1">
            {/* Videos Download */}
            <ExportOption
              icon="▶"
              label="Download All Videos"
              sublabel={`${videoCount} MP4 files`}
              disabled={videoCount === 0}
              accent
              onClick={() => { downloadBulkVideos(items); setOpen(false) }}
            />

            <div className="h-px my-2" style={{ backgroundColor: 'var(--color-border)' }} />

            {/* Data Exports */}
            <ExportOption
              icon="{ }"
              label="Export All Items (JSON)"
              sublabel="Full data archive"
              disabled={totalItems === 0}
              onClick={() => { exportBulkItemsJson(items, 'vvugc_all'); setOpen(false) }}
            />
            <ExportOption
              icon="▤"
              label="Export All Items (CSV)"
              sublabel="Spreadsheet format"
              disabled={totalItems === 0}
              onClick={() => { exportBulkItemsCsv(items, 'vvugc_all'); setOpen(false) }}
            />
            <ExportOption
              icon="⟳"
              label="Export Workflow Runs"
              sublabel={`${runs.length} run logs (JSON)`}
              disabled={runs.length === 0}
              onClick={() => { exportRunsJson(runs); setOpen(false) }}
            />

            <div className="h-px my-2" style={{ backgroundColor: 'var(--color-border)' }} />

            {/* Filtered Exports */}
            <ExportOption
              icon="✓"
              label="Export Approved Only"
              sublabel={`${items.filter(i => i.status === 'approved').length} approved items`}
              disabled={items.filter(i => i.status === 'approved').length === 0}
              onClick={() => {
                const approved = items.filter(i => i.status === 'approved')
                exportBulkItemsJson(approved, 'vvugc_approved')
                setOpen(false)
              }}
            />
            <ExportOption
              icon="★"
              label="Export Top Scored (80+)"
              sublabel={`${items.filter(i => i.score >= 80).length} high-quality items`}
              disabled={items.filter(i => i.score >= 80).length === 0}
              onClick={() => {
                const topScored = items.filter(i => i.score >= 80)
                exportBulkItemsJson(topScored, 'vvugc_top_scored')
                setOpen(false)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function ExportOption({ icon, label, sublabel, disabled, accent, onClick }: {
  icon: string
  label: string
  sublabel: string
  disabled?: boolean
  accent?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors rounded-sm disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--color-raised)]"
    >
      <span
        className="w-7 h-7 flex items-center justify-center text-xs shrink-0 rounded-sm"
        style={{
          backgroundColor: accent ? 'var(--color-lime)' : 'var(--color-raised)',
          color: accent ? 'var(--color-on-accent)' : 'var(--color-muted-2)',
        }}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p
          className="text-[11px] font-mono truncate"
          style={{ color: accent ? 'var(--color-lime)' : 'var(--color-text)' }}
        >
          {label}
        </p>
        <p className="text-[9px] font-mono truncate" style={{ color: 'var(--color-muted-4)' }}>
          {sublabel}
        </p>
      </div>
    </button>
  )
}
