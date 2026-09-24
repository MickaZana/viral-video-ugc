import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { VideoGenerator } from './VideoGenerator'
import { api } from '../lib/api'
import type { AgencyClient, RunQuote } from '../lib/types'

vi.mock('../components/DiscoveryPanel', () => ({ DiscoverPanel: () => null }))
vi.mock('../components/VisualDirectionPanel', () => ({
  VisualDirectionPanel: () => null,
  toApiFormat: () => ({})
}))
vi.mock('../components/PipelineProgress', () => ({ PipelineProgress: () => null }))

vi.mock('../lib/api', () => ({
  api: {
    models: vi.fn(), clients: vi.fn(), products: vi.fn(), creatorProfiles: vi.fn(), templates: vi.fn(),
    creatorPreflight: vi.fn(), updateClient: vi.fn(), runQuote: vi.fn(), run: vi.fn(), createClient: vi.fn()
  }
}))

const CLIENT = {
  id: 'client_1', orgId: 'org_1', name: 'FitFuel', niche: 'fitness', brandVoice: 'direct', locale: 'en',
  platforms: ['tiktok'] as AgencyClient['platforms'], targetDurationSec: 30, videoVendor: 'higgsfield' as const,
  voiceVendor: 'elevenlabs' as const, cadence: 'manual' as const, active: true,
  createdAt: '2026-01-01', updatedAt: '2026-01-01'
}
const MODELS = {
  grouped: {
    text: [], image: [],
    video: [
      { id: 'higgsfield:standard', kind: 'video', vendor: 'higgsfield', model: 'Standard', result: 'clip', description: '', unit: 'clip', priceUsdPerUnit: 0.4 },
      { id: 'kling:pro', kind: 'video', vendor: 'kling', model: 'Pro', result: 'clip', description: '', unit: 'clip', priceUsdPerUnit: 0.5 }
    ],
    voiceover: [{ id: 'elevenlabs:voice', kind: 'voiceover', vendor: 'elevenlabs', model: 'Voice', result: 'voice', description: '', unit: 'character', priceUsdPerUnit: 0.0001 }]
  }
}
const TEMPLATE = { id: 'tutorial', version: '1', name: 'Tutorial', description: 'Teach it', category: 'education', targetPlatforms: ['tiktok'], recommendedDurationSec: 30, scriptStructure: ['hook'], hookPatterns: [], requiredInputs: [], optionalInputs: [], visualDirection: '', cameraDirection: '', creatorDirection: '', productPlacementDirection: '', captionStyle: 'clean', ctaPatterns: [], forbiddenPatterns: [], qaRubric: [], defaultVariants: [], active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const QUOTE: RunQuote = {
  currency: 'USD', videoVendor: 'higgsfield', minimumVideoVendorSpendUsd: 1.6, maximumVideoVendorSpendUsd: 19.2,
  clipsPerCandidate: 4, maximumClipsPerCandidate: 6, platformCount: 1, minimumCandidateCount: 1,
  maximumPlatformVideosPerFlow: 8, voiceover: { cost: 'variable', vendor: 'elevenlabs' }, notes: []
}

function renderStudio() { return render(<MemoryRouter><VideoGenerator /></MemoryRouter>) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.models).mockResolvedValue(MODELS as never)
  vi.mocked(api.clients).mockResolvedValue({ clients: [CLIENT] } as never)
  vi.mocked(api.products).mockResolvedValue({ products: [] })
  vi.mocked(api.creatorProfiles).mockResolvedValue({ creators: [] })
  vi.mocked(api.templates).mockResolvedValue({ templates: [TEMPLATE] } as never)
  vi.mocked(api.runQuote).mockResolvedValue(QUOTE)
  vi.mocked(api.updateClient).mockResolvedValue({ client: CLIENT } as never)
})

