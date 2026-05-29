import clsx from 'clsx'
import { differenceInDays, format, parseISO } from 'date-fns'
import { AlertCircle, Calendar } from 'lucide-react'

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

const DOW_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Work-week convention used throughout the scheduler.
const EXPECTED_START_DOW = 4 // Thursday
const EXPECTED_END_DOW = 3   // Wednesday

/**
 * Single date-range picker — two native date inputs styled as a unified
 * control with an arrow between them. Replaces the previous pattern of
 * having two stand-alone start/end fields. Used on the Period step and
 * also on the Schedule step's header so the period can be adjusted
 * without walking back through the wizard.
 *
 * Each date input shows a weekday badge above it. Since the scheduler's
 * work week runs Thursday → Wednesday, the badge turns AMBER when the
 * picked date doesn't align with the expected weekday, with a tooltip
 * explaining the convention. This is a warning, not a block — ops can
 * still pick any range, but they're flagged before they accidentally
 * cut a week in half.
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

  // Compute weekday-of-week (0-6) for each picked date. Used to flag
  // start ≠ Thu / end ≠ Wed misalignment.
  const startDow = startDate ? parseISO(startDate).getDay() : -1
  const endDow = endDate ? parseISO(endDate).getDay() : -1
  const startAligned = startDow === EXPECTED_START_DOW
  const endAligned = endDow === EXPECTED_END_DOW

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
        <DateInput
          value={startDate}
          dow={startDow}
          aligned={startAligned}
          expectedLabel="Thu"
          ariaLabel="Start date"
          compact={compact}
          onChange={handleStart}
        />
        <div className="flex items-center px-2 text-slate-400">→</div>
        <DateInput
          value={endDate}
          dow={endDow}
          aligned={endAligned}
          expectedLabel="Wed"
          ariaLabel="End date"
          compact={compact}
          min={startDate}
          onChange={handleEnd}
        />
      </div>
      {!valid && (
        <p className={clsx('text-red-600', compact ? 'text-[10px]' : 'text-xs')}>
          End date must be on or after the start date.
        </p>
      )}
      {valid && (!startAligned || !endAligned) && (
        <p className={clsx(
          'flex items-center gap-1 text-amber-700',
          compact ? 'text-[10px]' : 'text-xs',
        )}>
          <AlertCircle className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
          Work week runs <span className="font-semibold">Thursday → Wednesday</span>.
          {!startAligned && ` Start is a ${DOW_FULL[startDow]} (expected Thu).`}
          {!endAligned && ` End is a ${DOW_FULL[endDow]} (expected Wed).`}
        </p>
      )}
      {valid && !compact && startAligned && endAligned && (
        <p className="text-xs text-slate-400">
          {format(parseISO(startDate), 'EEE, MMM d, yyyy')} → {format(parseISO(endDate), 'EEE, MMM d, yyyy')}
        </p>
      )}
    </div>
  )
}

interface DateInputProps {
  value: string
  dow: number
  aligned: boolean
  /** "Thu" or "Wed" — the weekday the work week expects for this end. */
  expectedLabel: string
  ariaLabel: string
  compact: boolean
  min?: string
  onChange: (v: string) => void
}

/**
 * One half of the range picker. Native date input with a weekday badge
 * overlaid on top so the user can see at a glance whether they picked
 * the right end of the work week.
 */
function DateInput({ value, dow, aligned, expectedLabel, ariaLabel, compact, min, onChange }: DateInputProps) {
  const dowLabel = dow >= 0 ? DOW_FULL[dow] : '—'
  return (
    <div className="relative flex-1">
      <input
        type="date"
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={clsx(
          'w-full bg-transparent text-slate-800 outline-none',
          // Reserve room for the weekday badge on the left.
          compact ? 'py-1.5 pl-12 pr-3 text-xs' : 'py-2.5 pl-14 pr-4 text-sm',
        )}
      />
      <span
        title={
          aligned
            ? `${dowLabel} — matches the Thu → Wed work week.`
            : `${dowLabel} — work week is Thu → Wed, expected ${expectedLabel}. You can still pick this date but the schedule will be split mid-week.`
        }
        className={clsx(
          'pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 rounded font-bold uppercase tracking-wide',
          compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]',
          aligned
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-amber-100 text-amber-800 ring-1 ring-amber-300',
        )}
      >
        {dowLabel}
      </span>
    </div>
  )
}
