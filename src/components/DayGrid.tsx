import clsx from 'clsx'

import { DAY_TEMPLATES, SLOTS } from '@/data/coverageTemplate'
import type { GeneratedSchedule } from '@/types/schedule'
import { coverageStatus } from '@/utils/scheduler'

interface Props {
  schedule: GeneratedSchedule
  date: string      // "YYYY-MM-DD"
  dayLabel: string  // "Thu, May 28"
  dayOfWeek: number
}

export function DayGrid({ schedule, date, dayLabel, dayOfWeek }: Props) {
  const template = DAY_TEMPLATES[dayOfWeek]
  const required = template?.requiredCoverage ?? SLOTS.map(() => 0)
  const actual = schedule.coverageActual[date] ?? SLOTS.map(() => 0)

  // Only show slots that have >0 required OR >0 actual coverage
  const visibleSlotIndices = SLOTS.map((_, i) => i).filter(
    (i) => required[i] > 0 || actual[i] > 0,
  )

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        {/* Slot header */}
        <thead>
          <tr>
            <th className="sticky left-0 z-10 min-w-[130px] bg-slate-800 px-3 py-2 text-left font-semibold text-white">
              {dayLabel}
            </th>
            {visibleSlotIndices.map((si) => (
              <th
                key={si}
                className="min-w-[54px] bg-slate-800 px-1 py-2 text-center font-medium text-slate-300 whitespace-nowrap"
                title={`${SLOTS[si].label} (${SLOTS[si].hours}h)`}
              >
                <div className="text-[10px]">{SLOTS[si].label.split('–')[0].trim()}</div>
                <div className="text-[9px] text-slate-500">{SLOTS[si].hours}h</div>
              </th>
            ))}
            <th className="bg-slate-800 px-3 py-2 text-right font-semibold text-slate-300">
              Hrs
            </th>
          </tr>
        </thead>

        <tbody>
          {schedule.dispatcherSchedules.map((ds, rowIdx) => {
            const entry = ds.days.find((d) => d.date === date)
            const isOff = !entry || entry.isOff

            return (
              <tr
                key={ds.dispatcher.id}
                className={clsx(
                  'border-t border-slate-100',
                  rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50',
                )}
              >
                {/* Dispatcher name */}
                <td className="sticky left-0 bg-inherit px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-5 w-5 shrink-0 rounded-full text-center text-[9px] font-bold leading-5 text-white"
                      style={{ backgroundColor: ds.dispatcher.color }}
                    >
                      {ds.dispatcher.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <span className={clsx('font-medium', isOff ? 'text-slate-400' : 'text-slate-800')}>
                      {ds.dispatcher.name.split(' ')[0]}
                    </span>
                    <span className={clsx(
                      'rounded px-1 text-[9px] font-bold',
                      ds.dispatcher.level === 'Senior'  && 'bg-amber-100 text-amber-600',
                      ds.dispatcher.level === 'Regular' && 'bg-blue-100 text-blue-600',
                      ds.dispatcher.level === 'Trainee' && 'bg-slate-100 text-slate-500',
                    )}>
                      {ds.dispatcher.level === 'Senior' ? 'SR' : ds.dispatcher.level === 'Regular' ? 'RG' : 'TR'}
                    </span>
                    {isOff && (
                      <span className="rounded bg-slate-100 px-1 text-[9px] text-slate-400">OFF</span>
                    )}
                  </div>
                </td>

                {/* Slot cells */}
                {visibleSlotIndices.map((si) => {
                  const working = entry?.slots[si] ?? false
                  return (
                    <td
                      key={si}
                      className="px-0.5 py-1"
                    >
                      {working ? (
                        <div
                          className="mx-auto h-5 w-full max-w-[52px] rounded text-center text-[9px] font-bold leading-5 text-white"
                          style={{ backgroundColor: ds.dispatcher.color }}
                        />
                      ) : (
                        <div className="mx-auto h-5 w-full max-w-[52px]" />
                      )}
                    </td>
                  )
                })}

                {/* Daily hours */}
                <td className="px-3 py-1.5 text-right">
                  {isOff ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="font-semibold text-slate-700">
                      {entry?.totalHours?.toFixed(1)}h
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>

        {/* Coverage counter row */}
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
              {actual.reduce((s, a, i) => s + a * SLOTS[i].hours, 0).toFixed(1)}h
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
