import { useEffect, useRef, useState } from 'react'

/**
 * PipelineProgress — real-time progress indicator during pipeline runs.
 * Connects to SSE endpoint /api/accounts/run-progress/:runId for live updates.
 * Falls back to polling/estimation when SSE is unavailable.
 *
 * 9-stage pipeline (matching backend):
 * discovery → transcript → script → voiceover → video → assembly → qa → queue → complete
 */

export interface ProgressEvent {
  stage: string
  status: 'start' | 'progress' | 'done' | 'error'
  message: string
  stageProgress?: number
  overallProgress: number
  elapsedMs: number
  etaMs?: number
  timestamp: string
  detail?: Record<string, unknown>
}

export interface PipelineStep {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
  duration?: number
}

const PIPELINE_STAGES: { id: string; label: string }[] = [
  { id: 'discovery', label: 'DISCOVER' },
  { id: 'transcript', label: 'TRANSCRIPT' },
  { id: 'script', label: 'SCRIPT' },
  { id: 'voiceover', label: 'VOICE' },
  { id: 'video', label: 'VIDEO' },
  { id: 'assembly', label: 'ASSEMBLY' },
  { id: 'qa', label: 'QA' },
  { id: 'queue', label: 'QUEUE' },
  { id: 'complete', label: 'DONE' }
]

interface PipelineProgressProps {
  /** Whether the pipeline is actively running */
  active: boolean
  /** Run ID being tracked — used to connect to SSE */
  runId?: string
  /** Called when pipeline completes */
  onComplete?: () => void
}

