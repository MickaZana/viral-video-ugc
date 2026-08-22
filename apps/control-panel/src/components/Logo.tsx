/**
 * Viral Video UGC official logo and wordmark.
 * Uses official brand logo asset. Clicking the logo navigates to home/This Week.
 */
export function Logo({
  onClick,
  size = 32,
  showWordmark = true,
  wordmarkClass = 'text-[15px]'
}: {
  onClick?: () => void
  size?: number
  showWordmark?: boolean
  wordmarkClass?: string
}) {
  const inner = (
    <>
      <img
        src="/logo.png"
        alt="Viral Video UGC Logo"
        className="shrink-0 rounded-lg object-contain shadow-sm"
        style={{ width: size, height: size }}
      />
      {showWordmark && (
        <span className={`${wordmarkClass} font-semibold tracking-tight leading-none select-none text-[var(--color-text)]`}>
          Viral Video UGC
        </span>
      )}
    </>
  )

  if (!onClick) {
    return (
      <span className="flex items-center gap-2.5" aria-label="Viral Video UGC">
        {inner}
      </span>
    )
  }

  return (
    <button
      onClick={onClick}
      aria-label="Viral Video UGC — This Week"
      title="This Week"
      className="flex items-center gap-2.5 group cursor-pointer hover:opacity-90 transition-opacity"
    >
      {inner}
    </button>
  )
}