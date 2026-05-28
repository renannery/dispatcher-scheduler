import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DAILY_DEMAND_BY_DOW,
  DRIVER_DAY_TEMPLATES,
  DRIVER_SLOTS,
  MAX_HOURS_PER_DAY,
} from './coverageTemplate'
import type {
  Driver,
  DriverDayEntry,
  DriverSchedule,
  DriverTimeOff,
  GeneratedDriverSchedule,
} from './types'

export const HEAVY_DAYS = new Set([5, 6, 0])

const NIGHT_SLOT_THRESHOLD = 13   // 9-10 PM or later = closing
const MORNING_SLOT_THRESHOLD = 2  // starts ≤ 10 AM = morning

function slotHours(slots: boolean[]): number {
  return slots.reduce((sum, on) => sum + (on ? 1 : 0), 0)
}

function firstActive(pattern: boolean[]): number {
  return pattern.findIndex((v) => v)
}

function lastActive(pattern: boolean[]): number {
  for (let i = pattern.length - 1; i >= 0; i--) if (pattern[i]) return i
  return -1
}

function weekLabel(date: Date): string {
  const dow = date.getDay()
  const thu = addDays(date, -((dow + 3) % 7))
  const wed = addDays(thu, 6)
  return `${format(thu, 'MMM d')} – ${format(wed, 'MMM d')}`
}

export function weekendOffDriverId(
  date: Date,
  scheduleStart: Date,
  drivers: Driver[],
  seed = 0,
): string | null {
  if (drivers.length < 2) return null
  const toThursday = (d: Date) => {
    const dow = d.getDay()
    return addDays(d, -((dow + 3) % 7))
  }
  const startThu = toThursday(scheduleStart)
  const dateThu = toThursday(date)
  const weeks = Math.round(differenceInDays(dateThu, startThu) / 7)
  // 1-week rotation so each schedule cycle visits a different driver every week.
  // (Previously 2-week blocks made the cycle 2× as long — for 57 drivers it
  // would take ~2 years to visit everyone.) Seed comes from the regenerate
  // counter so successive Regenerate clicks rotate to a different starting point.
  const fullTimers = drivers.filter((d) => d.employmentType === 'full')
  if (fullTimers.length === 0) return null
  return fullTimers[(weeks + seed) % fullTimers.length].id
}

interface ScheduleParams {
  drivers: Driver[]
  startDate: string
  endDate: string
  timeOff: DriverTimeOff
  fullTimeCap: number
  partTimeCap: number
  /**
   * Shuffles the driver-picking order so successive Regenerate clicks produce
   * different (still valid) distributions instead of an identical schedule.
   */
  seed?: number
  /**
   * Multiplier on the per-slot required-coverage targets in
   * DRIVER_DAY_TEMPLATES. Defaults to 1.0 (use the reference numbers as-is).
   * Bump this when the roster has grown beyond the reference 56-driver
   * baseline so the scheduler pulls in proportionally more bodies per slot.
   */
  coverageScale?: number
}

/**
 * Returns the work-week (Thu→Wed) day-of-week sequence starting from `dow`.
 * Used to compute today's share of remaining-week demand so a driver's
 * weekly capacity is spread across all 7 days instead of front-loaded into
 * Thu-Sat (which leaves Tue/Wed starved when full-timers hit their cap).
 */
function workWeekRemaining(dow: number): number[] {
  // Work week order: Thu(4), Fri(5), Sat(6), Sun(0), Mon(1), Tue(2), Wed(3)
  const order = [4, 5, 6, 0, 1, 2, 3]
  const idx = order.indexOf(dow)
  return order.slice(idx)
}

/** Union of per-date time-off bitmap and the driver's recurring-weekly
 *  bitmap for that date's day-of-week. Returns null if no blocks at all. */
function blockedBitmap(
  timeOff: DriverTimeOff,
  driver: Driver,
  date: string,
  dayOfWeek: number,
): boolean[] | null {
  const dateBm = timeOff[driver.id]?.[date]
  const recurBm = driver.recurringBlocks?.[dayOfWeek]
  const hasDate = !!dateBm && dateBm.length > 0
  const hasRecur = !!recurBm && recurBm.some(Boolean)
  if (!hasDate && !hasRecur) return null
  const n = Math.max(dateBm?.length ?? 0, recurBm?.length ?? 0)
  const out = new Array(n).fill(false)
  for (let i = 0; i < n; i++) out[i] = !!(dateBm?.[i] || recurBm?.[i])
  return out
}

