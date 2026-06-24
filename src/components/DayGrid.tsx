import clsx from 'clsx'
import { useRef, useState } from 'react'

import { DAY_TEMPLATES, LONG_SHIFT_BREAK_MIN, MED_SHIFT_BREAK_MIN, patternMaxBreakHours, SLOTS } from '@/data/coverageTemplate'
import { useIsAdmin } from '@/store/adminStore'
import { useSchedulerStore } from '@/store/schedulerStore'
import type { GeneratedSchedule } from '@/types/schedule'
import { HoverHint } from '@/components/HoverHint'
import { NowLine } from '@/components/NowLine'
import { reasonColors, reasonLabel, reasonShort } from '@/utils/absence'
import { shortHour } from '@/utils/displayHelpers'
import { coverageStatus } from '@/utils/scheduler'

interface Props {
  schedule: GeneratedSchedule
  date: string      // "YYYY-MM-DD"
  dayLabel: string  // "Thu, May 28"
  dayOfWeek: number
  /** When set, only dispatchers with these ids appear (overrides showOff toggle). */
  dispatcherIdFilter?: Set<string> | null
  /** When set, draws a vertical "NOW" line at this slot+frac on this day. */
  nowSlotIdx?: number
  nowMinuteFrac?: number
  nowLabel?: string
}

