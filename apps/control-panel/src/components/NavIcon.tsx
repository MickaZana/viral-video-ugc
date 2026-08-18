type IconName =
  | 'week'
  | 'intel'
  | 'studio'
  | 'library'
  | 'review'
  | 'brand'
  | 'billing'
  | 'settings'

export function NavIcon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (name) {
    case 'week':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="11" />
          <path d="M2 6h12M5 2v2M11 2v2" />
        </svg>
      )
    case 'intel':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      )
    case 'studio':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" />
          <path d="M6.5 6.5 11 8 6.5 9.5z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'library':
      return (
        <svg {...common}>
          <rect x="3" y="2" width="7" height="12" />
          <path d="M10 4h3v10H6" />
        </svg>
      )
    case 'review':
      return (
        <svg {...common}>
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      )
    case 'brand':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="10" height="10" />
          <path d="M3 6h10" />
        </svg>
      )
    case 'billing':
      return (
        <svg {...common}>
          <rect x="2" y="4" width="12" height="8" />
          <path d="M2 7h12" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2.5v1.5M8 12v1.5M2.5 8h1.5M12 8h1.5M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M11.9 4.1 10.8 5.2M5.2 10.8 4.1 11.9" />
        </svg>
      )
  }
}