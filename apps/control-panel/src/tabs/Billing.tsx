import { useState } from 'react'
import type { BillingResponse } from '../lib/types'
import { api } from '../lib/api'
import { useApi } from '../lib/useApi'
import { Panel, StatCard } from '../components/primitives'

/**
 * Static marketing copy for each tier (feature lists, taglines).
 * Prices and run limits come from the real backend (/accounts/billing),
 * so this map only holds what the backend doesn't emit: marketing language.
 */
const PLAN_MARKETING: Record<string, {
  tagline: string
  features: string[]
  highlighted?: boolean
}> = {
  starter: {
    tagline: 'Solo creators getting started',
    features: [
      '1 niche',
      'TikTok + YouTube Shorts',
      'Script rewriter',
      'Email support',
    ],
  },
  growth: {
    tagline: 'Creators scaling their output',
    features: [
      '5 niches',
      'All 4 platforms',
      'Voiceover (ElevenLabs)',
      'Trend velocity dashboard',
      'Priority support',
    ],
    highlighted: true,
  },
  agency: {
    tagline: 'Agencies managing multiple clients',
    features: [
      'Unlimited niches',
      'Unlimited clients',
      'White-label dashboard',
      'API access',
      'Slack support',
    ],
  },
}

/**
 * Billing — consumption / usage. Reads the real backend's /accounts/billing,
 * which reports the active plan, how many runs were used this month against the
 * included allowance, and any consumption overage billed beyond it (hybrid
 * billing: past the tier's included runs, usage is billed per-run rather than
 * hard-blocked). Nothing here is mocked.
 */
