import clsx from 'clsx'
import { useRef, useState, useMemo } from 'react'

import { HoverHint } from '@/components/HoverHint'
import { useIsAdmin } from '@/store/adminStore'
import { reasonColors, reasonLabel, reasonShort } from '@/utils/absence'

import { DRIVER_SLOTS, LEGAL_DAILY_MAX_HOURS, LEGAL_PT_WEEKLY_MAX_HOURS, LEGAL_WEEKLY_MAX_HOURS, SHOPPER_COVERAGE, effectiveCoverage } from '../coverageTemplate'
import { MAX_BLOCKS_PER_DAY, MAX_BREAK_HOURS, MIN_BLOCK_HOURS, coverageStatus, violatesShape, workBlocks } from '../scheduler'
import { useDriverStore } from '../store'
import type { DriverSchedule, GeneratedDriverSchedule } from '../types'
import { NowLine } from '@/components/NowLine'
import { displayName, shortHour } from '../utils'

// Work-week boundary: Thu (dow=4) starts a new week. Returns the
// Thursday on/before the given date as "YYYY-MM-DD" so it can key a Map.
function workWeekKey(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const dow = d.getDay()
  // (dow + 3) % 7 = days since the most recent Thursday.
  d.setDate(d.getDate() - ((dow + 3) % 7))
  return d.toISOString().slice(0, 10)
}

function weeklyHoursForDriver(ds: DriverSchedule, dateInWeek: string): number {
  const wk = workWeekKey(dateInWeek)
  let total = 0
  for (const day of ds.days) {
    if (day.isOff) continue
    if (workWeekKey(day.date) === wk) total += day.totalHours ?? 0
  }
  return total
}

/** Count this driver's OFF days within the same work-week as `dateInWeek`.
 *  Only counts days that fall inside the schedule period — partial weeks at
 *  either end of the period naturally have fewer total days. */
function offDaysForDriver(ds: DriverSchedule, dateInWeek: string): number {
  const wk = workWeekKey(dateInWeek)
  let off = 0
  for (const day of ds.days) {
    if (workWeekKey(day.date) === wk && day.isOff) off++
  }
  return off
}

interface Props {
  schedule: GeneratedDriverSchedule
  date: string
  dayLabel: string
  dayOfWeek: number
  /** When set, only drivers with these ids appear (overrides showOff toggle). */
  driverIdFilter?: Set<string> | null
  /** When set, draws a vertical "current time" line at this slot+frac.
   *  Only the parent (DriverScheduleGrid) decides if today is in range
   *  and within ops hours; this component just renders the line when
   *  the props are present. */
  nowSlotIdx?: number
  nowMinuteFrac?: number
  nowLabel?: string
  /** When set, the driver name in each row becomes a clickable button
   *  that opens the parent's "Manage driver" modal. Parent decides what
   *  to do (typically: set editingAvailability state to the id). */
  onEditDriver?: (driverId: string) => void
  /** When set, the "Coverage" header label becomes a clickable button
   *  that opens the parent's coverage-targets modal. */
  onEditCoverage?: () => void
}