export function PipelineProgress({ active, runId, onComplete }: PipelineProgressProps) {
  const [steps, setSteps] = useState<PipelineStep[]>(
    PIPELINE_STAGES.map((s) => ({ id: s.id, label: s.label, status: 'pending' }))
  )
  const [elapsed, setElapsed] = useState(0)
  const [eta, setEta] = useState<number | undefined>()
  const [message, setMessage] = useState<string>('')
  const [connected, setConnected] = useState(false)
  const startTimeRef = useRef(Date.now())
  const eventSourceRef = useRef<EventSource | null>(null)
  const completedRef = useRef(false)

  // Elapsed timer
  useEffect(() => {
    if (!active) return
    startTimeRef.current = Date.now()
    completedRef.current = false
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current)
    }, 100)
    return () => clearInterval(interval)
  }, [active])

  // SSE connection
  useEffect(() => {
    if (!active || !runId) return

    // Reset steps
    setSteps(PIPELINE_STAGES.map((s) => ({ id: s.id, label: s.label, status: 'pending' })))
    setMessage('')
    setEta(undefined)

    const es = new EventSource(`/api/accounts/run-progress/${runId}`)
    eventSourceRef.current = es

    es.addEventListener('connected', () => {
      setConnected(true)
    })

    es.addEventListener('progress', (e) => {
      try {
        const event: ProgressEvent = JSON.parse(e.data)
        setElapsed(event.elapsedMs)
        setEta(event.etaMs)
        setMessage(event.message)

        // Update steps based on the event
        setSteps((prev) =>
          prev.map((step) => {
            if (step.id === event.stage) {
              if (event.status === 'start' || event.status === 'progress') {
                return { ...step, status: 'active', detail: event.message }
              }
              if (event.status === 'done') {
                return { ...step, status: 'done', detail: event.message }
              }
              if (event.status === 'error') {
                return { ...step, status: 'error', detail: event.message }
              }
            }
            // Mark earlier stages as done if current stage is past them
            const eventIdx = PIPELINE_STAGES.findIndex((s) => s.id === event.stage)
            const stepIdx = PIPELINE_STAGES.findIndex((s) => s.id === step.id)
            if (stepIdx < eventIdx && step.status !== 'done') {
              return { ...step, status: 'done' }
            }
            return step
          })
        )
      } catch {
        // ignore parse errors
      }
    })

    es.addEventListener('done', () => {
      if (!completedRef.current) {
        completedRef.current = true
        onComplete?.()
      }
      es.close()
    })

    es.onerror = () => {
      // SSE connection failed — fall back to timer-based simulation
      setConnected(false)
      es.close()
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [active, runId, onComplete])

  // Fallback: timer-based simulation when SSE is not connected
  useEffect(() => {
    if (!active || connected) return

    const stepDurations = [2000, 1500, 3000, 4000, 12000, 2500, 1500, 500, 0]
    const interval = setInterval(() => {
      const currentElapsed = Date.now() - startTimeRef.current

      setSteps(
        PIPELINE_STAGES.map((stage, i) => {
          let stageEnd = 0
          for (let j = 0; j <= i; j++) stageEnd += stepDurations[j]
          const stageStart = stageEnd - stepDurations[i]

          if (currentElapsed >= stageEnd) {
            return { id: stage.id, label: stage.label, status: 'done', duration: stepDurations[i] }
          }
          if (currentElapsed >= stageStart) {
            return { id: stage.id, label: stage.label, status: 'active', detail: 'Processing...' }
          }
          return { id: stage.id, label: stage.label, status: 'pending' }
        })
      )

      // Total pipeline complete
      const totalDuration = stepDurations.reduce((a, b) => a + b, 0)
      if (currentElapsed >= totalDuration && !completedRef.current) {
        completedRef.current = true
        onComplete?.()
        clearInterval(interval)
      }
    }, 200)

    return () => clearInterval(interval)
  }, [active, connected, onComplete])

  if (!active && steps.every((s) => s.status === 'pending')) return null

  // 'complete' is a UI-only pseudo-stage, never a real backend stage id — the
  // SSE path (real progress events) never marks it 'done', but the fallback
  // timer simulation below does (it iterates all of PIPELINE_STAGES). Exclude
  // it from both sides of this comparison so completedCount can actually reach
  // totalStages via either path — counting it on one side only made the
  // "✓ COMPLETE" header unreachable through the fallback path (9 done ≠ 8).
  const completedCount = steps.filter((s) => s.id !== 'complete' && s.status === 'done').length
  const totalStages = PIPELINE_STAGES.length - 1 // exclude 'complete' from denominator
  const progress = Math.min(100, Math.round((completedCount / totalStages) * 100))

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* header */}
      <div className="border-b border-[var(--color-border)] px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
            PIPELINE PROGRESS
          </span>
          {active && (
            <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest flex items-center gap-1.5">
              <span className="pulse-lime">●</span>
              {connected ? 'LIVE' : 'RUNNING'}
            </span>
          )}
          {!active && completedCount === totalStages && (
            <span className="text-[10px] font-mono text-[var(--color-lime)] uppercase tracking-widest">✓ COMPLETE</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {runId && (
            <span className="text-[10px] font-mono text-[var(--color-muted-3)]">{runId.slice(0, 8)}</span>
          )}
          {eta !== undefined && active && (
            <span className="text-[10px] font-mono text-[var(--color-orange)]">
              ETA: {(eta / 1000).toFixed(0)}s
            </span>
          )}
          <span className="text-[10px] font-mono text-[var(--color-muted-2)]">
            {(elapsed / 1000).toFixed(1)}s
          </span>
        </div>
      </div>

      {/* overall progress bar */}
      <div className="h-1 bg-[var(--color-faint)] relative overflow-hidden">
        <div
          className="h-full transition-all duration-300 ease-out"
          style={{
            width: `${progress}%`,
            backgroundColor: active ? 'var(--color-lime)' : completedCount >= totalStages ? 'var(--color-lime)' : 'var(--color-orange)'
          }}
        />
        {active && (
          <div
            className="absolute top-0 h-full w-16 opacity-40 animate-pulse"
            style={{ backgroundColor: 'var(--color-lime)', left: `${progress}%` }}
          />
        )}
      </div>

      {/* step list */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-0.5">
          {steps.filter((s) => s.id !== 'complete').map((step, i) => (
            <div key={step.id} className="flex items-center gap-0.5 flex-1">
              {/* step indicator */}
              <div className="flex flex-col items-center gap-1 flex-1">
                <div
                  className="w-6 h-6 flex items-center justify-center text-[9px] font-mono transition-all duration-300"
                  style={{
                    backgroundColor:
                      step.status === 'done' ? 'var(--color-lime)' :
                      step.status === 'active' ? 'var(--color-orange)' :
                      step.status === 'error' ? 'var(--color-red)' : 'var(--color-faint)',
                    color:
                      step.status === 'done' || step.status === 'active' ? 'var(--color-on-accent)' : 'var(--color-muted-3)'
                  }}
                >
                  {step.status === 'done' ? '✓' :
                   step.status === 'active' ? '⟳' :
                   step.status === 'error' ? '✗' : (i + 1)}
                </div>
                <span
                  className="text-[7px] font-mono uppercase tracking-widest transition-colors"
                  style={{
                    color:
                      step.status === 'done' ? 'var(--color-lime)' :
                      step.status === 'active' ? 'var(--color-orange)' : 'var(--color-muted-3)'
                  }}
                >
                  {step.label}
                </span>
              </div>
              {/* connector line */}
              {i < totalStages - 1 && (
                <div
                  className="h-px flex-1 min-w-1 transition-colors duration-300"
                  style={{
                    backgroundColor: step.status === 'done' ? 'var(--color-lime)' : 'var(--color-faint)'
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* active step detail */}
      {active && message && (
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--color-muted-4)]">
            <span className="text-[var(--color-orange)]">▸</span>
            <span className="truncate">{message}</span>
            <span className="blink text-[var(--color-orange)]">_</span>
          </div>
        </div>
      )}
    </div>
  )
}
