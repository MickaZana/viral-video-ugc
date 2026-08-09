/**
 * UGU PROGRAM logo — a bold lime rounded square with an upward "viral growth"
 * arrow cut out of it. The single lime block was already the product's visual
 * identity, so this keeps that mark but turns it into a real, memorable glyph:
 * the arrow reads as growth / virality and (tilted in a viewer's mind) a play /
 * fast-forward — matching the spy → rewrite → remake engine.
 *
 * Clicking the logo navigates "home" (see callers: the workspace header returns
 * to the dashboard, the landing header scrolls to the landing top).
 */
export function Logo({
  onClick,
  size = 34,
  showWordmark = true,
  wordmarkClass = 'text-xl'
}: {
  onClick?: () => void
  size?: number
  showWordmark?: boolean
  wordmarkClass?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-label="UGU PROGRAM — go to home"
      title="Home"
      className="flex items-center gap-2.5 group cursor-pointer"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        className="transition-transform duration-200 group-hover:scale-105"
      >
        {/* lime block */}
        <rect x="2" y="2" width="60" height="60" rx="15" fill="var(--color-lime)" />
        {/* upward arrow cutout (growth / virality) */}
        <path
          d="M32 10 L45 28 L38 28 L32 19 L26 28 L19 28 Z M28 34 L36 34 L36 52 L28 52 Z"
          fill="var(--color-on-accent)"
        />
      </svg>
      {showWordmark && (
        <span
          className={`${wordmarkClass} font-black uppercase tracking-widest leading-none select-none`}
          style={{ fontFamily: 'Barlow Condensed' }}
        >
          <span className="text-[var(--color-text)]">UGU </span>
          <span className="text-[var(--color-lime)]">PROGRAM</span>
        </span>
      )}
    </button>
  )
}