describe('VideoGenerator live quote', () => {
  it('does not request a quote while Live Run is off', async () => {
    renderStudio()
    await screen.findByText('FitFuel')
    expect(api.runQuote).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'RUN DRY-RUN' })).toBeInTheDocument()
  })

  it('shows a scoped server quote without putting a cost on RUN LIVE', async () => {
    const user = userEvent.setup()
    renderStudio()
    await user.click(await screen.findByRole('checkbox', { name: /live run/i }))
    expect(await screen.findByRole('status', { name: /live vendor-spend estimate/i })).toHaveTextContent('Estimated vendor spend: from $1.60 USD')
    expect(screen.getByText('4 clips × 1 selected platform for one candidate via higgsfield.')).toBeInTheDocument()
    expect(screen.getByText('Up to $19.20 video spend for up to 8 generated platform videos.')).toBeInTheDocument()
    expect(screen.getByText(/Plus variable elevenlabs usage/i)).toBeInTheDocument()
    expect(screen.getByText(/Subscription-plan overages/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'RUN LIVE' })).toBeInTheDocument()
    expect(api.runQuote).toHaveBeenCalledWith({ clientId: 'client_1', templateId: undefined })
    expect(api.run).not.toHaveBeenCalled()
    expect(api.createClient).not.toHaveBeenCalled()
  })

  it('shows when voiceover is not selected', async () => {
    vi.mocked(api.runQuote).mockResolvedValueOnce({ ...QUOTE, voiceover: { cost: 'not_selected' } })
    const user = userEvent.setup()
    renderStudio()
    await user.click(await screen.findByRole('checkbox', { name: /live run/i }))
    expect(await screen.findByText('Voiceover is not selected.')).toBeInTheDocument()
  })

  it('shows loading, no numeric estimate on failure, and retries', async () => {
    let resolveQuote: ((value: typeof QUOTE) => void) | undefined
    vi.mocked(api.runQuote).mockImplementationOnce(() => new Promise((resolve) => { resolveQuote = resolve }) as never)
      .mockRejectedValueOnce(new Error('quote unavailable'))
      .mockResolvedValueOnce(QUOTE)
    const user = userEvent.setup()
    renderStudio()
    await user.click(await screen.findByRole('checkbox', { name: /live run/i }))
    expect(await screen.findByRole('status', { name: /live vendor-spend estimate/i })).toHaveTextContent(/Calculating/)
    resolveQuote?.(QUOTE)
    await screen.findByText(/Estimated vendor spend/i)
    await user.click(screen.getByRole('checkbox', { name: /live run/i }))
    await user.click(screen.getByRole('checkbox', { name: /live run/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to calculate')
    expect(screen.queryByText(/from \$1\.60 USD/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry estimate/i }))
    await screen.findByText(/Estimated vendor spend/i)
    expect(api.runQuote).toHaveBeenCalledTimes(3)
  })

  it('persists a changed video model before refreshing the quote', async () => {
    let resolveUpdate: ((value: { client: AgencyClient }) => void) | undefined
    vi.mocked(api.updateClient).mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }) as never)
    vi.mocked(api.runQuote).mockResolvedValueOnce(QUOTE).mockResolvedValueOnce({ ...QUOTE, videoVendor: 'kling', minimumVideoVendorSpendUsd: 2 })
    const user = userEvent.setup()
    renderStudio()
    await user.click(await screen.findByRole('checkbox', { name: /live run/i }))
    await screen.findByText(/Estimated vendor spend/i)
    await user.click(screen.getByRole('button', { name: /kling.*pro/i }))
    await waitFor(() => expect(api.updateClient).toHaveBeenCalledWith('client_1', expect.objectContaining({ videoVendor: 'kling' })))
    expect(api.runQuote).toHaveBeenCalledTimes(1)
    resolveUpdate?.({ client: { ...CLIENT, videoVendor: 'kling' } })
    await waitFor(() => expect(api.runQuote).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('4 clips × 1 selected platform for one candidate via kling.')).toBeInTheDocument()
  })

  it('ignores an older quote response after the template changes', async () => {
    let resolveOld: ((value: typeof QUOTE) => void) | undefined
    let resolveNew: ((value: typeof QUOTE) => void) | undefined
    vi.mocked(api.runQuote)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }) as never)
    const user = userEvent.setup()
    renderStudio()
    await user.click(await screen.findByRole('checkbox', { name: /live run/i }))
    await screen.findByText(/Calculating live vendor-spend estimate/i)
    await user.selectOptions(screen.getByLabelText(/ugc template/i), 'tutorial')
    await waitFor(() => expect(api.runQuote).toHaveBeenLastCalledWith({ clientId: 'client_1', templateId: 'tutorial' }))
    resolveNew?.({ ...QUOTE, videoVendor: 'kling', minimumVideoVendorSpendUsd: 2 })
    expect(await screen.findByText('4 clips × 1 selected platform for one candidate via kling.')).toBeInTheDocument()
    resolveOld?.(QUOTE)
    await waitFor(() => expect(screen.getByText('4 clips × 1 selected platform for one candidate via kling.')).toBeInTheDocument())
    expect(screen.queryByText('4 clips × 1 selected platform for one candidate via higgsfield.')).not.toBeInTheDocument()
  })
})