export function generateDriverSchedule({
  drivers,
  startDate,
  endDate,
  timeOff,
  fullTimeCap,
  partTimeCap,
  seed = 0,
  coverageScale = 1,
}: ScheduleParams): GeneratedDriverSchedule {
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  const totalDays = differenceInDays(end, start) + 1
  const allDates = Array.from({ length: totalDays }, (_, i) => addDays(start, i))

  const weekHours: Record<string, Record<string, number>> = {}
  const lastSlotWorked: Record<string, Record<string, number>> = {}
  const scheduleMap: Record<string, DriverDayEntry[]> = {}
  drivers.forEach((d) => {
    weekHours[d.id] = {}
    lastSlotWorked[d.id] = {}
    scheduleMap[d.id] = []
  })
  const coverageActual: Record<string, number[]> = {}

  const capOf = (d: Driver) => (d.employmentType === 'full' ? fullTimeCap : partTimeCap)

  // Seed shifts the rotation starting point so each Regenerate yields a
  // different driver order — without it, the algorithm is deterministic and
  // Regenerate appears to do nothing.
  let dayIndex = seed
  for (const date of allDates) {
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const template = DRIVER_DAY_TEMPLATES[dow]
    const wLabel = weekLabel(date)
    const dayLabel = format(date, 'EEE, MMMM do')
    const yesterday = format(addDays(date, -1), 'yyyy-MM-dd')
    const required = template.requiredCoverage.map((v) => Math.round(v * coverageScale))

    // Today's share of the remaining work-week's total demand. A driver
    // with `remaining` hours left in the week should spend roughly
    // `remaining * todayShare` of them today; the rest is reserved for
    // the days after. Keeps Tue/Wed from being starved by Thu-Sat greed.
    const remainingDows = workWeekRemaining(dow)
    const remainingWeekDemand = remainingDows.reduce((s, d) => s + DAILY_DEMAND_BY_DOW[d], 0)
    const todayDemandShare = DAILY_DEMAND_BY_DOW[dow] / Math.max(1, remainingWeekDemand)

    const workedNightYesterday = (id: string) =>
      (lastSlotWorked[id][yesterday] ?? -1) >= NIGHT_SLOT_THRESHOLD

    const weekendOffId = HEAVY_DAYS.has(dow)
      ? weekendOffDriverId(date, start, drivers, seed)
      : null

    // Split into off / available
    const available: Driver[] = []
    const dayOff: Driver[] = []

    for (const d of drivers) {
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
      const onWeekendBreak = d.id === weekendOffId
      const atCap = (weekHours[d.id][wLabel] ?? 0) >= capOf(d) - 0.5  // leave no room for even 1h
      if (fullyBlocked || onWeekendBreak || atCap) {
        dayOff.push(d)
      } else {
        available.push(d)
      }
    }

    const allPatterns = template.shiftPatterns
      .map((raw) => raw.map((v) => v === 1))
      .filter((p) => slotHours(p) <= MAX_HOURS_PER_DAY)

    const actualCov = new Array(DRIVER_SLOTS.length).fill(0)
    const assigned = new Set<string>()

    // Iteratively pick the most-loaded slot still under-covered, then assign
    // a (driver, pattern) pair that covers it best.
    let safety = drivers.length * 2
    while (safety-- > 0) {
      // Find shortfalls
      const shortfall: number[] = []
      let totalShort = 0
      for (let s = 0; s < required.length; s++) {
        const need = Math.max(0, required[s] - actualCov[s])
        shortfall.push(need)
        totalShort += need
      }
      if (totalShort === 0) break

      // Eligible drivers: not yet assigned today, under cap, night-rest OK for morning shifts.
      // Rotate the base order by `dayIndex` so different drivers get "first pick"
      // on different days when their weekly hours are tied — prevents the
      // alphabetically-first driver from systematically losing hours.
      const offset = drivers.length > 0 ? dayIndex % drivers.length : 0
      const rotated = [...drivers.slice(offset), ...drivers.slice(0, offset)]
      const candidates = rotated.filter((d) => available.includes(d) && !assigned.has(d.id))
      if (candidates.length === 0) break

      // Sort by ascending weekly hours (load-balance), full-timers first when tied.
      // Stable sort preserves the rotated original order among truly-equal candidates.
      candidates.sort((a, b) => {
        const ah = weekHours[a.id][wLabel] ?? 0
        const bh = weekHours[b.id][wLabel] ?? 0
        if (ah !== bh) return ah - bh
        if (a.employmentType !== b.employmentType) {
          return a.employmentType === 'full' ? -1 : 1
        }
        return 0
      })

      // For each candidate (in priority order), find the pattern that
      // (a) fits their remaining cap, (b) respects night-rest, (c) doesn't
      // overlap a blocked slot, (d) covers the most current shortfalls,
      // (e) stays within today's per-driver demand-weighted share.
      let placed = false
      for (const d of candidates) {
        const remaining = capOf(d) - (weekHours[d.id][wLabel] ?? 0)
        if (remaining < 4) continue  // not enough room for the shortest 4h pattern

        // Per-day soft cap = today's demand-share of this driver's remaining
        // weekly capacity, with a 4h floor (the shortest pattern). Strict
        // share with no slack keeps enough budget reserved for the back end
        // of the work-week (Tue/Wed), which otherwise get starved.
        const dailyCap = Math.min(
          remaining,
          MAX_HOURS_PER_DAY,
          Math.max(4, Math.ceil(remaining * todayDemandShare)),
        )

        const blocks = blockedBitmap(timeOff, d, dateStr, dow)

        let bestPattern: boolean[] | null = null
        let bestScore = -1

        for (const p of allPatterns) {
          const h = slotHours(p)
          if (h > dailyCap) continue
          if (h > remaining) continue
          if (firstActive(p) <= MORNING_SLOT_THRESHOLD && workedNightYesterday(d.id)) continue
          if (blocks && p.some((on, i) => on && blocks[i])) continue  // pattern conflicts with blocked slot

          // Score: sum of shortfall slots this pattern fills
          let score = 0
          for (let s = 0; s < p.length; s++) {
            if (p[s] && shortfall[s] > 0) score += shortfall[s]
          }
          if (score > bestScore) {
            bestScore = score
            bestPattern = p
          }
        }

        if (bestPattern && bestScore > 0) {
          const h = slotHours(bestPattern)
          weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + h
          lastSlotWorked[d.id][dateStr] = lastActive(bestPattern)
          scheduleMap[d.id].push({
            date: dateStr, dayLabel, dayOfWeek: dow,
            slots: [...bestPattern], totalHours: h, isOff: false,
          })
          for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) actualCov[s]++
          assigned.add(d.id)
          placed = true
          break
        }
      }

      if (!placed) break
    }

    // Drivers not assigned today get the day off
    for (const d of [...available, ...dayOff]) {
      if (assigned.has(d.id)) continue
      scheduleMap[d.id].push({
        date: dateStr, dayLabel, dayOfWeek: dow,
        slots: new Array(DRIVER_SLOTS.length).fill(false),
        totalHours: 0, isOff: true,
      })
    }

    coverageActual[dateStr] = actualCov
    dayIndex++
  }

  const driverSchedules: DriverSchedule[] = drivers.map((d) => {
    const days = scheduleMap[d.id]
    const wh = weekHours[d.id]
    const totalHours = Object.values(wh).reduce((s, h) => s + h, 0)
    return { driver: d, days, weeklyHours: wh, totalHours }
  })

  const dates = allDates.map((d) => ({
    date: format(d, 'yyyy-MM-dd'),
    dayLabel: format(d, 'EEE, MMMM do'),
    weekLabel: weekLabel(d),
    dayOfWeek: d.getDay(),
  }))

  return {
    startDate, endDate, fullTimeCap, partTimeCap, seed,
    dates, driverSchedules, coverageActual,
  }
}

// ─── Coverage + hour color helpers (UI) ─────────────────────────────────────

export function coverageStatus(actual: number, required: number): 'ok' | 'over' | 'short' {
  if (actual >= required) return required === 0 ? 'over' : 'ok'
  return 'short'
}

export function hoursStatusColor(hours: number, cap: number): string {
  if (hours > cap) return 'text-red-600'
  if (hours >= cap * 0.9) return 'text-emerald-600'
  return 'text-amber-600'
}

export function hoursStatusBg(hours: number, cap: number): string {
  if (hours > cap) return 'bg-red-100 text-red-700 border-red-200'
  if (hours >= cap * 0.9) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  return 'bg-amber-100 text-amber-700 border-amber-200'
}
