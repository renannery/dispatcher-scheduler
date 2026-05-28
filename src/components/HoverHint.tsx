import type { ReactNode } from 'react'

interface Props {
  label: string
  children: ReactNode
  /** Where the tooltip floats relative to the trigger. Defaults to `top`. */
  side?: 'top' | 'bottom'
}

/**
 * Lightweight CSS-only hover tooltip — instant show (no browser title delay).
 * The trigger element is passed as children; the tooltip floats above (or below).
 */
export function HoverHint({ label, children, side = 'top' }: Props) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        className={[
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100',
          side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
        ].join(' ')}
        role="tooltip"
      >
        {label}
      </span>
    </span>
  )
}
