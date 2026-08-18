import { useParams } from 'react-router-dom'
import { PipelineProgress } from '../components/PipelineProgress'

/**
 * Live 9-stage factory floor. Deep-linkable; step 2 will wire durable SSE.
 * PipelineProgress already reconnects via the existing run-progress endpoint.
 */
export function StudioRun() {
  const { runId } = useParams()
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-[var(--color-muted-2)] uppercase tracking-widest">
        Run <span className="font-mono text-[var(--color-text)]">{runId}</span>
      </p>
      <PipelineProgress active={Boolean(runId)} runId={runId} />
    </div>
  )
}