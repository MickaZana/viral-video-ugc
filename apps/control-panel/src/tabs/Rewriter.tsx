import { useEffect, useState } from 'react'
import type { ReviewItem } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, PlatformBadge, ScoreBar } from '../components/primitives'

/**
 * Script Rewriter — real data and real regeneration. The user selects an actual
 * review item from the backend /queue, edits its script (hook/points/cta), and
 * submits it to POST /queue/:id/regenerate-script, which runs the real
 * orchestration regeneration and returns the updated item. No mock output.
 */
export function Rewriter() {
  const queue = useApi(() => api.queue())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hook, setHook] = useState('')
  const [points, setPoints] = useState('')
  const [cta, setCta] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [result, setResult] = useState<ReviewItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  const items = queue.data ?? []

  useEffect(() => {
    // Auto-select the first real item once the queue loads.
    if (selectedId === null && items.length > 0) {
      selectItem(items[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.loading])

  function selectItem(id: string) {
    const item = items.find((i) => i.id === id)
    if (!item) return
    setSelectedId(id)
    setHook(item.script.hook)
    setPoints(item.script.points.join('\n'))
    setCta(item.script.cta)
    setDone(false)
    setResult(null)
    setError(null)
  }

  async function handleRewrite() {
    if (!selectedId) return
    setLoading(true)
    setDone(false)
    setError(null)
    try {
      const updated = await api.regenerateScript(selectedId, {
        hook,
        points: points.split('\n').map((s) => s.trim()).filter(Boolean),
        cta
      })
      setResult(updated)
      setDone(true)
      // Reflect the real result into the editor.
      setHook(updated.script.hook)
      setPoints(updated.script.points.join('\n'))
      setCta(updated.script.cta)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const metrics = done && result
    ? [
        { label: 'Hook Strength', score: result.score, color: 'var(--color-lime)' },
        { label: 'Originality', score: result.originalityScore ?? 0, color: result.originalityScore !== undefined && result.originalityScore >= 70 ? 'var(--color-lime)' : 'var(--color-orange)' },
        { label: 'Flags Cleared', score: Math.max(0, 100 - result.flags.length * 15), color: result.flags.length === 0 ? 'var(--color-lime)' : 'var(--color-orange)' }
      ]
    : null

  return (
    <div className="space-y-6">
      {/* source selector */}
      <Panel title="SOURCE REVIEW ITEM">
        <div className="flex flex-wrap gap-2 px-5 py-3">
          {items.map((i) => (
            <button
              key={i.id}
              onClick={() => selectItem(i.id)}
              className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 border transition-colors flex items-center gap-2"
              style={{
                color: selectedId === i.id ? 'var(--color-on-accent)' : 'var(--color-muted-4)',
                backgroundColor: selectedId === i.id ? 'var(--color-lime)' : 'transparent',
                borderColor: selectedId === i.id ? 'var(--color-lime)' : 'var(--color-faint)'
              }}
            >
              {i.script.hook.slice(0, 28)}
              <PlatformBadge platform={i.platform} />
            </button>
          ))}
          {items.length === 0 && !queue.loading && (
            <span className="text-[11px] font-mono text-[var(--color-muted-2)]">No review items yet — run the pipeline first.</span>
          )}
        </div>
      </Panel>

      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Barlow Condensed' }}>
            ORIGINAL VIRAL SCRIPT
          </p>
          {selectedId && <span className="text-[10px] font-mono text-[var(--color-muted-2)]">{selectedId}</span>}
        </div>
        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Hook</span>
            <input
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              value={hook}
              onChange={(e) => setHook(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Points (one per line)</span>
            <textarea
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 resize-none focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              rows={5}
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">CTA</span>
            <input
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              value={cta}
              onChange={(e) => setCta(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleRewrite}
          disabled={loading || !selectedId}
          className="px-8 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
          style={{
            fontFamily: 'Barlow Condensed',
            backgroundColor: loading ? 'var(--color-muted-3)' : 'var(--color-lime)',
            color: 'var(--color-on-accent)'
          }}
        >
          {loading ? 'REWRITING...' : 'REWRITE FOR VIRAL'}
        </button>
        <div className="flex-1 h-px bg-[var(--color-raised)]" />
        {done && result && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest">Viral Score</span>
            <span className="text-2xl font-black" style={{ fontFamily: 'Barlow Condensed', color: 'var(--color-lime)' }}>
              {result.score}
            </span>
          </div>
        )}
      </div>

      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Barlow Condensed' }}>
            AI REWRITTEN SCRIPT
          </p>
          {loading && (
            <span className="text-[10px] font-mono text-[var(--color-orange)] uppercase tracking-widest">
              GENERATING<span className="blink">_</span>
            </span>
          )}
          {done && (
            <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest">✓ READY TO REVIEW</span>
          )}
        </div>
        <div className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-lime)] font-mono text-sm p-4 min-h-[180px] whitespace-pre-wrap">
          {result ? (
            <>
              <div className="text-[var(--color-text)]">Hook: {result.script.hook}</div>
              {result.script.points.map((p, i) => (
                <div key={i} className="mt-1">Point {i + 1}: {p}</div>
              ))}
              <div className="mt-1 text-[var(--color-orange)]">CTA: {result.script.cta}</div>
            </>
          ) : loading ? (
            <span className="blink text-[var(--color-lime)]">█</span>
          ) : (
            <span className="text-[var(--color-faint)]">Output will appear here after rewrite...</span>
          )}
        </div>
      </div>

      {error && <p className="text-[11px] font-mono text-[var(--color-red)]">{error}</p>}

      {metrics && (
        <div className="grid grid-cols-3 gap-4">
          {metrics.map((m) => (
            <div key={m.label} className="border border-[var(--color-raised)] bg-[var(--color-surface)] p-4">
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mb-2">{m.label}</p>
              <ScoreBar score={m.score} color={m.color} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
