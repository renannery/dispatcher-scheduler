import clsx from 'clsx'

import { shortHour } from '@/utils/displayHelpers'

interface Slot {
  label: string
  hours: number
}

interface Props {
  /** [7][slots] bitmap; if undefined treated as all-false */
  blocks: boolean[][] | undefined
  slots: Slot[]
  /** color used for the person's accent (column header dot) */
  accentColor?: string
  onToggle: (dayOfWeek: number, slotIndex: number) => void
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * 7-day × N-slot grid for setting a person's recurring weekly time-off.
 * Each row = day-of-week, each column = hour slot. Click cells to toggle.
 */
export function RecurringBlocksEditor({ blocks, slots, accentColor, onToggle }: Props) {
  const isBlocked = (dow: number, si: number) => blocks?.[dow]?.[si] ?? false
  const dowCount = (dow: number) => (blocks?.[dow] ?? []).filter(Boolean).length

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
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
                        title={`${dowName} ${s.label} — ${blocked ? 'click to unblock' : 'click to block'}`}
                        aria-label={`${dowName} ${s.label}`}
                      />
                    </td>
                  )
                })}
                <td className="px-2 py-0.5 text-right text-slate-500">
                  {dowCount(dow) > 0 ? `${dowCount(dow)}h` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-slate-400">
        Recurring breaks apply every week. They&apos;re respected by the auto-scheduler and shown as
        hatched cells in the schedule grid.
      </p>
    </div>
  )
}
