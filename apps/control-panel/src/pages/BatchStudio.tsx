import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel } from '../components/primitives'
import { paths } from '../lib/paths'
import type { CreatorProfile, Platform, ProductProfile, UGCTemplate } from '../lib/types'
import type { BatchPlan, BatchPlanDraft, BatchRequest, Preset, VendorPolicy as BatchVendorPolicy } from '@vvugc/shared-schema'

/* ─── Types for batch plan/enqueue flow ──────────────────────────────── */

type VendorPolicy = Extract<BatchVendorPolicy, { policy: 'cheapest' | 'quality' }>['policy']
type CaptionStyle = 'clean' | 'bold' | 'minimal'

interface BatchFormState {
  productId: string
  templateId: string
  creatorIds: string[]
  platforms: Platform[]
  hookCount: number
  scriptCount: number
  visualTreatments: string[]
  captionStyles: CaptionStyle[]
  ctaVariants: string[]
  vendorPolicy: VendorPolicy
  targetDurationSec: number
  dryRun: boolean
}

/* ─── Constants ──────────────────────────────────────────────────────── */

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube_shorts', label: 'YouTube Shorts' },
  { value: 'instagram_reels', label: 'Instagram Reels' },
  { value: 'facebook', label: 'Facebook' }
]

const VISUAL_TREATMENTS = [
  'cinematic',
  'raw-handheld',
  'split-screen',
  'talking-head',
  'b-roll-overlay',
  'text-heavy',
  'product-closeup',
  'lifestyle'
]

const CAPTION_STYLES: CaptionStyle[] = ['clean', 'bold', 'minimal']

const PRESET_CATEGORY_LABELS: Record<string, string> = {
  ecommerce_dtc: 'E-commerce & DTC',
  saas_apps: 'SaaS & Apps',
  beauty_wellness: 'Beauty & Wellness',
  food_beverage: 'Food & Beverage'
}

/* ─── Component ──────────────────────────────────────────────────────── */

