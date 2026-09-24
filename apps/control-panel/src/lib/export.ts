import type { ReviewItem, RunSummary } from './types'
import { api } from './api'

/** Trigger a browser file download from a Blob or URL */
export function triggerFileDownload(content: Blob | string, filename: string, mimeType?: string) {
  let url: string
  let needRevoke = false

  if (typeof content === 'string') {
    if (content.startsWith('http') || content.startsWith('/') || content.startsWith('blob:')) {
      url = content
    } else {
      const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' })
      url = URL.createObjectURL(blob)
      needRevoke = true
    }
  } else {
    url = URL.createObjectURL(content)
    needRevoke = true
  }

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)

  if (needRevoke) {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/** Export a single review item as JSON */
export function exportSingleItemJson(item: ReviewItem) {
  const jsonStr = JSON.stringify(item, null, 2)
  const filename = `item_${item.id.slice(0, 8)}_${item.platform}_${item.niche}.json`
  triggerFileDownload(jsonStr, filename, 'application/json')
}

/** Export a single review item script as clean text */
export function exportSingleItemScript(item: ReviewItem) {
  const points = Array.isArray(item.script.points) ? item.script.points : []
  const lines = [
    `TITLE / HOOK: ${item.script.hook || ''}`,
    `PLATFORM: ${(item.platform || '').toUpperCase()}`,
    `NICHE: ${item.niche || ''}`,
    `STATUS: ${(item.status || '').toUpperCase()}`,
    `QA SCORE: ${item.score}/100`,
    `ESTIMATED DURATION: ${item.script.durationSec || 0}s`,
    `BRAND VOICE: ${item.script.brandVoice || ''}`,
    '',
    '--- SCRIPT POINTS ---',
    ...points.map((p, idx) => `[Point ${idx + 1}] ${p}`),
    '',
    `CALL TO ACTION (CTA): ${item.script.cta || ''}`,
    ...(item.captions && item.captions.length > 0
      ? ['', '--- CAPTIONS & TIMESTAMPS ---', ...item.captions.map((c) => `[${c.startSec}s - ${c.endSec}s] ${c.text}`)]
      : [])
  ]
  const filename = `script_${item.id.slice(0, 8)}.txt`
  triggerFileDownload(lines.join('\n'), filename, 'text/plain')
}

/** Download a single video file */
export function downloadSingleVideo(id: string, name?: string) {
  const url = api.mediaUrl(id)
  const filename = name ? `${name.replace(/[^a-z0-9_-]/gi, '_')}.mp4` : `video_${id.slice(0, 8)}.mp4`
  triggerFileDownload(url, filename)
}

/** Export multiple items as a comprehensive JSON archive */
export function exportBulkItemsJson(items: ReviewItem[], customName = 'vvugc_export') {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: items.length,
    items
  }
  const jsonStr = JSON.stringify(payload, null, 2)
  const filename = `${customName}_${new Date().toISOString().slice(0, 10)}.json`
  triggerFileDownload(jsonStr, filename, 'application/json')
}

/** Export items to CSV for spreadsheets / reporting */
export function exportBulkItemsCsv(items: ReviewItem[], customName = 'vvugc_items') {
  const headers = [
    'ID',
    'Status',
    'Platform',
    'Niche',
    'Hook',
    'QA Score',
    'Duration(s)',
    'Created At',
    'Published Post ID',
    'Published URL'
  ]

  const rows = items.map((i) => [
    `"${i.id}"`,
    `"${i.status}"`,
    `"${i.platform}"`,
    `"${(i.niche || '').replace(/"/g, '""')}"`,
    `"${(i.script?.hook || '').replace(/"/g, '""')}"`,
    i.score,
    i.script?.durationSec || 0,
    `"${i.createdAt}"`,
    `"${i.publishedPostId || ''}"`,
    `"${i.publishedUrl || ''}"`
  ])

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
  const filename = `${customName}_${new Date().toISOString().slice(0, 10)}.csv`
  triggerFileDownload(csvContent, filename, 'text/csv;charset=utf-8')
}

/** Trigger batch download of all videos in a list with sequential stagger */
export function downloadBulkVideos(items: ReviewItem[]) {
  const videoItems = items.filter((i) => Boolean(i.videoPath))
  if (videoItems.length === 0) {
    alert('No rendered video files found in the selected items to download.')
    return
  }

  videoItems.forEach((item, index) => {
    setTimeout(() => {
      downloadSingleVideo(item.id, `video_${item.id.slice(0, 8)}_${item.niche}`)
    }, index * 400)
  })
}

/** Export workflow runs summary as JSON */
export function exportRunsJson(runs: RunSummary[]) {
  const payload = {
    exportedAt: new Date().toISOString(),
    totalRuns: runs.length,
    runs
  }
  const jsonStr = JSON.stringify(payload, null, 2)
  const filename = `vvugc_runs_${new Date().toISOString().slice(0, 10)}.json`
  triggerFileDownload(jsonStr, filename, 'application/json')
}