export function DriverDayGrid({ schedule, date, dayLabel, dayOfWeek, driverIdFilter, nowSlotIdx, nowMinuteFrac, nowLabel, onEditDriver, onEditCoverage }: Props) {
  const toggleDriverSlot = useDriverStore((s) => s.toggleDriverSlot)
  const isAdmin = useIsAdmin()
  const timeOff = useDriverStore((s) => s.timeOff)
  const absenceReasons = useDriverStore((s) => s.absenceReasons)
  const fullTimeCap = useDriverStore((s) => s.fullTimeCap)
  const partTimeCap = useDriverStore((s) => s.partTimeCap)
  // Pull coverage scale + overrides so `required` reflects what ops
  // actually configured. Reading raw `template.requiredCoverage` would
  // ignore both the per-day overrides AND the scale knob — leading to
  // a confusing UX where the per-day pill said "no gaps" (because it
  // used scaled targets) while the expanded grid still tinted red
  // cells against the unscaled baseline.
  const coverageScale = useDriverStore((s) => s.coverageScale)
  const coverageOverrides = useDriverStore((s) => s.coverageOverrides)
  // Ref to the inner <table> so the NowLine can measure column positions
  // via DOM rather than guessing from CSS. The table sits inside the
  // `position: relative` wrapper so the line's `left` is anchored
  // correctly.
  const tableRef = useRef<HTMLTableElement | null>(null)
  const required = useMemo(
    () => effectiveCoverage(dayOfWeek, coverageScale, coverageOverrides),
    [dayOfWeek, coverageScale, coverageOverrides],
  )
  const actual = schedule.coverageActual[date] ?? DRIVER_SLOTS.map(() => 0)
  const [showOff, setShowOff] = useState(false)

  // Per-slot shopper count — shoppers don't count toward driver
  // coverage but ops still want to see who's on for grocery work.
  const shopperCov = DRIVER_SLOTS.map(() => 0)
  for (const ds of schedule.driverSchedules) {
    if (!ds.driver.isShopper) continue
    const e = ds.days.find((d) => d.date === date)
    if (!e || e.isOff) continue
    e.slots.forEach((on, i) => { if (on) shopperCov[i]++ })
  }
  // Shopper coverage TARGETS from 5-week historical (excluding Sun).
  const shopperRequired = SHOPPER_COVERAGE[dayOfWeek] ?? DRIVER_SLOTS.map(() => 0)
  const hasShoppers = shopperCov.some((v) => v > 0) || shopperRequired.some((v) => v > 0)

  const visibleSlotIndices = DRIVER_SLOTS.map((_, i) => i).filter(
    (i) => required[i] > 0 || actual[i] > 0 || shopperCov[i] > 0 || shopperRequired[i] > 0,
  )

  // Slots with REAL coverage shortfall — used to tint the entire column
  // red so ops can scan a day grid and spot where to add hours. Excludes
  // low-priority slots (3-4 PM) where under-target is acceptable per
  // ops policy — those get the gentler short-low-priority status in the
  // coverage pills but no full-column red tint.
  const shortSlots = new Set<number>()
  for (const si of visibleSlotIndices) {
    const status = coverageStatus(actual[si], required[si], dayOfWeek, si)
    if (status === 'short') shortSlots.add(si)
  }

  // Apply row filters: external search filter takes precedence over the local OFF toggle.
  // Sort: non-shoppers first, then shoppers (so they cluster at the bottom of the day grid
  // for easy verification of shopper coverage — matches the XLSX export grouping).
  const allRows = useMemo(() => {
    const rows = schedule.driverSchedules.map((ds) => {
      const entry = ds.days.find((d) => d.date === date)
      return { ds, entry, isOff: !entry || entry.isOff }
    })
    rows.sort((a, b) => {
      const aShop = a.ds.driver.isShopper ? 1 : 0
      const bShop = b.ds.driver.isShopper ? 1 : 0
      return aShop - bShop
    })
    return rows
  }, [schedule.driverSchedules, date])
  const visibleRows = allRows.filter(({ ds, isOff }) => {
    if (driverIdFilter) return driverIdFilter.has(ds.driver.id)
    return showOff || !isOff
  })
  const hiddenOffCount = driverIdFilter ? 0 : allRows.filter((r) => r.isOff).length

  // Index of first shopper among visible rows — we draw a divider above it.
  const firstShopperIdx = visibleRows.findIndex((r) => r.ds.driver.isShopper)

  return (
    // No overflow-x-auto here on purpose: setting overflow-x to auto
    // silently coerces overflow-y to auto per CSS spec, which makes this
    // div a vertical scroll container and breaks `position: sticky` on
    // the thead row (the sticky has no viewport to scroll against).
    //
    // Page-level horizontal scrolling kicks in on narrow viewports if the
    // table is wider than the page — fine for the typical ~15-column
    // schedule on desktop browsers.
    //
    // `position: relative` so the NowLine (rendered as an absolutely-
    // positioned child) anchors to this wrapper's coordinate system,
    // not the document body.
    <div className="relative">
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
      <table ref={tableRef} className="min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          {/*
            Each <th> in the header row sticks to the top of the viewport
            while the user scrolls down through the driver rows, so the
            hour labels (8a, 9a, ...) stay visible no matter how far down
            you scroll within a day. Once the entire day-table scrolls
            past, the header scrolls away with it and the next day's
            header takes over.

            Z-index layering:
              z-30 — corner cells that stick BOTH top AND left/right
                     (must sit above both axes when scrolling)
              z-20 — top-row header cells (sticky top only)
              z-10 — leftmost / rightmost body cells (sticky left/right only)
          */}
          <tr>
            <th className="sticky left-0 top-0 z-30 min-w-[130px] bg-slate-800 px-3 py-2 text-left font-semibold text-white">
              {dayLabel}
            </th>
            {visibleSlotIndices.map((si) => (
              <th
                key={si}
                data-slot={si}
                className={clsx(
                  'sticky top-0 z-20 min-w-[48px] px-1 py-2 text-center font-medium whitespace-nowrap',
                  // Column header: red highlight when this slot is short
                  // (driver coverage below target).
                  shortSlots.has(si)
                    ? 'bg-red-900 text-red-200'
                    : 'bg-slate-800 text-slate-300',
                )}
                title={`${DRIVER_SLOTS[si].label}${shortSlots.has(si) ? ` — short by ${required[si] - actual[si]}` : ''}`}
              >
                <div className="text-[10px]">{shortHour(DRIVER_SLOTS[si].label)}</div>
                <div className={clsx('text-[9px]', shortSlots.has(si) ? 'text-red-300' : 'text-slate-500')}>1h</div>
              </th>
            ))}
            {isAdmin && (
              <th className="sticky right-0 top-0 z-30 min-w-[60px] bg-slate-800 px-3 py-2 text-right font-semibold text-slate-300">Hrs</th>
            )}
          </tr>
          {/*
            Second sticky row: per-slot coverage pills. Sticks at `top-11`
            (44px) so it sits directly under the hour header row when
            scrolling. Same data as the footer Coverage row — duplicated
            here so ops can read coverage status at any scroll depth
            without flipping back to the bottom of the day. Footer row
            stays as the canonical "end of day" reference.
          */}
          <tr>
            <th className="sticky left-0 top-11 z-30 min-w-[130px] bg-slate-100 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {onEditCoverage ? (
                <button
                  type="button"
                  onClick={onEditCoverage}
                  title="Click to edit per-DOW coverage targets"
                  className="underline-offset-2 hover:underline focus:underline focus:outline-none"
                >
                  Coverage
                </button>
              ) : (
                'Coverage'
              )}
            </th>
            {visibleSlotIndices.map((si) => {
              const a = actual[si]
              const r = required[si]
              const status = coverageStatus(a, r, dayOfWeek, si)
              return (
                <th key={si} className={clsx(
                  'sticky top-11 z-20 px-0.5 py-1 bg-slate-100 text-center',
                  shortSlots.has(si) && 'bg-red-50/70',
                )}>
                  <div
                    className={clsx(
                      'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                      status === 'ok'    && 'bg-emerald-100 text-emerald-700',
                      status === 'mild'  && 'bg-amber-100 text-amber-700',
                      status === 'short' && 'bg-red-100 text-red-700 ring-1 ring-red-400',
                      status === 'short-low-priority' && 'bg-amber-50 text-amber-600',
                      status === 'over'  && 'bg-slate-200 text-slate-500',
                    )}
                    title={`Actual: ${a} | Required: ${r}${status === 'short-low-priority' ? ' (low-priority slot — under-coverage acceptable)' : ''}`}
                  >
                    {a}
                    {r > 0 && <span className="ml-0.5 opacity-50">/{r}</span>}
                  </div>
                </th>
              )
            })}
            {isAdmin && (
              <th className="sticky right-0 top-11 z-30 min-w-[60px] bg-slate-100 px-3 py-1.5 text-right text-[10px] text-slate-500">
                {actual.reduce((s, a) => s + a, 0)}h
              </th>
            )}
          </tr>
          {/* Sticky shopper coverage row — only when this day has any
              shopper activity. Same alignment under the driver coverage
              row. Sticks below the previous row at top-[68px] (44+24). */}
          {hasShoppers && (
            <tr>
              <th className="sticky left-0 top-[68px] z-30 min-w-[130px] bg-purple-50 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                Shoppers
              </th>
              {visibleSlotIndices.map((si) => {
                const sa = shopperCov[si]
                const sr = shopperRequired[si]
                const tone =
                  sr === 0 && sa === 0 ? 'bg-slate-50 text-slate-300' :
                  sa >= sr             ? 'bg-purple-100 text-purple-700' :
                                         'bg-purple-50 text-purple-500 ring-1 ring-purple-300'
                return (
                  <th key={si} className="sticky top-[68px] z-20 bg-purple-50 px-0.5 py-1 text-center font-normal">
                    <div
                      className={clsx(
                        'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                        tone,
                      )}
                      title={`Shoppers: ${sa} actual / ${sr} target`}
                    >
                      {sa === 0 && sr === 0 ? '·' : sa}
                      {sr > 0 && <span className="ml-0.5 opacity-50">/{sr}</span>}
                    </div>
                  </th>
                )
              })}
              {isAdmin && (
                <th className="sticky right-0 top-[68px] z-30 min-w-[60px] bg-purple-50 px-3 py-1.5 text-right text-[10px] font-semibold text-purple-600">
                  {shopperCov.reduce((s, a) => s + a, 0)}
                  {shopperRequired.some(v => v > 0) && (
                    <span className="opacity-50">/{shopperRequired.reduce((s, a) => s + a, 0)}</span>
                  )}h
                </th>
              )}
            </tr>
          )}
        </thead>

        <tbody>
          {visibleRows.length === 0 && driverIdFilter && (
            <tr><td colSpan={visibleSlotIndices.length + 2} className="px-3 py-3 text-center text-xs text-slate-400">
              No drivers match the search on this day.
            </td></tr>
          )}
          {visibleRows.map(({ ds, entry, isOff }, rowIdx) => {
            const weekH = weeklyHoursForDriver(ds, date)
            const offDays = offDaysForDriver(ds, date)
            const cap = ds.driver.employmentType === 'full' ? fullTimeCap : partTimeCap
            const pctOfCap = cap > 0 ? weekH / cap : 0
            const isFirstShopper = rowIdx === firstShopperIdx
            const isShopperRow = ds.driver.isShopper
            return (
              <tr
                key={ds.driver.id}
                className={clsx(
                  'border-t border-slate-100',
                  // Bold purple separator above the first shopper so the
                  // shopper block is obviously a different roster section.
                  isFirstShopper && 'border-t-4 border-t-purple-500',
                  // Shopper rows: SATURATED purple so they're impossible
                  // to confuse with drivers. Prior tint (purple-50/60) was
                  // too washed-out and ops kept mistaking shoppers for
                  // regular drivers in the grid.
                  isShopperRow
                    ? (rowIdx % 2 === 0 ? 'bg-purple-200' : 'bg-purple-300')
                    : (rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'),
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
                    {onEditDriver ? (
                      <button
                        type="button"
                        onClick={() => onEditDriver(ds.driver.id)}
                        title={`${ds.driver.name} — click to edit driver info, blocks, or time-off`}
                        className={clsx(
                          'font-medium underline-offset-2 hover:underline focus:underline focus:outline-none',
                          isShopperRow
                            ? (isOff ? 'text-purple-500' : 'text-purple-900')
                            : (isOff ? 'text-slate-400' : 'text-slate-800'),
                        )}
                      >
                        {displayName(ds.driver.name)}
                      </button>
                    ) : (
                      <span
                        className={clsx(
                          'font-medium',
                          isShopperRow
                            ? (isOff ? 'text-purple-500' : 'text-purple-900')
                            : (isOff ? 'text-slate-400' : 'text-slate-800'),
                        )}
                        title={ds.driver.name}
                      >
                        {displayName(ds.driver.name)}
                      </span>
                    )}
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
                    {ds.driver.isShopper && (
                      <span className="rounded bg-purple-700 px-1.5 text-[9px] font-bold text-white shadow-sm ring-1 ring-purple-800">
                        SHP
                      </span>
                    )}
                    {/* Weekly hours pill — color signals load:
                          purple = LEGAL OVERTIME (>45h/wk)
                          red    = over user's soft cap (when cap < 45)
                          amber  = close to cap (≥92%)
                          slate  = normal
                        Admin-only. */}
                    {isAdmin && (() => {
                      // Per-type legal weekly max: FT 45h, PT 30h.
                      const legalMax = ds.driver.employmentType === 'full' ? LEGAL_WEEKLY_MAX_HOURS : LEGAL_PT_WEEKLY_MAX_HOURS
                      const isLegalOT = weekH > legalMax
                      const isOverCap = pctOfCap >= 1.0 && !isLegalOT
                      const tooltip = isLegalOT
                        ? `Week of ${workWeekKey(date)}: ${weekH.toFixed(1)}h — ${(weekH - legalMax).toFixed(1)}h WEEKLY OVERTIME (legal max ${legalMax}h for ${ds.driver.employmentType === 'full' ? 'FT' : 'PT'})`
                        : `Week of ${workWeekKey(date)}: ${weekH.toFixed(1)}h / ${cap}h cap`
                      return (
                        <HoverHint label={tooltip}>
                          <span className={clsx(
                            'rounded px-1.5 text-[9px] font-bold tabular-nums',
                            isLegalOT ? 'bg-purple-100 text-purple-700 ring-1 ring-purple-400' :
                            isOverCap ? 'bg-red-100 text-red-700' :
                            pctOfCap >= 0.92 ? 'bg-amber-100 text-amber-700' :
                            pctOfCap >= 0.5 ? 'bg-slate-100 text-slate-600' :
                            'bg-slate-50 text-slate-400',
                          )}>
                            {weekH.toFixed(0)}h{isLegalOT && ' OT'}
                          </span>
                        </HoverHint>
                      )
                    })()}
                    {/* Days-off pill for the current work-week. Admin-only —
                        rolls up to weekly utilization which is admin info. */}
                    {isAdmin && (
                      <HoverHint label={`${offDays} day${offDays === 1 ? '' : 's'} off this work-week (Thu→Wed)`}>
                        <span className={clsx(
                          'rounded px-1.5 text-[9px] font-bold tabular-nums',
                          offDays === 0 ? 'bg-amber-100 text-amber-700' :
                          offDays === 1 ? 'bg-slate-100 text-slate-600' :
                          'bg-blue-100 text-blue-700',
                        )}>
                          {offDays}d off
                        </span>
                      </HoverHint>
                    )}
                    {/* Daily overtime badge — shown when the day's shift exceeds 9h legal max */}
                    {!isOff && entry && (entry.totalHours ?? 0) > LEGAL_DAILY_MAX_HOURS && (
                      <HoverHint label={`Daily overtime: ${entry.totalHours?.toFixed(1)}h (${(entry.totalHours! - LEGAL_DAILY_MAX_HOURS).toFixed(1)}h over the 9h legal max)`}>
                        <span className="rounded bg-purple-100 px-1 text-[9px] font-bold uppercase tracking-wide text-purple-700 ring-1 ring-purple-400">
                          OT
                        </span>
                      </HoverHint>
                    )}
                    {/* Shape-violation badge — bright red, ring + pulse so
                        it can't be missed. Fires when a day's slot bitmap
                        breaks the shift-shape rules: any work block < 3h,
                        any break > 3h, or > 2 blocks (= more than 1
                        break). Generator phases never produce these, so
                        every badge in practice is the result of a manual
                        toggle. Tooltip explains which rule(s) failed. */}
                    {!isOff && entry && violatesShape(entry.slots) && (() => {
                      const blocks = workBlocks(entry.slots)
                      const reasons: string[] = []
                      if (blocks.length > MAX_BLOCKS_PER_DAY) {
                        reasons.push(`${blocks.length} work blocks (max ${MAX_BLOCKS_PER_DAY} per day — i.e. at most 1 break)`)
                      }
                      for (const [s, e] of blocks) {
                        const len = e - s + 1
                        if (len < MIN_BLOCK_HOURS) {
                          reasons.push(`block ${shortHour(DRIVER_SLOTS[s].label)}–${shortHour(DRIVER_SLOTS[e].label)} is ${len}h (min ${MIN_BLOCK_HOURS}h)`)
                        }
                      }
                      for (let i = 1; i < blocks.length; i++) {
                        const gap = blocks[i][0] - blocks[i - 1][1] - 1
                        if (gap > MAX_BREAK_HOURS) {
                          reasons.push(`break is ${gap}h (max ${MAX_BREAK_HOURS}h)`)
                        }
                      }
                      return (
                        <HoverHint label={`Shift shape violates ops rules: ${reasons.join('; ')}. Adjust the slots until every block is ≥${MIN_BLOCK_HOURS}h and every break is ≤${MAX_BREAK_HOURS}h.`}>
                          <span className="inline-flex animate-pulse items-center gap-0.5 rounded bg-red-600 px-1.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm ring-2 ring-red-300">
                            ! Shape
                          </span>
                        </HoverHint>
                      )
                    })()}
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
                      className={clsx(
                        'group px-0.5 py-1',
                        isAdmin && 'cursor-pointer',
                        // Red column tint when this slot is short on
                        // driver coverage — makes it obvious where to
                        // click to add hours. Skip on shopper rows to
                        // keep their purple band visually coherent.
                        shortSlots.has(si) && !isShopperRow && 'bg-red-50/70',
                      )}
                      onClick={isAdmin ? () => toggleDriverSlot(ds.driver.id, date, si) : undefined}
                      title={
                        !isAdmin
                          ? working ? `Working — ${DRIVER_SLOTS[si].label}` : ''
                          : blocked
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

                {isAdmin && (
                  <td className="sticky right-0 bg-inherit px-3 py-1.5 text-right">
                    {isOff ? (
                      <span className="text-slate-400">—</span>
                    ) : (() => {
                      const h = entry?.totalHours ?? 0
                      // Highlight the legal-cap boundary: at exactly 9h
                      // (legal daily max) → yellow pill so ops sees it's
                      // pushing the line. Over 9h → red pill = real
                      // overtime, needs payroll attention.
                      const tone =
                        h > LEGAL_DAILY_MAX_HOURS
                          ? 'bg-red-100 text-red-700 ring-1 ring-red-400'
                        : h === LEGAL_DAILY_MAX_HOURS
                          ? 'bg-amber-100 text-amber-700'
                        : 'text-slate-700'
                      return (
                        <span className={clsx('font-semibold tabular-nums rounded px-1.5', tone)}>
                          {h.toFixed(0)}h
                        </span>
                      )
                    })()}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>

        <tfoot>
          <tr className="border-t-2 border-slate-300">
            <td className="sticky left-0 bg-slate-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {onEditCoverage ? (
                <button
                  type="button"
                  onClick={onEditCoverage}
                  title="Click to edit per-DOW coverage targets"
                  className="underline-offset-2 hover:underline focus:underline focus:outline-none"
                >
                  Coverage
                </button>
              ) : (
                'Coverage'
              )}
            </td>
            {visibleSlotIndices.map((si) => {
              const a = actual[si]
              const r = required[si]
              const status = coverageStatus(a, r, dayOfWeek, si)
              return (
                <td key={si} className={clsx('px-0.5 py-1 text-center', shortSlots.has(si) && 'bg-red-50/70')}>
                  <div
                    className={clsx(
                      'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                      status === 'ok'    && 'bg-emerald-100 text-emerald-700',
                      status === 'mild'  && 'bg-amber-100 text-amber-700',
                      status === 'short' && 'bg-red-100 text-red-700 ring-1 ring-red-400',
                      status === 'short-low-priority' && 'bg-amber-50 text-amber-600',
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
            {isAdmin && (
              <td className="sticky right-0 bg-slate-100 px-3 py-1.5 text-right text-[10px] text-slate-500">
                {actual.reduce((s, a) => s + a, 0)}h
              </td>
            )}
          </tr>

          {/* Separate row for shoppers — they're a distinct operational
              pool (groceries) and don't count toward driver coverage,
              so ops needs a separate count to verify the day's shopper
              presence. Hidden when there are zero shopper hours on the day. */}
          {hasShoppers && (
            <tr className="border-t border-slate-200">
              <td className="sticky left-0 bg-purple-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-purple-600">
                Shoppers
              </td>
              {visibleSlotIndices.map((si) => {
                const sa = shopperCov[si]
                const sr = shopperRequired[si]
                // Color: purple-strong when at/above target, purple-light
                // when under target, slate-dim if neither demand nor staff.
                const tone =
                  sr === 0 && sa === 0 ? 'bg-slate-50 text-slate-300' :
                  sa >= sr             ? 'bg-purple-100 text-purple-700' :
                                         'bg-purple-50 text-purple-500 ring-1 ring-purple-300'
                return (
                  <td key={si} className="px-0.5 py-1 text-center">
                    <div
                      className={clsx(
                        'mx-auto inline-flex h-5 min-w-[28px] items-center justify-center rounded text-[10px] font-bold',
                        tone,
                      )}
                      title={`Shoppers: ${sa} actual / ${sr} target`}
                    >
                      {sa === 0 && sr === 0 ? '·' : sa}
                      {sr > 0 && <span className="ml-0.5 opacity-50">/{sr}</span>}
                    </div>
                  </td>
                )
              })}
              {isAdmin && (
              <td className="sticky right-0 bg-purple-50 px-3 py-1.5 text-right text-[10px] font-semibold text-purple-600">
                {shopperCov.reduce((s, a) => s + a, 0)}
                {shopperRequired.some(v => v > 0) && (
                  <span className="opacity-50">/{shopperRequired.reduce((s, a) => s + a, 0)}</span>
                )}h
              </td>
              )}
            </tr>
          )}
        </tfoot>
      </table>
      {/* Current-time indicator — only rendered when the parent
          decided today falls within ops hours and this is today's
          column. Anchors via tableRef, repositions itself when the
          minute label changes or the table resizes. */}
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
