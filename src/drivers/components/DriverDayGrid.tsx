import clsx from 'clsx'
import { useState } from 'react'

import { HoverHint } from '@/components/HoverHint'
import { reasonColors, reasonLabel, reasonShort } from '@/utils/absence'

import { DRIVER_DAY_TEMPLATES, DRIVER_SLOTS } from '../coverageTemplate'
import { coverageStatus } from '../scheduler'
import { useDriverStore } from '../store'
import type { GeneratedDriverSchedule } from '../types'
import { displayName, shortHour } from '../utils'

interface Props {
  schedule: GeneratedDriverSchedule
  date: string
  dayLabel: string
  dayOfWeek: number
  /** When set, only drivers with these ids appear (overrides showOff toggle). */
  driverIdFilter?: Set<string> | null
}

export function DriverDayGrid({ schedule, date, dayLabel, dayOfWeek, driverIdFilter }: Props) {
  const toggleDriverSlot = useDriverStore((s) => s.toggleDriverSlot)
  const timeOff = useDriverStore((s) => s.timeOff)
  const absenceReasons = useDriverStore((s) => s.absenceReasons)
  const template = DRIVER_DAY_TEMPLATES[dayOfWeek]
  const required = template?.requiredCoverage ?? DRIVER_SLOTS.map(() => 0)
  const actual = schedule.coverageActual[date] ?? DRIVER_SLOTS.map(() => 0)
  const [showOff, setShowOff] = useState(false)

  const visibleSlotIndices = DRIVER_SLOTS.map((_, i) => i).filter(
    (i) => required[i] > 0 || actual[i] > 0,
  )

  // Apply row filters: external search filter takes precedence over the local OFF toggle
  const allRows = schedule.driverSchedules.map((ds) => {
    const entry = ds.days.find((d) => d.date === date)
    return { ds, entry, isOff: !entry || entry.isOff }
  })
  const visibleRows = allRows.filter(({ ds, isOff }) => {
    if (driverIdFilter) return driverIdFilter.has(ds.driver.id)
    return showOff || !isOff
  })
  const hiddenOffCount = driverIdFilter ? 0 : allRows.filter((r) => r.isOff).length

  return (
    <div className="overflow-x-auto">
      {/* Toggle for hidden OFF rows (only when there are any and no external filter) */}
      {hiddenOffCount > 0 && (
        <div className="flex items-center justify-end px-4 py-1.5 text-[11px] text-slate-400">
          <button
            type="button"
            onClick={() => setShowOff((v) => !v)}
            className="hover:text-blue-600"
          >
            {showOff
              ? `hide ${hiddenOffCount} off`
              : `show ${hiddenOffCount} off`}
          </button>
        </div>
      )}
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 min-w-[130px] bg-slate-800 px-3 py-2 text-left font-semibold text-white">
              {dayLabel}
            </th>
            {visibleSlotIndices.map((si) => (
              <th
                key={si}
                className="min-w-[48px] bg-slate-800 px-1 py-2 text-center font-medium text-slate-300 whitespace-nowrap"
                title={DRIVER_SLOTS[si].label}
              >
                <div className="text-[10px]">{shortHour(DRIVER_SLOTS[si].label)}</div>
                <div className="text-[9px] text-slate-500">1h</div>
              </th>
            ))}
            <th className="bg-slate-800 px-3 py-2 text-right font-semibold text-slate-300">Hrs</th>
          </tr>
        </thead>

        <tbody>
          {visibleRows.length === 0 && driverIdFilter && (
            <tr><td colSpan={visibleSlotIndices.length + 2} className="px-3 py-3 text-center text-xs text-slate-400">
              No drivers match the search on this day.
            </td></tr>
          )}
          {visibleRows.map(({ ds, entry, isOff }, rowIdx) => {
            return (
              <tr
                key={ds.driver.id}
                className={clsx(
                  'border-t border-slate-100',
                  rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50',
                )}
              >
                <td className="sticky left-0 bg-inherit px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-5 w-5 shrink-0 rounded-full text-center text-[9px] font-bold leading-5 text-white"
                      style={{ backgroundColor: ds.driver.color }}
                    >
                      {ds.driver.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <span
                      className={clsx('font-medium', isOff ? 'text-slate-400' : 'text-slate-800')}
                      title={ds.driver.name}
                    >
                      {displayName(ds.driver.name)}
                    </span>
                    <span
                      className={clsx(
                        'rounded px-1 text-[9px] font-bold',
                        ds.driver.employmentType === 'full'
                          ? 'bg-blue-100 text-blue-600'
                          : 'bg-emerald-100 text-emerald-600',
                      )}
                    >
                      {ds.driver.employmentType === 'full' ? 'FT' : 'PT'}
                    </span>
                    {isOff && (() => {
                      const r = absenceReasons[ds.driver.id]?.[date]
                      if (r) {
                        return (
                          <HoverHint label={`Off — ${reasonLabel(r)}`}>
                            <span className={clsx('rounded border px-1 text-[9px] font-semibold uppercase tracking-wide', reasonColors(r).tw)}>
                              {reasonShort(r)}
                            </span>
                          </HoverHint>
                        )
                      }
                      return (
                        <HoverHint label="Off — no reason set">
                          <span className="rounded bg-slate-100 px-1 text-[9px] text-slate-400">
                            OFF
                          </span>
                        </HoverHint>
                      )
                    })()}
                  </div>
                </td>

                {visibleSlotIndices.map((si) => {
                  const working = entry?.slots[si] ?? false
                  const dateBlocked = timeOff[ds.driver.id]?.[date]?.[si] ?? false
                  const recurBlocked = ds.driver.recurringBlocks?.[dayOfWeek]?.[si] ?? false
                  const blocked = dateBlocked || recurBlocked
                  return (
                    <td
                      key={si}
                      className="group cursor-pointer px-0.5 py-1"
                      onClick={() => toggleDriverSlot(ds.driver.id, date, si)}
                      title={
                        blocked
                          ? `Blocked off — ${DRIVER_SLOTS[si].label} (click to override)`
                          : working
                            ? `Remove ${DRIVER_SLOTS[si].label}`
                            : `Add ${DRIVER_SLOTS[si].label}`
                      }
                    >
                      {working ? (
                        <div
                          className={clsx(
                            'mx-auto h-5 w-full max-w-[46px] rounded text-center text-[9px] font-bold leading-5 text-white transition group-hover:ring-2 group-hover:ring-red-400 group-hover:ring-offset-1',
                            blocked && 'ring-2 ring-red-500 ring-offset-1',
                          )}
                          style={{ backgroundColor: ds.driver.color }}
                        />
                      ) : blocked ? (
                        <div
                          className="mx-auto h-5 w-full max-w-[46px] rounded border border-red-300 bg-[repeating-linear-gradient(45deg,_#fee2e2_0,_#fee2e2_3px,_transparent_3px,_transparent_6px)] transition group-hover:opacity-80"
                          aria-label="blocked"
                        />
                      ) : (
                        <div
                          className="mx-auto h-5 w-full max-w-[46px] rounded border border-dashed border-transparent opacity-0 transition group-hover:opacity-60"
                          style={{ borderColor: ds.driver.color }}
                        />
                      )}
                    </td>
                  )
                })}

                <td className="px-3 py-1.5 text-right">
                  {isOff ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="font-semibold text-slate-700">
                      {entry?.totalHours?.toFixed(0)}h
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>

        <tfoot>
          <tr className="border-t-2 border-slate-300">
            <td className="sticky left-0 bg-slate-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Coverage
            </td>
            {visibleSlotIndices.map((si) => {
              const a = actual[si]
              const r = required[si]
              const status = coverageStatus(a, r)
              return (
                <td key={si} className="px-0.5 py-1 text-center">
                  <div
                    className={clsx(
                      'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                      status === 'ok'    && 'bg-emerald-100 text-emerald-700',
                      status === 'mild'  && 'bg-amber-100 text-amber-700',
                      status === 'short' && 'bg-red-100 text-red-700 ring-1 ring-red-400',
                      status === 'over'  && 'bg-slate-100 text-slate-400',
                    )}
                    title={`Actual: ${a} | Required: ${r}`}
                  >
                    {a}
                    {r > 0 && <span className="ml-0.5 opacity-50">/{r}</span>}
                  </div>
                </td>
              )
            })}
            <td className="px-3 py-1.5 text-right text-[10px] text-slate-500">
              {actual.reduce((s, a) => s + a, 0)}h
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
