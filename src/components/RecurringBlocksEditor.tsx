import clsx from 'clsx'

import { shortHour } from '@/utils/displayHelpers'

interface Slot {
  label: string
  hours: number
}

interface Props {
  /** [7][slots] bitmap of BLOCKED slots; if undefined treated as all-false */
  blocks: boolean[][] | undefined
  slots: Slot[]
  /** color used for the person's accent (column header dot) */
  accentColor?: string
  /** Per-cell toggle — flips a single (dow, slot) cell. */
  onToggle: (dayOfWeek: number, slotIndex: number) => void
  /** Bulk write of the full 7×N grid. Used by presets and per-day toggles. */
  onSetAll?: (blocks: boolean[][]) => void
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Build a fresh 7×N grid from a per-(dow, slot) predicate. */
function buildGrid(slotCount: number, fn: (dow: number, slot: number) => boolean): boolean[][] {
  return Array.from({ length: 7 }, (_, dow) =>
    Array.from({ length: slotCount }, (_, slot) => fn(dow, slot)),
  )
}

/**
 * 7-day × N-slot grid for setting a person's recurring weekly availability.
 * Each row = day-of-week, each column = hour slot. RED cells = unavailable;
 * WHITE cells = available. Click cells to toggle, or use the quick presets
 * above the grid for common patterns like "weekends only" or
 * "weekday evenings only".
 */
export function RecurringBlocksEditor({ blocks, slots, accentColor, onToggle, onSetAll }: Props) {
  const isBlocked = (dow: number, si: number) => blocks?.[dow]?.[si] ?? false
  const dowBlocked = (dow: number) => (blocks?.[dow] ?? []).filter(Boolean).length
  const N = slots.length

  // Common availability patterns. They overwrite the entire grid.
  // Slot index conventions for the 15-slot driver grid:
  //   0=8AM, 1=9AM, ..., 9=5PM, 10=6PM, 14=10PM
  const presets: { label: string; build: () => boolean[][]; tooltip: string }[] = [
    {
      label: 'Available all',
      tooltip: 'Clear all blocks — driver is available any time the operation is open.',
      build: () => buildGrid(N, () => false),
    },
    {
      label: 'Weekends only',
      tooltip: 'Available Sat + Sun all day. Mon–Fri blocked entirely.',
      build: () => buildGrid(N, (dow) => dow >= 1 && dow <= 5),
    },
    {
      label: 'Weekday evenings only',
      tooltip: 'Available Mon–Fri after 5 PM (slot 10+) and weekends. Mon–Fri morning/midday blocked.',
      build: () => buildGrid(N, (dow, slot) => dow >= 1 && dow <= 5 && slot < 10),
    },
    {
      label: 'Long weekend evenings only',
      tooltip: 'Available Fri/Sat/Sun after 5 PM only. Mon–Thu blocked entirely (common PT pattern for people with weekday jobs).',
      build: () => buildGrid(N, (dow, slot) => {
        // Block Mon (1), Tue (2), Wed (3), Thu (4) entirely
        if (dow >= 1 && dow <= 4) return true
        // On Fri (5), Sat (6), Sun (0): block before 6 PM (slots 0-9)
        if ((dow === 5 || dow === 6 || dow === 0) && slot < 10) return true
        return false
      }),
    },
    {
      label: 'Mornings only',
      tooltip: 'Available before 2 PM (slot 0-5) every day. Afternoon/evening blocked.',
      build: () => buildGrid(N, (_, slot) => slot >= 6),
    },
  ]

  const dayHasAnyBlock = (dow: number) => dowBlocked(dow) > 0
  const dayFullyBlocked = (dow: number) => dowBlocked(dow) === N

  const toggleWholeDay = (dow: number) => {
    if (!onSetAll) return
    const fullyBlocked = dayFullyBlocked(dow)
    const fresh = buildGrid(N, (d, s) => (d === dow ? !fullyBlocked : isBlocked(d, s)))
    onSetAll(fresh)
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      {onSetAll && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Quick set
          </span>
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => onSetAll(preset.build())}
              title={preset.tooltip}
              className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-y-0.5 text-[10px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50/50 px-1.5 py-1 text-left font-semibold text-slate-500" />
              {slots.map((s, si) => (
                <th
                  key={si}
                  className="min-w-[34px] px-0.5 py-1 text-center font-medium text-slate-400"
                  title={s.label}
                >
                  {shortHour(s.label)}
                </th>
              ))}
              <th className="px-2 py-1 text-right font-medium text-slate-400">Σ</th>
              {onSetAll && <th className="px-1 py-1 text-right font-medium text-slate-400" />}
            </tr>
          </thead>
          <tbody>
            {DOW_LABELS.map((dowName, dow) => (
              <tr key={dow}>
                <td className="sticky left-0 z-10 bg-slate-50/50 px-1.5 py-0.5 pr-2 text-left font-semibold text-slate-600">
                  <span className="flex items-center gap-1">
                    {accentColor && (
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accentColor }} />
                    )}
                    {dowName}
                  </span>
                </td>
                {slots.map((s, si) => {
                  const blocked = isBlocked(dow, si)
                  return (
                    <td key={si} className="px-0.5 py-0.5">
                      <button
                        type="button"
                        onClick={() => onToggle(dow, si)}
                        className={clsx(
                          'mx-auto h-4 w-full max-w-[30px] rounded border transition',
                          blocked
                            ? 'border-red-300 bg-red-200 hover:bg-red-300'
                            : 'border-slate-200 bg-white hover:border-red-200 hover:bg-red-50',
                        )}
                        title={`${dowName} ${s.label} — ${blocked ? 'click to make available' : 'click to block'}`}
                        aria-label={`${dowName} ${s.label}`}
                      />
                    </td>
                  )
                })}
                <td className="px-2 py-0.5 text-right text-slate-500">
                  {dowBlocked(dow) > 0 ? `${dowBlocked(dow)}h` : '—'}
                </td>
                {onSetAll && (
                  <td className="px-1 py-0.5 text-right">
                    <button
                      type="button"
                      onClick={() => toggleWholeDay(dow)}
                      title={dayFullyBlocked(dow) ? `Make ${dowName} fully available` : `Block all of ${dowName}`}
                      className={clsx(
                        'rounded border px-1 py-0.5 text-[9px] font-semibold transition',
                        dayHasAnyBlock(dow)
                          ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100'
                          : 'border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:bg-red-50',
                      )}
                    >
                      {dayFullyBlocked(dow) ? 'free' : 'block'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-slate-400">
        Red cells = driver unavailable. White cells = available. Recurring weekly availability —
        applies to every week the auto-scheduler runs.
      </p>
    </div>
  )
}