export function DayGrid({ schedule, date, dayLabel, dayOfWeek, dispatcherIdFilter, nowSlotIdx, nowMinuteFrac, nowLabel }: Props) {
  const timeOff = useSchedulerStore((s) => s.timeOff)
  const absenceReasons = useSchedulerStore((s) => s.absenceReasons)
  const toggleDispatcherSlot = useSchedulerStore((s) => s.toggleDispatcherSlot)
  const isAdmin = useIsAdmin()
  const template = DAY_TEMPLATES[dayOfWeek]
  // Prefer the per-date `coverageRequired` baked into the schedule (it
  // reflects user overrides at generation time). Fall back to the template
  // baseline for schedules generated before overrides shipped.
  const required = schedule.coverageRequired?.[date] ?? template?.requiredCoverage ?? SLOTS.map(() => 0)
  const actual = schedule.coverageActual[date] ?? SLOTS.map(() => 0)
  const [showOff, setShowOff] = useState(false)

  // Only show slots that have >0 required OR >0 actual coverage
  const visibleSlotIndices = SLOTS.map((_, i) => i).filter(
    (i) => required[i] > 0 || actual[i] > 0,
  )

  // Work-week (Thu→Wed) the current day belongs to. Used to compute the
  // per-dispatcher hours pill and days-off pill shown next to the name.
  const weekLabel = schedule.dates.find((d) => d.date === date)?.weekLabel ?? ''
  const weekDateSet = new Set(
    schedule.dates.filter((d) => d.weekLabel === weekLabel).map((d) => d.date),
  )

  const allRows = schedule.dispatcherSchedules.map((ds) => {
    const entry = ds.days.find((d) => d.date === date)
    return { ds, entry, isOff: !entry || entry.isOff }
  })
  const visibleRows = allRows.filter(({ ds, isOff }) => {
    if (dispatcherIdFilter) return dispatcherIdFilter.has(ds.dispatcher.id)
    return showOff || !isOff
  })
  const hiddenOffCount = dispatcherIdFilter ? 0 : allRows.filter((r) => r.isOff).length

  // Ref for the table so the NowLine can measure column positions via DOM.
  const tableRef = useRef<HTMLTableElement | null>(null)

  // Slots where actual coverage is short of the target — used to tint the
  // column header + body cells red so ops can scan a day and spot
  // understaffed slots. Any under-coverage qualifies (not just patterns
  // outside the 15% tolerance band) — per user, missing one body is
  // already a problem worth flagging in red.
  const shortSlots = new Set<number>()
  for (const si of visibleSlotIndices) {
    if (actual[si] < required[si]) shortSlots.add(si)
  }

  return (
    // `position: relative` so the NowLine (absolutely positioned) anchors
    // to this wrapper's coordinate system instead of the page.
    // `overflow-x-auto` lets the table scroll horizontally on narrow
    // viewports — the 20-slot grid + sticky name/hrs columns is wider
    // than the page on tablets / phones, especially with the admin-only
    // Hrs column visible.
    <div className="relative overflow-x-auto">
      {hiddenOffCount > 0 && (
        <div className="flex items-center justify-end px-4 py-1.5 text-[11px] text-slate-400">
          <button
            type="button"
            onClick={() => setShowOff((v) => !v)}
            className="hover:text-blue-600"
          >
            {showOff ? `hide ${hiddenOffCount} off` : `show ${hiddenOffCount} off`}
          </button>
        </div>
      )}
      <table ref={tableRef} className="min-w-full border-separate border-spacing-0 text-xs">
        {/* Slot header */}
        <thead>
          <tr>
            <th className="sticky left-0 z-10 min-w-[130px] bg-slate-800 px-3 py-2 text-left font-semibold text-white">
              {dayLabel}
            </th>
            {visibleSlotIndices.map((si) => (
              <th
                key={si}
                data-slot={si}
                className={clsx(
                  'min-w-[54px] px-1 py-2 text-center font-medium whitespace-nowrap',
                  shortSlots.has(si)
                    ? 'bg-red-900 text-red-200'
                    : 'bg-slate-800 text-slate-300',
                )}
                title={`${SLOTS[si].label} (${SLOTS[si].hours}h)${shortSlots.has(si) ? ` — short by ${required[si] - actual[si]}` : ''}`}
              >
                <div className="text-[10px]">{shortHour(SLOTS[si].label)}</div>
                <div className={clsx('text-[9px]', shortSlots.has(si) ? 'text-red-300' : 'text-slate-500')}>
                  {SLOTS[si].hours}h
                </div>
              </th>
            ))}
            {isAdmin && (
              <th className="sticky right-0 z-10 min-w-[60px] bg-slate-800 px-3 py-2 text-right font-semibold text-slate-300">
                Hrs
              </th>
            )}
          </tr>
        </thead>

        <tbody>
          {visibleRows.length === 0 && dispatcherIdFilter && (
            <tr><td colSpan={visibleSlotIndices.length + (isAdmin ? 2 : 1)} className="px-3 py-3 text-center text-xs text-slate-400">
              No dispatchers match the search on this day.
            </td></tr>
          )}
          {visibleRows.map(({ ds, entry, isOff }, rowIdx) => {
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
                    {isAdmin && (() => {
                      const weekH = ds.weeklyHours[weekLabel] ?? 0
                      const offDays = ds.days.filter((d) => weekDateSet.has(d.date) && d.isOff).length
                      // Hours pill — colors signal load against the 45 h cap.
                      const hoursClass =
                        weekH > 45 ? 'bg-red-100 text-red-700 ring-1 ring-red-400' :
                        weekH >= 36 ? 'bg-emerald-100 text-emerald-700' :
                        weekH > 0 ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-400'
                      // Days-off pill — 2 d off = target, 1 d = shortfall,
                      // 3+ d = under-utilized (usually time-off / blocked).
                      const offClass =
                        offDays === 0 ? 'bg-red-100 text-red-700' :
                        offDays === 1 ? 'bg-amber-100 text-amber-700' :
                        offDays === 2 ? 'bg-emerald-100 text-emerald-700' :
                        'bg-slate-100 text-slate-500'
                      return (
                        <>
                          <HoverHint label={`Week of ${weekLabel}: ${weekH.toFixed(1)}h / 45h cap`}>
                            <span className={clsx('rounded px-1.5 text-[9px] font-bold tabular-nums', hoursClass)}>
                              {weekH.toFixed(0)}h
                            </span>
                          </HoverHint>
                          <HoverHint label={`${offDays} day${offDays === 1 ? '' : 's'} off this work-week (Thu→Wed)`}>
                            <span className={clsx('rounded px-1.5 text-[9px] font-bold tabular-nums', offClass)}>
                              {offDays}d off
                            </span>
                          </HoverHint>
                        </>
                      )
                    })()}
                    {isOff && (() => {
                      const r = absenceReasons[ds.dispatcher.id]?.[date]
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
                    {/* Break-shape warning — surfaced on the name row when
                        a working dispatcher's day has too little break for
                        their hours. Caught at view time so it also fires
                        for manual slot edits, not just generated shifts. */}
                    {!isOff && entry && (() => {
                      const h = entry.totalHours ?? 0
                      const brk = patternMaxBreakHours(entry.slots, SLOTS)
                      let problem: string | null = null
                      if (h >= 8 && brk < LONG_SHIFT_BREAK_MIN) {
                        problem = `${h}h shift needs ≥${LONG_SHIFT_BREAK_MIN}h break — has ${brk}h`
                      } else if (h >= 7 && h < 8 && brk < MED_SHIFT_BREAK_MIN) {
                        problem = `${h}h shift needs ≥${MED_SHIFT_BREAK_MIN}h break — has ${brk}h`
                      }
                      if (!problem) return null
                      return (
                        <HoverHint label={problem}>
                          <span className="rounded bg-red-100 px-1.5 text-[9px] font-bold uppercase tracking-wide text-red-700 ring-1 ring-red-400 animate-pulse">
                            ⚠ break
                          </span>
                        </HoverHint>
                      )
                    })()}
                  </div>
                </td>

                {/* Slot cells */}
                {visibleSlotIndices.map((si) => {
                  const working = entry?.slots[si] ?? false
                  const dateBlocked = timeOff[ds.dispatcher.id]?.[date]?.[si] ?? false
                  const recurBlocked = ds.dispatcher.recurringBlocks?.[dayOfWeek]?.[si] ?? false
                  const blocked = dateBlocked || recurBlocked
                  return (
                    <td
                      key={si}
                      className={clsx(
                        'group px-0.5 py-1',
                        isAdmin && 'cursor-pointer',
                        // Red column tint when this slot is short. Matches the
                        // header tint above so the full column reads as a
                        // shortfall at a glance.
                        shortSlots.has(si) && 'bg-red-50/70',
                      )}
                      onClick={isAdmin ? () => toggleDispatcherSlot(ds.dispatcher.id, date, si) : undefined}
                      title={
                        !isAdmin
                          ? working ? `Working — ${SLOTS[si].label}` : ''
                          : blocked
                          ? `Blocked off — ${SLOTS[si].label} (click to override)`
                          : working
                            ? `Remove ${SLOTS[si].label}`
                            : `Add ${SLOTS[si].label}`
                      }
                    >
                      {working ? (
                        <div
                          className={clsx(
                            'mx-auto h-5 w-full max-w-[52px] rounded text-center text-[9px] font-bold leading-5 text-white transition group-hover:ring-2 group-hover:ring-red-400 group-hover:ring-offset-1',
                            blocked && 'ring-2 ring-red-500 ring-offset-1',
                          )}
                          style={{ backgroundColor: ds.dispatcher.color }}
                        />
                      ) : blocked ? (
                        <div
                          className="mx-auto h-5 w-full max-w-[52px] rounded border border-red-300 bg-[repeating-linear-gradient(45deg,_#fee2e2_0,_#fee2e2_3px,_transparent_3px,_transparent_6px)] transition group-hover:opacity-80"
                          aria-label="blocked"
                        />
                      ) : (
                        <div
                          className="mx-auto h-5 w-full max-w-[52px] rounded border border-dashed border-transparent opacity-0 transition group-hover:opacity-60"
                          style={{ borderColor: ds.dispatcher.color }}
                        />
                      )}
                    </td>
                  )
                })}

                {/* Daily hours — admin-only column */}
                {isAdmin && (
                  <td className="sticky right-0 bg-inherit px-3 py-1.5 text-right">
                    {isOff ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className="font-semibold text-slate-700">
                        {entry?.totalHours?.toFixed(1)}h
                      </span>
                    )}
                  </td>
                )}
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
              // Any under-coverage (including the 1-body "mild" tier)
              // gets the red treatment per user — missing one body is
              // worth flagging, not just "off by 2+".
              const isUnder = shortSlots.has(si)
              return (
                <td
                  key={si}
                  className={clsx(
                    'px-0.5 py-1 text-center',
                    isUnder && 'bg-red-50/70',
                  )}
                >
                  <div
                    className={clsx(
                      'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                      isUnder ? 'bg-red-100 text-red-700 ring-1 ring-red-400'
                      : status === 'ok'    ? 'bg-emerald-100 text-emerald-700'
                      : status === 'mild'  ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-400', // status === 'over'
                    )}
                    title={`Actual: ${a} | Required: ${r}`}
                  >
                    {a}
                    {r > 0 && <span className="ml-0.5 opacity-50">/{r}</span>}
                  </div>
                </td>
              )
            })}
            {isAdmin && (
              <td className="sticky right-0 bg-slate-100 px-3 py-1.5 text-right text-[10px] text-slate-500">
                {actual.reduce((s, a, i) => s + a * SLOTS[i].hours, 0).toFixed(1)}h
              </td>
            )}
          </tr>
        </tfoot>
      </table>
      {/* Current-time indicator — only rendered when the parent decided
          today falls within ops hours and this is today's column. */}
      {nowSlotIdx !== undefined && nowMinuteFrac !== undefined && nowLabel && (
        <NowLine
          tableRef={tableRef}
          slotIdx={nowSlotIdx}
          minuteFrac={nowMinuteFrac}
          label={nowLabel}
        />
      )}
    </div>
  )
}
