/**
 * Viral Video UGC wordmark. Lime is a 6px signal LED, not a brand fill.
 * Clicking the logo goes to This Week (callers pass onClick).
 */
export function Logo({
  onClick,
  size = 8,
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
      <span
        className="shrink-0 bg-[var(--color-lime)]"
        style={{ width: size, height: size }}
        aria-hidden="true"
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
      className="flex items-center gap-2.5 group cursor-pointer"
    >
      {inner}
    </button>
  )
}