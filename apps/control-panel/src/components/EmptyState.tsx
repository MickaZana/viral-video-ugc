interface EmptyStateProps {
  icon: string
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

export function EmptyState({ icon, title, description, actionLabel, onAction, secondaryLabel, onSecondary }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {icon ? (
        <div className="w-16 h-16 flex items-center justify-center border border-[var(--color-raised)] mb-6">
          <span className="text-sm text-[var(--color-muted-3)]">{icon}</span>
        </div>
      ) : null}
      <h3 className="text-lg font-semibold tracking-tight mb-2 text-[var(--color-text)]">{title}</h3>
      <p className="text-[13px] text-[var(--color-muted-4)] max-w-md leading-relaxed mb-6">{description}</p>
      <div className="flex items-center gap-3">
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="px-6 py-2.5 font-semibold uppercase tracking-widest text-sm transition-colors hover:brightness-110"
            style={{ backgroundColor: 'var(--color-lime)', color: 'var(--color-on-accent)' }}
          >
            {actionLabel}
          </button>
        )}
        {secondaryLabel && onSecondary && (
          <button
            onClick={onSecondary}
            className="px-5 py-2.5 text-[10px] uppercase tracking-widest border border-[var(--color-faint)] text-[var(--color-muted-4)] hover:border-[var(--color-lime)] hover:text-[var(--color-lime)] transition-colors"
          >
            {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  )
}