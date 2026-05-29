import clsx from 'clsx'
import { differenceInDays, format, parseISO } from 'date-fns'
import { Calendar } from 'lucide-react'

interface Props {
  /** ISO date string yyyy-MM-dd for the start of the range. */
  startDate: string
  /** ISO date string yyyy-MM-dd for the end of the range. */
  endDate: string
  /**
   * Called with the new (start, end) pair whenever either input changes.
   * Implementations should clamp end >= start before persisting.
   */
  onChange: (start: string, end: string) => void
  /** Optional label shown above the picker. Defaults to "Schedule period". */
  label?: string
  /** Compact mode: smaller paddings, no inline stats, used in headers. */
  compact?: boolean
  /** Override the "X days · Y weeks" summary suffix (e.g. hide it). */
  showStats?: boolean
}

/**
 * Single date-range picker — two native date inputs styled as a unified
 * control with an arrow between them. Replaces the previous pattern of
 * having two stand-alone start/end fields. Used on the Period step and
 * also on the Schedule step's header so the period can be adjusted
 * without walking back through the wizard.
 *
 * Stays native (no calendar pop-over library) so date validation,
 * keyboard nav, and locale formatting come for free from the browser.
 */
export function DateRangePicker({
  startDate, endDate, onChange,
  label = 'Schedule period',
  compact = false,
  showStats = true,
}: Props) {
  const valid = startDate && endDate && endDate >= startDate
  const totalDays = valid ? differenceInDays(parseISO(endDate), parseISO(startDate)) + 1 : 0
  const totalWeeks = Math.ceil(totalDays / 7)

  const handleStart = (s: string) => {
    // Clamp end if the new start pushed past it.
    onChange(s, endDate < s ? s : endDate)
  }
  const handleEnd = (e: string) => {
    onChange(startDate, e)
  }

  return (
    <div className={clsx('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}>
      {label && (
        <label className={clsx(
          'flex items-center gap-1.5 font-medium text-slate-600',
          compact ? 'text-xs' : 'text-sm',
        )}>
          <Calendar className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          {label}
          {showStats && valid && (
            <span className={clsx(
              'ml-auto rounded bg-slate-100 px-1.5 py-0.5 font-normal text-slate-500',
              compact ? 'text-[10px]' : 'text-xs',
            )}>
              {totalDays} day{totalDays === 1 ? '' : 's'} · {totalWeeks} week{totalWeeks === 1 ? '' : 's'}
            </span>
          )}
        </label>
      )}
      <div className={clsx(
        'flex items-stretch rounded-xl border bg-white shadow-sm transition focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-200',
        valid ? 'border-slate-300' : 'border-red-300',
      )}>
        <input
          type="date"
          value={startDate}
          onChange={(e) => handleStart(e.target.value)}
          aria-label="Start date"
          className={clsx(
            'flex-1 bg-transparent text-slate-800 outline-none',
            compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
          )}
        />
        <div className="flex items-center px-2 text-slate-400">→</div>
        <input
          type="date"
          value={endDate}
          min={startDate}
          onChange={(e) => handleEnd(e.target.value)}
          aria-label="End date"
          className={clsx(
            'flex-1 bg-transparent text-slate-800 outline-none',
            compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
          )}
        />
      </div>
      {!valid && (
        <p className={clsx('text-red-600', compact ? 'text-[10px]' : 'text-xs')}>
          End date must be on or after the start date.
        </p>
      )}
      {valid && !compact && (
        <p className="text-xs text-slate-400">
          {format(parseISO(startDate), 'MMM d, yyyy')} → {format(parseISO(endDate), 'MMM d, yyyy')}
        </p>
      )}
    </div>
  )
}
