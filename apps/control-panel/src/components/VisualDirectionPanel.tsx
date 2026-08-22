import { useState } from 'react'

export type { VisualDirectionState }

interface VisualDirectionState {
  cameraMovement: string
  lens: string
  lighting: string
  colorPalette: string
  tempo: string
  filmGrain: string
  era: string
}

/** Convert UI state (empty strings) to API format (undefined for unset fields) */
export function toApiFormat(dir: Partial<VisualDirectionState>): Record<string, string> | undefined {
  const cleaned: Record<string, string> = {}
  for (const [k, v] of Object.entries(dir)) {
    if (v && v !== '' && v !== 'none') cleaned[k] = v
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

interface Props {
  value: Partial<VisualDirectionState>
  onChange: (dir: Partial<VisualDirectionState>) => void
}

const OPTIONS = {
  cameraMovement: [
    ['', 'Auto'], ['static', 'Static'], ['pan_left', 'Pan Left'], ['pan_right', 'Pan Right'],
    ['tilt_up', 'Tilt Up'], ['tilt_down', 'Tilt Down'], ['tracking', 'Tracking'],
    ['dolly_in', 'Dolly In'], ['dolly_out', 'Dolly Out'], ['orbit', 'Orbit'],
    ['handheld', 'Handheld'], ['drone', 'Drone'], ['helicopter', 'Helicopter'], ['pov', 'POV'],
  ],
  lens: [
    ['', 'Auto'], ['wide', 'Wide'], ['normal', 'Normal (50mm)'], ['telephoto', 'Telephoto'],
    ['macro', 'Macro'], ['anamorphic', 'Anamorphic'], ['fisheye', 'Fisheye'],
  ],
  lighting: [
    ['', 'Auto'], ['natural', 'Natural'], ['golden_hour', 'Golden Hour'], ['blue_hour', 'Blue Hour'],
    ['studio', 'Studio'], ['silhouette', 'Silhouette'], ['neon', 'Neon'],
    ['overcast', 'Overcast'], ['dramatic', 'Dramatic'], ['soft', 'Soft'],
  ],
  colorPalette: [
    ['', 'Auto'], ['neutral', 'Neutral'], ['warm', 'Warm'], ['cool', 'Cool'],
    ['desaturated', 'Desaturated'], ['high_contrast', 'High Contrast'],
    ['pastel', 'Pastel'], ['noir', 'Noir'], ['vintage', 'Vintage'],
  ],
  tempo: [
    ['', 'Auto'], ['calm', 'Calm'], ['dynamic', 'Dynamic'],
    ['chaotic', 'Chaotic'], ['single_shot', 'Single Shot'],
  ],
  filmGrain: [
    ['none', 'None'], ['subtle', 'Subtle'], ['heavy', 'Heavy'],
  ],
  era: [
    ['', 'Modern'], ['90s', '90s'], ['80s', '80s'], ['70s', '70s'], ['film_noir', 'Film Noir'],
  ],
} as const

const LABELS: Record<string, string> = {
  cameraMovement: 'Camera',
  lens: 'Lens',
  lighting: 'Lighting',
  colorPalette: 'Color',
  tempo: 'Tempo',
  filmGrain: 'Grain',
  era: 'Era',
}

function summarize(dir: Partial<VisualDirectionState>): string {
  const active = Object.entries(dir)
    .filter(([, v]) => v && v !== 'none')
    .map(([k, v]) => {
      const opts = OPTIONS[k as keyof typeof OPTIONS] ?? []
      const label = opts.find(([val]) => val === v)?.[1] ?? v
      return label
    })
  return active.join(' • ') || 'Auto (model decides)'
}

export function VisualDirectionPanel({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const summary = summarize(value)
  const hasCustom = Object.values(value).some((v) => v && v !== '' && v !== 'none')

  function set(key: string, val: string) {
    onChange({ ...value, [key]: val || undefined })
  }

  return (
    <div className="border border-[var(--color-raised)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)]">
            Visual Direction
          </span>
          {!open && (
            <p className={`text-[11px] mt-0.5 font-mono ${hasCustom ? 'text-[var(--color-lime)]' : 'text-[var(--color-muted-3)]'}`}>
              {summary}
            </p>
          )}
        </div>
        <span className="text-[var(--color-lime)] text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {(Object.keys(OPTIONS) as Array<keyof typeof OPTIONS>).map((key) => (
            <div key={key}>
              <label className="text-[10px] uppercase tracking-widest text-[var(--color-muted-2)] block mb-1">
                {LABELS[key] ?? key}
              </label>
              <select
                className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-xs p-2"
                value={value[key] ?? ''}
                onChange={(e) => set(key, e.target.value)}
              >
                {OPTIONS[key].map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