export function BatchStudio() {
  const navigate = useNavigate()

  // Data loaders
  const products = useApi<{ products: ProductProfile[] }>(() => api.products())
  const creators = useApi<{ creators: CreatorProfile[] }>(() => api.creatorProfiles())
  const templates = useApi<{ templates: UGCTemplate[] }>(() => api.templates())
  const presets = useApi<{ presets: Preset[] }>(() => api.presets())
  const account = useApi(() => api.me())

  // Form state
  const [form, setForm] = useState<BatchFormState>({
    productId: '',
    templateId: '',
    creatorIds: [],
    platforms: [],
    hookCount: 3,
    scriptCount: 1,
    visualTreatments: [],
    captionStyles: ['clean'],
    ctaVariants: [''],
    vendorPolicy: 'cheapest',
    targetDurationSec: 30,
    dryRun: true
  })

  // Plan/enqueue state
  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<BatchPlan | null>(null)
  const [plannedRequest, setPlannedRequest] = useState<BatchRequest | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [enqueueing, setEnqueueing] = useState(false)
  const [enqueueError, setEnqueueError] = useState<string | null>(null)

  // Natural-language draft state — a separate front end to the form above.
  // Never plans or enqueues anything itself; it only fills the form below for
  // review before the user hits "Plan batch".
  const [nlDescription, setNlDescription] = useState('')
  const [nlDrafting, setNlDrafting] = useState(false)
  const [nlError, setNlError] = useState<string | null>(null)
  const [nlDraft, setNlDraft] = useState<BatchPlanDraft | null>(null)

  // Auto-select first product when loaded
  useEffect(() => {
    if (products.data?.products?.length && !form.productId) {
      setForm((f) => ({ ...f, productId: products.data!.products[0].id }))
    }
  }, [products.data, form.productId])

  // Computed: total variation count
  const variationCount = useMemo(() => {
    const creatorsCount = Math.max(form.creatorIds.length, 1)
    const platformsCount = Math.max(form.platforms.length, 1)
    const visualCount = Math.max(form.visualTreatments.length, 1)
    const captionCount = Math.max(form.captionStyles.length, 1)
    const ctaCount = Math.max(form.ctaVariants.filter((c) => c.trim()).length, 1)
    return form.hookCount * form.scriptCount * creatorsCount * platformsCount * visualCount * captionCount * ctaCount
  }, [form])

  // Estimated cost (rough: $0.35 per variation for dry-run, $2.50 for live)
  const estimatedCost = useMemo(() => {
    const perUnit = form.dryRun ? 0.35 : 2.5
    return variationCount * perUnit
  }, [variationCount, form.dryRun])

  // Approaching limit warning
  const limitWarning = variationCount > 200
    ? 'This configuration exceeds the maximum of 200 variations. Reduce selections before planning.'
      : null

  /* ─── Handlers ───────────────────────────────────────────────────── */

  function togglePlatform(p: Platform) {
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p)
        ? f.platforms.filter((x) => x !== p)
        : f.platforms.length >= 4
          ? f.platforms
          : [...f.platforms, p]
    }))
    setPlan(null)
  }

  function toggleCreator(id: string) {
    setForm((f) => ({
      ...f,
      creatorIds: f.creatorIds.includes(id)
        ? f.creatorIds.filter((x) => x !== id)
        : f.creatorIds.length >= 5
          ? f.creatorIds
          : [...f.creatorIds, id]
    }))
    setPlan(null)
  }

  function toggleVisualTreatment(t: string) {
    setForm((f) => ({
      ...f,
      visualTreatments: f.visualTreatments.includes(t)
        ? f.visualTreatments.filter((x) => x !== t)
        : [...f.visualTreatments, t]
    }))
    setPlan(null)
  }

  function toggleCaptionStyle(s: CaptionStyle) {
    setForm((f) => ({
      ...f,
      captionStyles: f.captionStyles.includes(s)
        ? f.captionStyles.filter((x) => x !== s)
        : [...f.captionStyles, s]
    }))
    setPlan(null)
  }

  function addCtaVariant() {
    if (form.ctaVariants.length >= 5) return
    setForm((f) => ({ ...f, ctaVariants: [...f.ctaVariants, ''] }))
    setPlan(null)
  }

  function updateCtaVariant(idx: number, value: string) {
    setForm((f) => {
      const next = [...f.ctaVariants]
      next[idx] = value
      return { ...f, ctaVariants: next }
    })
    setPlan(null)
  }

  function removeCtaVariant(idx: number) {
    setForm((f) => ({ ...f, ctaVariants: f.ctaVariants.filter((_, i) => i !== idx) }))
    setPlan(null)
  }

  const handlePlan = useCallback(async () => {
    setPlanning(true)
    setPlanError(null)
    setPlan(null)
    setPlannedRequest(null)
    try {
      const product = products.data?.products.find((item) => item.id === form.productId)
      const session = account.data?.account
      if (!product) throw new Error('Select a product profile before planning.')
      if (!product.clientId) throw new Error('The selected product must be assigned to a client before planning a batch.')
      if (!session) throw new Error('Your account session is still loading. Please try again.')
      if (variationCount > 200) throw new Error('A batch cannot exceed 200 variations.')

      const body: BatchRequest = {
        productProfileId: product.id,
        templateId: form.templateId || undefined,
        creatorProfileIds: form.creatorIds,
        platforms: form.platforms,
        hookCount: form.hookCount,
        scriptCount: form.scriptCount,
        visualTreatmentIds: form.visualTreatments.length ? form.visualTreatments : undefined,
        captionStyleIds: form.captionStyles.length ? form.captionStyles : undefined,
        ctaVariants: form.ctaVariants.filter((c) => c.trim()),
        vendorPolicy: { policy: form.vendorPolicy },
        targetDurationSec: form.targetDurationSec,
        dryRun: form.dryRun,
        maxVariations: 200,
        maxEstimatedCostUsd: 500,
        clientId: product.clientId,
        orgId: session.orgId,
        requestedBy: session.id,
        locale: 'en',
        deduplicationMode: 'strict'
      }
      const result = await api.batchPlan(body)
      setPlan(result)
      setPlannedRequest(body)
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err))
    } finally {
      setPlanning(false)
    }
  }, [account.data?.account, form, products.data?.products, variationCount])

  const [appliedPresetId, setAppliedPresetId] = useState<string | null>(null)

  function applyPreset(preset: Preset) {
    // Same platform-support filter as the AI draft below — Batch Studio's
    // picker only offers the 4 short-form platforms, no youtube_long control.
    const supportedPlatforms = new Set(PLATFORMS.map((x) => x.value as string))
    const presetPlatforms = preset.platforms.filter((x): x is Platform => supportedPlatforms.has(x))
    setForm((f) => ({
      ...f,
      templateId: preset.templateId,
      platforms: presetPlatforms.length ? presetPlatforms : f.platforms,
      captionStyles: [preset.captionStyle],
      visualTreatments: preset.visualTreatments,
      vendorPolicy: preset.vendorPolicy,
      targetDurationSec: preset.targetDurationSec
    }))
    setAppliedPresetId(preset.id)
    setPlan(null)
  }

  const handleDraftFromDescription = useCallback(async () => {
    if (!nlDescription.trim()) return
    setNlDrafting(true)
    setNlError(null)
    setNlDraft(null)
    try {
      const draft = await api.batchPlanFromDescription(nlDescription.trim())
      setNlDraft(draft)
      setPlan(null)

      const { plan: p } = draft
      // Batch Studio's platform picker only offers the 4 short-form platforms
      // above (no youtube_long checkbox) — drop anything the AI draft returned
      // that this form doesn't have a control for, rather than widen the form.
      const supportedPlatforms = new Set(PLATFORMS.map((x) => x.value as string))
      const draftPlatforms = p.platforms.filter((x): x is Platform => supportedPlatforms.has(x))
      setForm((f) => ({
        ...f,
        productId: p.productProfileId || f.productId,
        templateId: p.templateId ?? f.templateId,
        creatorIds: p.creatorProfileIds.length ? p.creatorProfileIds : f.creatorIds,
        platforms: draftPlatforms.length ? draftPlatforms : f.platforms,
        hookCount: p.hookCount,
        scriptCount: p.scriptCount,
        captionStyles: p.captionStyleIds?.length ? p.captionStyleIds : f.captionStyles,
        ctaVariants: p.ctaVariants?.length ? p.ctaVariants : f.ctaVariants,
        // The form only offers cheapest/quality (no specific-vendor picker) — a
        // "specific" draft policy is treated as a quality signal rather than
        // silently dropped back to cheapest.
        vendorPolicy: p.vendorPolicy.policy === 'cheapest' ? 'cheapest' : 'quality',
        targetDurationSec: p.targetDurationSec
      }))
    } catch (err) {
      setNlError(err instanceof Error ? err.message : String(err))
    } finally {
      setNlDrafting(false)
    }
  }, [nlDescription])

  const handleEnqueue = useCallback(async () => {
    if (!plan || !plannedRequest) return
    setEnqueueing(true)
    setEnqueueError(null)
    try {
      const result = await api.batchEnqueue({ plan, request: plannedRequest })
      navigate(paths.studioBatchProgress(result.batchId))
    } catch (err) {
      setEnqueueError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnqueueing(false)
    }
  }, [plan, plannedRequest, navigate])

  /* ─── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
            Batch Variation Generator
          </h2>
          <p className="text-[11px] font-mono text-[var(--color-muted-2)] mt-1">
            Generate multiple video variations across creators, platforms, hooks, and styles in one go.
          </p>
        </div>
        <button
          onClick={() => navigate(paths.studio)}
          className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted-2)] hover:text-[var(--color-lime)] transition-colors"
        >
          ← Single run
        </button>
      </div>

      {/* ─── Curated presets ─────────────────────────────────────── */}
      <Panel title="START FROM A PRESET">
        <div className="px-5 py-5 space-y-4">
          <p className="text-[10px] font-mono text-[var(--color-muted-2)]">
            Curated template/style/platform combinations for common use cases — fills the form below, still yours to edit.
          </p>
          {Object.entries(
            (presets.data?.presets ?? []).reduce<Record<string, Preset[]>>((acc, p) => {
              (acc[p.category] ??= []).push(p)
              return acc
            }, {})
          ).map(([category, items]) => (
            <div key={category}>
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">
                {PRESET_CATEGORY_LABELS[category] ?? category}
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                {items.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="text-left border p-3 transition-colors"
                    style={{
                      borderColor: appliedPresetId === preset.id ? 'var(--color-lime)' : 'var(--color-border)',
                      backgroundColor: appliedPresetId === preset.id ? 'var(--color-lime)11' : 'transparent'
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono text-[var(--color-text)] font-bold">{preset.name}</span>
                      {appliedPresetId === preset.id && <span className="text-[9px] font-mono text-[var(--color-lime)]">✓ applied</span>}
                    </div>
                    <p className="text-[10px] font-mono text-[var(--color-muted-2)] mt-1">{preset.description}</p>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {presets.data?.presets?.length === 0 && (
            <p className="text-[10px] font-mono text-[var(--color-muted-3)]">No presets available.</p>
          )}
        </div>
      </Panel>

      {/* ─── Natural-language draft ──────────────────────────────── */}
      <Panel title="DESCRIBE YOUR BATCH">
        <div className="px-5 py-5 space-y-3">
          <p className="text-[10px] font-mono text-[var(--color-muted-2)]">
            Describe what you want in plain language — the form below fills in from it; review before planning.
          </p>
          <textarea
            className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors resize-y"
            rows={2}
            placeholder='e.g. "a week of energetic fitness content for my protein brand, TikTok and Reels"'
            value={nlDescription}
            onChange={(e) => setNlDescription(e.target.value)}
          />
          <button
            onClick={handleDraftFromDescription}
            disabled={nlDrafting || !nlDescription.trim()}
            className="px-5 py-2.5 font-black uppercase tracking-widest text-xs transition-colors disabled:opacity-50 border"
            style={{ borderColor: 'var(--color-lime)', color: 'var(--color-lime)' }}
          >
            {nlDrafting ? 'DRAFTING...' : 'DRAFT WITH AI'}
          </button>

          {nlError && (
            <p className="text-[11px] font-mono text-[var(--color-red)]">Error: {nlError}</p>
          )}

          {nlDraft && (
            <div className="border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-2">
              <p className="text-[11px] font-mono text-[var(--color-text)]">{nlDraft.plan.rationale}</p>
              {nlDraft.droppedInvalidIds.length > 0 && (
                <p className="text-[10px] font-mono text-[var(--color-orange)]">
                  ⚠ Ignored unrecognized reference(s) from the draft: {nlDraft.droppedInvalidIds.join(', ')}
                </p>
              )}
              {!nlDraft.plan.productProfileId && (
                <p className="text-[10px] font-mono text-[var(--color-orange)]">
                  ⚠ Couldn't resolve a product from the description — pick one below.
                </p>
              )}
            </div>
          )}
        </div>
      </Panel>

      {/* ─── Form Panel ──────────────────────────────────────────── */}
      <Panel title="BATCH CONFIGURATION">
        <div className="px-5 py-5 space-y-5">

          {/* 1. Product selector */}
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Product profile</span>
            <select
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              value={form.productId}
              onChange={(e) => { setForm((f) => ({ ...f, productId: e.target.value })); setPlan(null) }}
            >
              <option value="">No product selected</option>
              {(products.data?.products ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* 2. Template selector */}
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">UGC Template (optional)</span>
            <select
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              value={form.templateId}
              onChange={(e) => { setForm((f) => ({ ...f, templateId: e.target.value })); setPlan(null) }}
            >
              <option value="">Freeform (no template)</option>
              {(templates.data?.templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>

          {/* 3. Creator multi-select */}
          <div>
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">
              Creators (max 5) — {form.creatorIds.length} selected
            </span>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2">
              {(creators.data?.creators ?? []).filter((c) => c.active).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCreator(c.id)}
                  className="text-left border p-3 transition-colors"
                  style={{
                    borderColor: form.creatorIds.includes(c.id) ? 'var(--color-lime)' : 'var(--color-border)',
                    backgroundColor: form.creatorIds.includes(c.id) ? 'var(--color-lime)11' : 'transparent'
                  }}
                >
                  <span className="text-[11px] font-mono text-[var(--color-text)]">{c.displayName}</span>
                  {form.creatorIds.includes(c.id) && (
                    <span className="ml-2 text-[9px] font-mono text-[var(--color-lime)]">✓</span>
                  )}
                </button>
              ))}
              {(creators.data?.creators ?? []).filter((c) => c.active).length === 0 && (
                <p className="text-[10px] font-mono text-[var(--color-muted-3)] col-span-full">
                  No active creator profiles. Create them in Brand.
                </p>
              )}
            </div>
          </div>

          {/* 4. Platform checkboxes */}
          <div>
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Platforms (max 4)</span>
            <div className="flex flex-wrap gap-4 mt-2">
              {PLATFORMS.map((p) => (
                <label key={p.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.platforms.includes(p.value)}
                    onChange={() => togglePlatform(p.value)}
                    className="accent-[var(--color-lime)]"
                  />
                  <span className="text-[11px] font-mono text-[var(--color-text)]">{p.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 5. Hook count slider */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Hook variations</span>
              <span className="text-[11px] font-mono text-[var(--color-lime)]">{form.hookCount}</span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={form.hookCount}
              onChange={(e) => { setForm((f) => ({ ...f, hookCount: Number(e.target.value) })); setPlan(null) }}
              className="w-full mt-2 accent-[var(--color-lime)]"
            />
            <div className="flex justify-between text-[9px] font-mono text-[var(--color-muted-3)]">
              <span>1</span><span>10</span>
            </div>
          </div>

          {/* 6. Script count */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Script variations</span>
              <span className="text-[11px] font-mono text-[var(--color-lime)]">{form.scriptCount}</span>
            </div>
            <input
              type="range"
              min={1}
              max={3}
              value={form.scriptCount}
              onChange={(e) => { setForm((f) => ({ ...f, scriptCount: Number(e.target.value) })); setPlan(null) }}
              className="w-full mt-2 accent-[var(--color-lime)]"
            />
            <div className="flex justify-between text-[9px] font-mono text-[var(--color-muted-3)]">
              <span>1</span><span>3</span>
            </div>
          </div>

          {/* 7. Visual treatments */}
          <div>
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Visual treatments</span>
            <div className="flex flex-wrap gap-2 mt-2">
              {VISUAL_TREATMENTS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleVisualTreatment(t)}
                  className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest border transition-colors"
                  style={{
                    borderColor: form.visualTreatments.includes(t) ? 'var(--color-lime)' : 'var(--color-border)',
                    color: form.visualTreatments.includes(t) ? 'var(--color-lime)' : 'var(--color-muted-2)',
                    backgroundColor: form.visualTreatments.includes(t) ? 'var(--color-lime)11' : 'transparent'
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 8. Caption styles */}
          <div>
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Caption styles</span>
            <div className="flex flex-wrap gap-4 mt-2">
              {CAPTION_STYLES.map((s) => (
                <label key={s} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.captionStyles.includes(s)}
                    onChange={() => toggleCaptionStyle(s)}
                    className="accent-[var(--color-lime)]"
                  />
                  <span className="text-[11px] font-mono text-[var(--color-text)] capitalize">{s}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 9. CTA variants */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">CTA variants</span>
              {form.ctaVariants.length < 5 && (
                <button
                  type="button"
                  onClick={addCtaVariant}
                  className="text-[10px] font-mono text-[var(--color-lime)] hover:underline"
                >
                  + Add CTA
                </button>
              )}
            </div>
            <div className="space-y-2 mt-2">
              {form.ctaVariants.map((cta, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    className="flex-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-2.5 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
                    placeholder={`CTA variant ${idx + 1} (e.g. "Shop Now", "Learn More")`}
                    value={cta}
                    onChange={(e) => updateCtaVariant(idx, e.target.value)}
                  />
                  {form.ctaVariants.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCtaVariant(idx)}
                      className="text-[var(--color-muted-3)] hover:text-[var(--color-red)] text-sm px-2 transition-colors"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 10. Vendor policy */}
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Vendor policy</span>
            <select
              className="w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] font-mono text-sm p-3 focus:outline-none focus:border-[var(--color-lime)] transition-colors"
              value={form.vendorPolicy}
              onChange={(e) => { setForm((f) => ({ ...f, vendorPolicy: e.target.value as VendorPolicy })); setPlan(null) }}
            >
              <option value="cheapest">Cheapest available</option>
              <option value="quality">Highest quality (premium vendors)</option>
            </select>
          </label>

          {/* 11. Target duration */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[var(--color-muted)] uppercase tracking-widest">Target duration</span>
              <span className="text-[11px] font-mono text-[var(--color-lime)]">{form.targetDurationSec}s</span>
            </div>
            <input
              type="range"
              min={15}
              max={60}
              step={5}
              value={form.targetDurationSec}
              onChange={(e) => { setForm((f) => ({ ...f, targetDurationSec: Number(e.target.value) })); setPlan(null) }}
              className="w-full mt-2 accent-[var(--color-lime)]"
            />
            <div className="flex justify-between text-[9px] font-mono text-[var(--color-muted-3)]">
              <span>15s</span><span>60s</span>
            </div>
          </div>

          {/* 12. Dry-run toggle */}
          <div className="flex items-center justify-between border border-[var(--color-border)] p-4">
            <div>
              <span className="text-[11px] font-mono text-[var(--color-text)] uppercase tracking-widest">Dry-run mode</span>
              <p className="text-[10px] font-mono text-[var(--color-muted-3)] mt-0.5">
                {form.dryRun ? 'No vendor spend — full pipeline without real renders' : 'LIVE — real vendor calls, billed per variation'}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={form.dryRun}
                onChange={(e) => { setForm((f) => ({ ...f, dryRun: e.target.checked })); setPlan(null) }}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--color-border)] peer-checked:bg-[var(--color-lime)] rounded-none transition-colors relative">
                <div
                  className="absolute top-0.5 w-4 h-4 bg-[var(--color-bg)] transition-transform"
                  style={{ left: form.dryRun ? '18px' : '2px' }}
                />
              </div>
            </label>
          </div>

        </div>
      </Panel>

      {/* ─── Preview & Actions ───────────────────────────────────── */}
      <Panel title="BATCH SUMMARY">
        <div className="px-5 py-5 space-y-4">
          {/* Live preview */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-3xl font-black font-mono text-[var(--color-lime)]">{variationCount}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mt-1">Variations</p>
            </div>
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-3xl font-black font-mono text-[var(--color-text)]">${estimatedCost.toFixed(2)}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mt-1">Est. cost</p>
            </div>
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-3xl font-black font-mono text-[var(--color-text)]">{form.platforms.length || '—'}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mt-1">Platforms</p>
            </div>
            <div className="bg-[var(--color-bg)] p-4">
              <p className="text-3xl font-black font-mono text-[var(--color-text)]">{form.creatorIds.length || '—'}</p>
              <p className="text-[10px] font-mono text-[var(--color-muted-2)] uppercase tracking-widest mt-1">Creators</p>
            </div>
          </div>

          <p className="text-[11px] font-mono text-[var(--color-muted-2)] text-center">
            This will generate <span className="text-[var(--color-lime)]">{variationCount}</span> variations
            {!form.dryRun && <> — <span className="text-[var(--color-orange)]">${estimatedCost.toFixed(2)} estimated</span></>}
          </p>

          {/* Warning */}
          {limitWarning && (
            <div className="border border-[var(--color-orange)] p-3">
              <p className="text-[10px] font-mono text-[var(--color-orange)]">⚠ {limitWarning}</p>
            </div>
          )}

          {/* Plan button */}
          <button
            onClick={handlePlan}
            disabled={planning || form.platforms.length === 0 || !form.productId || variationCount > 200}
            className="w-full px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
            style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            {planning ? 'PLANNING...' : 'PLAN BATCH'}
          </button>

          {planError && (
            <p className="text-[11px] font-mono text-[var(--color-red)]">Error: {planError}</p>
          )}

          {/* Plan result */}
          {plan && (
            <div className="border border-[var(--color-border)] bg-[var(--color-bg)] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
                  Plan Ready
                </span>
                <span className="text-[10px] font-mono text-[var(--color-lime)]">
                  ✓ {plan.variations.length} variations
                </span>
              </div>

              {/* Cost breakdown */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-[10px] font-mono">
                <div>
                  <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Total cost</span>
                  <div className="text-[var(--color-lime)] text-lg font-black mt-1">${plan.totalEstimatedCost.toFixed(2)}</div>
                </div>
                <div>
                  <span className="text-[var(--color-muted-2)] uppercase tracking-widest">Rejected</span>
                  <div className="text-[var(--color-text)] mt-1">{plan.rejected.length}</div>
                </div>
              </div>

              {/* Warnings */}
              {plan.warnings.length > 0 && (
                <div className="space-y-1">
                  {plan.warnings.map((w, i) => (
                    <p key={i} className="text-[10px] font-mono text-[var(--color-orange)]">⚠ {w}</p>
                  ))}
                </div>
              )}

              {/* Confirm button */}
              <button
                onClick={handleEnqueue}
                disabled={enqueueing}
                className="w-full px-6 py-3 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50"
                style={{
                  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
                  backgroundColor: form.dryRun ? 'var(--color-lime)' : 'var(--color-orange)',
                  color: 'var(--color-on-accent)'
                }}
              >
                {enqueueing ? 'ENQUEUEING...' : 'CONFIRM & ENQUEUE'}
              </button>

              {enqueueError && (
                <p className="text-[11px] font-mono text-[var(--color-red)]">Error: {enqueueError}</p>
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