export function Billing() {
  const bill = useApi<BillingResponse>(() => api.billing())
  const data = bill.data

  // Checkout state: which tier has a session being created right now (so the
  // button disables and no double-click starts two sessions), and any honest
  // error the backend returned (e.g. Stripe not configured yet).
  const [checkoutTierId, setCheckoutTierId] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)

  const startCheckout = async (tierId: string) => {
    if (checkoutTierId) return
    setCheckoutTierId(tierId)
    setCheckoutError(null)
    try {
      const { url } = await api.billingCheckout(tierId)
      // Real Stripe Checkout session — hand the browser to the hosted page.
      window.location.href = url
    } catch (err) {
      // The backend's own message (422 unconfigured Stripe, 400 unknown tier,
      // 403 missing permission…) shown verbatim — never a fake success.
      setCheckoutError(err instanceof Error ? err.message : String(err))
      setCheckoutTierId(null)
    }
  }

  const tier = data?.tiers.find((t) => t.id === data.plan?.tierId)
  const planName = tier?.name ?? (data?.plan?.tierId ? data.plan.tierId.toUpperCase() : 'NO PLAN')
  const limit = data?.monthlyRunLimit ?? 0
  const used = data?.runsUsedThisMonth ?? 0
  const overage = data?.overage
  const overageUsd = overage?.totalUsdThisMonth ?? 0
  const status = data?.plan?.status ?? ''

  const statCards = [
    { label: 'Plan', value: planName, sub: status ? `status: ${status}` : 'not subscribed', accent: 'var(--color-lime)' },
    { label: 'Runs Used', value: String(used), sub: limit ? `included: ${limit} / month` : 'no included allowance', accent: 'var(--color-lime)' },
    { label: 'Overage Runs', value: String(overage?.overageRunsThisMonth ?? 0), sub: 'beyond included allowance', accent: 'var(--color-orange)' },
    { label: 'Overage Billed', value: '$' + overageUsd.toFixed(2), sub: 'consumption this month', accent: 'var(--color-orange)' }
  ]

  return (
    <div className="space-y-8">
      {/* consumption headline */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--color-border)]">
        {statCards.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} accent={s.accent} />
        ))}
      </div>

      {/* usage bar against included allowance */}
      <Panel title="MONTHLY CONSUMPTION">
        <div className="p-5">
          <div className="flex items-center justify-between text-[11px] font-mono mb-2">
            <span className="text-[var(--color-muted)] uppercase tracking-widest">
              Runs used this month
            </span>
            <span className="text-[var(--color-lime)]">
              {used}
              {limit ? ` / ${limit} included` : ''}
            </span>
          </div>
          <div className="h-2 bg-[var(--color-border)] overflow-hidden">
            <div
              className="h-full transition-all"
              style={{
                width: limit > 0 ? `${Math.min(100, (used / limit) * 100)}%` : '0%',
                backgroundColor: limit > 0 && used > limit ? 'var(--color-orange)' : 'var(--color-lime)'
              }}
            />
          </div>
          {limit > 0 && used > limit ? (
            <p className="text-[11px] font-mono text-[var(--color-orange)] mt-3">
              You've exceeded the {limit} included runs. Additional runs are billed at ${(overage?.priceUsdPerRun ?? 0).toFixed(2)} each — no hard stop.
            </p>
          ) : (
            <p className="text-[11px] font-mono text-[var(--color-muted-2)] mt-3">
              Usage beyond the included allowance is billed per-run (hybrid billing), never hard-blocked.
            </p>
          )}
        </div>
      </Panel>

      {/* overage detail */}
      <Panel title="OVERAGE DETAIL">
        <div className="divide-y divide-[var(--color-raised)]">
          <OverageRow label="Charged overage runs this month" value={String(overage?.chargedThisMonth ?? 0)} />
          <OverageRow label="Per-run overage rate" value={`$${(overage?.priceUsdPerRun ?? 0).toFixed(2)}`} />
          <OverageRow label="Total overage billed this month" value={`$${overageUsd.toFixed(2)}`} accent="var(--color-orange)" />
        </div>
      </Panel>

      {/* plan / tier comparison */}
      <Panel title="PLANS">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-[var(--color-border)]">
          {data?.tiers.map((t) => {
            const isCurrent = t.id === data.plan?.tierId
            const isBusy = checkoutTierId === t.id
            const marketing = PLAN_MARKETING[t.id]
            return (
              <div
                key={t.id}
                className={`bg-[var(--color-bg)] p-5 flex flex-col gap-3 ${
                  isCurrent ? 'ring-1 ring-[var(--color-lime)]' :
                  marketing?.highlighted ? 'ring-1 ring-[var(--color-orange)]' : ''
                }`}
              >
                {/* header */}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black uppercase tracking-widest" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-text)' }}>
                    {t.name}
                  </span>
                  {isCurrent && <span className="text-[9px] font-mono text-[var(--color-on-accent)] bg-[var(--color-lime)] px-1.5 py-0.5">CURRENT</span>}
                  {!isCurrent && marketing?.highlighted && <span className="text-[9px] font-mono text-[var(--color-on-accent)] bg-[var(--color-orange)] px-1.5 py-0.5">POPULAR</span>}
                </div>

                {/* price */}
                <div>
                  <span className="text-2xl font-black" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: 'var(--color-lime)' }}>
                    ${t.priceUsdPerMonth}
                  </span>
                  <span className="text-[11px] font-mono text-[var(--color-muted-2)]">/mo</span>
                </div>

                {/* tagline */}
                {marketing?.tagline && (
                  <p className="text-[10px] font-mono text-[var(--color-muted-2)]">{marketing.tagline}</p>
                )}

                {/* run allowance */}
                <p className="text-[11px] font-mono text-[var(--color-muted-4)]">
                  {t.monthlyRunLimit} pipeline runs / month
                </p>

                {/* feature list */}
                {marketing?.features && (
                  <ul className="space-y-1">
                    {marketing.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[10px] font-mono text-[var(--color-muted)]">
                        <span className="text-[var(--color-lime)]">✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                )}

                {/* overage note */}
                <p className="text-[10px] font-mono text-[var(--color-muted-3)] mt-auto">
                  ${t.overagePriceUsdPerRun.toFixed(2)} per extra run
                </p>

                {!isCurrent && (
                  <button
                    onClick={() => startCheckout(t.id)}
                    disabled={checkoutTierId !== null}
                    className="px-4 py-2 font-black uppercase tracking-widest text-sm transition-colors disabled:opacity-50 hover:brightness-110"
                    style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
                  >
                    {isBusy ? 'OPENING CHECKOUT…' : 'GET STARTED'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-[10px] font-mono text-[var(--color-muted-3)] px-5 py-3">
          Plans bill monthly; consumption overage above the included runs is billed per-run. Checkout opens a real Stripe session — your current plan isn't charged until you confirm there.
        </p>
        {checkoutError && (
          <p className="text-[11px] font-mono text-[var(--color-red)] px-5 pb-3">
            Checkout error: {checkoutError}
          </p>
        )}
      </Panel>

      {bill.error && (
        <p className="text-[11px] font-mono text-[var(--color-red)]">Load error: {bill.error}</p>
      )}
    </div>
  )
}

function OverageRow({ label, value, accent = 'var(--color-text)' }: { label: string; value: string; accent?: string }) {
  return (
    <div className="px-5 py-4 flex items-center justify-between">
      <span className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">{label}</span>
      <span className="text-sm font-mono" style={{ color: accent }}>{value}</span>
    </div>
  )
}
