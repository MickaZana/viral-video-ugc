import { useEffect, useState } from 'react'
import type { ReviewItem } from '../lib/types'
import { api } from '../lib/api'
import { PlatformBadge, ScoreBar, StatusBadge, MockBadge, formatRelative } from './primitives'
import { exportSingleItemJson, exportSingleItemScript } from '../lib/export'

/**
 * ReviewModal — full-screen preview of a review item before approve/reject.
 * Shows the generated video with smart crop (object-position: top for vertical
 * shorts content — faces/action are at the top, not centered), script breakdown,
 * and action buttons.
 */
interface ReviewModalProps {
  item: ReviewItem
  onClose: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onPublish?: (id: string) => void
  onRegenerateLive?: (id: string) => void
  /** When false, the dashboard is in mock mode and live-only actions (publish,
   *  regenerate-live) are disabled. Undefined = not yet known (treat as enabled). */
  liveMode?: boolean
  onDownload: (id: string) => void
}

export function ReviewModal({ item, onClose, onApprove, onReject, onPublish, onRegenerateLive, liveMode, onDownload }: ReviewModalProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  async function handleApprove() {
    setActionLoading('approve')
    try { await api.approve(item.id) } catch { /* */ }
    finally { setActionLoading(null); onApprove(item.id) }
  }

  async function handleReject() {
    setActionLoading('reject')
    try { await api.reject(item.id) } catch { /* */ }
    finally { setActionLoading(null); onReject(item.id) }
  }

  async function handlePublish() {
    if (!onPublish) return
    setActionLoading('publish')
    try { await api.publish(item.id) } catch { /* */ }
    finally { setActionLoading(null); onPublish(item.id) }
  }

  async function handleRegenerateLive() {
    if (!onRegenerateLive) return
    setActionLoading('regenerate')
    try { await api.regenerateLive(item.id) } catch { /* */ }
    finally { setActionLoading(null); onRegenerateLive(item.id) }
  }

  const hasVideo = !!item.videoPath

  /**
   * Keyboard shortcuts for fast review — useful when approving a batch.
   * [A] approve, [R] reject, [Esc] close. Only fires when item is pending
   * (non-pending items have no approve/reject action to invoke).
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept when user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') { onClose(); return }
      if (item.status === 'pending') {
        if (e.key === 'a' || e.key === 'A') handleApprove()
        if (e.key === 'r' || e.key === 'R') handleReject()
      } else if (item.status === 'approved' && !item.dryRun && !item.publishedPostId && onPublish) {
        if (e.key === 'p' || e.key === 'P') handlePublish()
      } else if (item.dryRun && !item.publishedPostId && onRegenerateLive) {
        if (e.key === 'l' || e.key === 'L') handleRegenerateLive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.status])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-5xl max-h-[90vh] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="border-b border-[var(--color-border)] px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-text)' }}>
              REVIEW
            </span>
            <PlatformBadge platform={item.platform} />
            <StatusBadge status={item.status} />
            {item.dryRun && <MockBadge />}
            <span className="text-[10px] font-mono text-[var(--color-muted-3)]">{item.id.slice(0, 8)}</span>
          </div>
          <button
            onClick={onClose}
            className="text-[11px] font-mono text-[var(--color-muted-2)] hover:text-[var(--color-text)] transition-colors px-3 py-1 border border-[var(--color-faint)] hover:border-[var(--color-text)]"
          >
            ✕ CLOSE
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-0">
          {/* video preview — left */}
          <div className="bg-black flex items-center justify-center relative min-h-[400px]">
            {hasVideo ? (
              <video
                className="w-full h-full max-h-[70vh]"
                style={{
                  // Smart crop: object-fit cover fills the container,
                  // object-position top ensures faces/heads aren't cut off
                  // (vertical UGC content has the subject at the top, not center)
                  objectFit: 'cover',
                  objectPosition: 'top'
                }}
                controls
                autoPlay
                preload="auto"
                src={api.mediaUrl(item.id)}
              >
                <track kind="captions" />
              </video>
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 p-8">
                <div className="w-20 h-20 border border-[var(--color-faint)] flex items-center justify-center">
                  <span className="text-3xl text-[var(--color-muted-3)]">▶</span>
                </div>
                <p className="text-[11px] font-mono text-[var(--color-muted-3)] text-center">
                  Video not yet generated.<br />
                  Approve the script to trigger rendering.
                </p>
              </div>
            )}
            {/* aspect ratio indicator */}
            <div className="absolute top-3 right-3 text-[9px] font-mono text-white/60 bg-black/50 px-2 py-0.5">
              9:16 VERTICAL
            </div>
          </div>

          {/* script + details — right */}
          <div className="flex flex-col overflow-y-auto">
            {/* score */}
            <div className="px-6 py-4 border-b border-[var(--color-border)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Viral Score</span>
                <span className="text-3xl font-black" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-lime)' }}>
                  {item.score}
                </span>
              </div>
              <ScoreBar score={item.score} />
              {item.template && (
                <div className="mt-3 border border-[var(--color-lime)] p-3 space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">Template · {item.template.name}</span>
                      <span className="text-[9px] font-mono text-[var(--color-muted-3)] ml-2">v{item.template.version} · {item.template.category}</span>
                    </div>
                    {item.structuralScore !== undefined && (
                      <span className="text-[10px] font-mono text-[var(--color-lime)]">Structure {item.structuralScore}/100</span>
                    )}
                  </div>

                  {/* Hook patterns */}
                  <div>
                    <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">Hook patterns</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {item.template.hookPatterns.slice(0, 4).map((h, i) => (
                        <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 border border-[var(--color-faint)] text-[var(--color-muted-2)]">{h}</span>
                      ))}
                    </div>
                  </div>

                  {/* Script beats */}
                  <div>
                    <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">Script beats</span>
                    <ol className="mt-1 space-y-0.5">
                      {item.template.scriptStructure.map((b, i) => (
                        <li key={i} className="text-[10px] font-mono text-[var(--color-muted-2)] flex gap-2">
                          <span className="text-[var(--color-lime)] shrink-0">{i + 1}.</span>
                          <span>{b}</span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  {/* Direction */}
                  <div className="grid grid-cols-1 gap-1.5 text-[10px] font-mono">
                    <div><span className="text-[var(--color-muted-3)] uppercase tracking-widest">Visual:</span> <span className="text-[var(--color-muted-2)]">{item.template.visualDirection}</span></div>
                    <div><span className="text-[var(--color-muted-3)] uppercase tracking-widest">Camera:</span> <span className="text-[var(--color-muted-2)]">{item.template.cameraDirection}</span></div>
                    <div><span className="text-[var(--color-muted-3)] uppercase tracking-widest">Creator:</span> <span className="text-[var(--color-muted-2)]">{item.template.creatorDirection}</span></div>
                    <div><span className="text-[var(--color-muted-3)] uppercase tracking-widest">Product:</span> <span className="text-[var(--color-muted-2)]">{item.template.productPlacementDirection}</span></div>
                    <div><span className="text-[var(--color-muted-3)] uppercase tracking-widest">Captions:</span> <span className="text-[var(--color-muted-2)]">{item.template.captionStyle}</span></div>
                  </div>

                  {/* QA rubric */}
                  <div>
                    <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">QA rubric</span>
                    <p className="text-[10px] font-mono text-[var(--color-muted-2)] mt-0.5">{item.template.qaRubric.join(' · ')}</p>
                  </div>

                  {/* Forbidden patterns — only show when there are some */}
                  {item.template.forbiddenPatterns.length > 0 && (
                    <div>
                      <span className="text-[9px] font-mono text-[var(--color-red)] uppercase tracking-widest">Forbidden</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {item.template.forbiddenPatterns.slice(0, 6).map((f, i) => (
                          <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 border border-[var(--color-red)] text-[var(--color-red)]">{f}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {item.originalityScore !== undefined && (
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Originality</span>
                  <span className="text-sm font-mono" style={{ color: item.originalityScore >= 70 ? 'var(--color-lime)' : 'var(--color-orange)' }}>
                    {item.originalityScore}/100
                  </span>
                </div>
              )}
              {item.flags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.flags.map((f, i) => (
                    <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 border border-[var(--color-orange)] text-[var(--color-orange)]">
                      ⚠ {f}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* script breakdown */}
            <div className="px-6 py-4 border-b border-[var(--color-border)] flex-1">
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mb-3">SCRIPT</p>
              <div className="space-y-3">
                <div>
                  <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">Hook</span>
                  <p className="text-sm font-mono text-[var(--color-lime)] mt-0.5">{item.script.hook}</p>
                </div>
                <div>
                  <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">Points</span>
                  {item.script.points.map((p, i) => (
                    <p key={i} className="text-sm font-mono text-[var(--color-text)] mt-0.5">
                      <span className="text-[var(--color-muted-3)]">{i + 1}.</span> {p}
                    </p>
                  ))}
                </div>
                <div>
                  <span className="text-[9px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">CTA</span>
                  <p className="text-sm font-mono text-[var(--color-orange)] mt-0.5">{item.script.cta}</p>
                </div>
              </div>

              {/* metadata */}
              <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div className="border border-[var(--color-raised)] p-2">
                  <span className="text-[var(--color-muted-3)] uppercase tracking-widest">Niche</span>
                  <p className="text-[var(--color-text)] mt-0.5">{item.niche}</p>
                </div>
                <div className="border border-[var(--color-raised)] p-2">
                  <span className="text-[var(--color-muted-3)] uppercase tracking-widest">Duration</span>
                  <p className="text-[var(--color-text)] mt-0.5">{item.script.durationSec}s</p>
                </div>
                <div className="border border-[var(--color-raised)] p-2">
                  <span className="text-[var(--color-muted-3)] uppercase tracking-widest">Created</span>
                  <p className="text-[var(--color-text)] mt-0.5">{formatRelative(item.createdAt)}</p>
                </div>
                <div className="border border-[var(--color-raised)] p-2">
                  <span className="text-[var(--color-muted-3)] uppercase tracking-widest">Run</span>
                  <p className="text-[var(--color-text)] mt-0.5 truncate">{item.runId.slice(0, 8)}</p>
                </div>
              </div>
            </div>

            {/* actions footer */}
            <div className="px-6 py-4 flex items-center gap-3 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
              {item.status === 'pending' && (
                <>
                  <button
                    onClick={handleApprove}
                    disabled={actionLoading === 'approve'}
                    className="flex-1 px-4 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50 hover:brightness-110"
                    style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                  >
                    {actionLoading === 'approve' ? 'APPROVING...' : '✓ APPROVE FOR PRODUCTION'}
                  </button>
                  <button
                    onClick={handleReject}
                    disabled={actionLoading === 'reject'}
                    className="px-4 py-3 font-black uppercase tracking-widest text-sm border border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white transition-colors disabled:opacity-50"
                    style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}
                  >
                    {actionLoading === 'reject' ? '...' : '✗ REJECT'}
                  </button>
                </>
              )}
              {item.status === 'approved' && !item.dryRun && !item.publishedPostId && (
                <button
                  onClick={handlePublish}
                  disabled={actionLoading === 'publish' || liveMode === false}
                  className="flex-1 px-4 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50 hover:brightness-110"
                  style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                >
                  {actionLoading === 'publish' ? 'PUBLISHING...' : '↗ PUBLISH NOW'}
                </button>
              )}
              {item.status === 'approved' && (
                <button
                  onClick={() => onDownload(item.id)}
                  className="px-4 py-3 font-black uppercase tracking-widest text-sm transition-colors hover:brightness-110 disabled:opacity-50"
                  style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                >
                  ↓ EXPORT VIDEO
                </button>
              )}
              {item.dryRun && !item.publishedPostId && (
                <button
                  onClick={handleRegenerateLive}
                  disabled={actionLoading === 'regenerate' || liveMode === false}
                  className="flex-1 px-4 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50 hover:brightness-110"
                  style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-orange)', color: 'black' }}
                >
                  {actionLoading === 'regenerate' ? 'REGENERATING...' : '↻ REGENERATE LIVE'}
                </button>
              )}
              {!item.publishedPostId && liveMode === false && (
                <span className="text-[10px] font-mono text-[var(--color-orange)] uppercase tracking-widest">
                  Mock mode — run dashboard live to enable
                </span>
              )}
              {item.status === 'rejected' && (
                <span className="text-[11px] font-mono text-[var(--color-muted-3)] uppercase tracking-widest">This item was rejected.</span>
              )}
              {hasVideo && (
                <button
                  onClick={() => onDownload(item.id)}
                  className="px-4 py-3 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-lime)] text-[var(--color-lime)] hover:bg-[var(--color-lime)] hover:text-[var(--color-on-accent)] transition-colors"
                  title="Download MP4 Video"
                >
                  ↓ MP4
                </button>
              )}
              <button
                onClick={() => exportSingleItemScript(item)}
                className="px-4 py-3 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors"
                title="Export Script as TXT"
              >
                ↓ SCRIPT
              </button>
              <button
                onClick={() => exportSingleItemJson(item)}
                className="px-4 py-3 text-[10px] font-mono uppercase tracking-widest border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors"
                title="Export Full Item JSON"
              >
                ↓ JSON
              </button>
            </div>
            {/* Keyboard shortcut hint — shown for actionable states */}
            {item.status === 'pending' && (
              <div className="px-6 pb-3 text-[9px] font-mono text-[var(--color-muted-3)] text-center tracking-widest">
                [A] Approve &nbsp;·&nbsp; [R] Reject &nbsp;·&nbsp; [Esc] Close
              </div>
            )}
            {item.status === 'approved' && !item.dryRun && !item.publishedPostId && (
              <div className="px-6 pb-3 text-[9px] font-mono text-[var(--color-muted-3)] text-center tracking-widest">
                [P] Publish &nbsp;·&nbsp; [Esc] Close
              </div>
            )}
            {item.dryRun && !item.publishedPostId && (
              <div className="px-6 pb-3 text-[9px] font-mono text-[var(--color-muted-3)] text-center tracking-widest">
                [L] Regenerate live &nbsp;·&nbsp; [Esc] Close
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
