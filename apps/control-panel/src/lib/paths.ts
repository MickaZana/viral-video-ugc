export const APP_BASENAME = '/app'

export const paths = {
  home: '/',
  intel: '/intel',
  intelRemix: '/intel/remix',
  intelSource: (id: string) => `/intel/${encodeURIComponent(id)}`,
  studio: '/studio',
  studioScript: (id: string) => `/studio/script/${encodeURIComponent(id)}`,
  studioRun: (runId: string) => `/studio/runs/${encodeURIComponent(runId)}`,
  library: '/library',
  libraryItem: (id: string) => `/library/${encodeURIComponent(id)}`,
  review: '/review',
  reviewItem: (id: string) => `/review/${encodeURIComponent(id)}`,
  brand: '/brand',
  brandClient: (id: string) => `/brand/clients/${encodeURIComponent(id)}`,
  billing: '/billing',
  settings: '/settings'
} as const

/** Legacy tab ids used by leftover EmptyState CTAs — map onto workspace paths. */
export const tabPath: Record<string, string> = {
  dashboard: paths.home,
  spy: paths.intel,
  rewriter: paths.studio,
  remix: paths.intelRemix,
  generator: paths.studio,
  history: paths.library,
  billing: paths.billing
}