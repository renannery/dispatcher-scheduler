import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DRIVER_DAY_TEMPLATES,
  DRIVER_SLOTS,
  LEGAL_DAILY_MAX_HOURS,
  MAX_HOURS_PER_DAY,
  effectiveCoverage,
} from './coverageTemplate'
import type {
  Driver,
  DriverDayEntry,
  DriverSchedule,
  DriverTimeOff,
  GeneratedDriverSchedule,
} from './types'

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
  /**
   * Per day-of-week override of the 15-slot required-coverage array.
   * When present for a given day, replaces the template baseline before
   * `coverageScale` is applied.
   */
  coverageOverrides?: Record<number, number[]>
  /**
   * Minimum / maximum hours per shift, applied as a hard filter on the
   * pattern pool. Defaults: 4h min, 9h max. Editable on the Period step
   * so ops can enforce policies like "no 4h shifts" or "allow 10h overtime".
   */
  minHoursPerDay?: number
  maxHoursPerDay?: number
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
  coverageOverrides = {},
  minHoursPerDay = 4,
  maxHoursPerDay = MAX_HOURS_PER_DAY,
}: ScheduleParams): GeneratedDriverSchedule {
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  const totalDays = differenceInDays(end, start) + 1
  const allDates = Array.from({ length: totalDays }, (_, i) => addDays(start, i))

  const weekHours: Record<string, Record<string, number>> = {}
  const lastSlotWorked: Record<string, Record<string, number>> = {}
  const scheduleMap: Record<string, DriverDayEntry[]> = {}
  // Tracks per (driver, week) whether the driver has already worked a
  // shift at the user-set `maxHoursPerDay` length. The overflow shift
  // (`maxHoursPerDay + 1`, e.g. 9h when max=8) is only allowed for
  // drivers who already have a max-length shift this week — so the
  // 9h shift is an "extension" of an already-full day, never the
  // first long shift of someone's week.
  const hasMaxShiftThisWeek: Record<string, Record<string, boolean>> = {}
  drivers.forEach((d) => {
    weekHours[d.id] = {}
    lastSlotWorked[d.id] = {}
    scheduleMap[d.id] = []
    hasMaxShiftThisWeek[d.id] = {}
  })
  const coverageActual: Record<string, number[]> = {}

  const capOf = (d: Driver) => (d.employmentType === 'full' ? fullTimeCap : partTimeCap)

  // Per-driver per-week day count. Used to enforce the "1 day off" rule —
  // a driver who's already worked 6 days this work-week is skipped as a
  // candidate so they take the 7th day off. Cap is per work-week (Thu→Wed).
  const daysWorked: Record<string, Record<string, number>> = {}
  drivers.forEach((d) => { daysWorked[d.id] = {} })
  const MAX_DAYS_PER_WEEK = 6

  // Pre-assigned off day per driver per work-week. Without this, the greedy
  // pass burns drivers' caps on heavy days (Thu-Sat) and the 6-day rule
  // forces Wed to be the off day for almost everyone → Wed near-empty.
  //
  // Off days are weighted by demand: slow days get MORE drivers taking that
  // day off (so they're staffed lighter, matching demand), heavy days get
  // FEWER (so they're staffed heavier). The weighting reads from the
  // effective coverage targets — if you edit a day's targets in the grid,
  // off-day distribution adjusts automatically.
  const WORK_WEEK_DOWS = [4, 5, 6, 0, 1, 2, 3]  // Thu, Fri, Sat, Sun, Mon, Tue, Wed
  const driverIndex = new Map(drivers.map((d, i) => [d.id, i]))
  const weekIndexByLabel = new Map<string, number>()
  allDates.forEach((date) => {
    const lbl = weekLabel(date)
    if (!weekIndexByLabel.has(lbl)) weekIndexByLabel.set(lbl, weekIndexByLabel.size)
  })
  // Build a weighted off-day pool. Each DOW appears `1 + max(0, avg - this_day)/10`
  // times. Days with above-average demand get base weight 1; days below average
  // get extra entries proportional to how slow they are.
  const dailyDemands = WORK_WEEK_DOWS.map((dow) =>
    effectiveCoverage(dow, coverageScale, coverageOverrides).reduce((a, b) => a + b, 0),
  )
  const avgDailyDemand = dailyDemands.reduce((a, b) => a + b, 0) / dailyDemands.length
  const offDayPool: number[] = []
  WORK_WEEK_DOWS.forEach((dow, i) => {
    const extra = Math.max(0, Math.round((avgDailyDemand - dailyDemands[i]) / 10))
    for (let j = 0; j < 1 + extra; j++) offDayPool.push(dow)
  })
  const designatedOffDow = (driverId: string, wLabel: string): number => {
    const di = driverIndex.get(driverId) ?? 0
    const wi = weekIndexByLabel.get(wLabel) ?? 0
    return offDayPool[(di + wi + seed) % offDayPool.length]
  }

  // Hard over-cap: a slot is never staffed beyond its tolerance band
  // (target + coverageTolerance(target)). The band is 15% per slot, so
  // small targets get tight ceilings (target 10 → max 12) and large
  // targets get looser ones (target 56 → max 64).

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
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)

    // Remaining work-week days from today (Thu→Wed order). Used below to
    // detect the last work-week day (Wed) so we can relax `minHoursPerDay`
    // and let drivers spend their leftover weekly cap on a short fill-in.
    const remainingDows = workWeekRemaining(dow)

    const workedNightYesterday = (id: string) =>
      (lastSlotWorked[id][yesterday] ?? -1) >= NIGHT_SLOT_THRESHOLD

    // Relax `minHoursPerDay` on the LAST day of the work-week (Wed) so
    // drivers with leftover weekly cap (typically 4h) can still take a
    // fill-in shift. Without this, setting min=5 silently starves Wed.
    // The strict min still applies Thu-Tue.
    const isLastWorkWeekDay = remainingDows.length === 1
    const effectiveMin = isLastWorkWeekDay ? Math.min(minHoursPerDay, 4) : minHoursPerDay

    // Split into off / available
    const available: Driver[] = []
    const dayOff: Driver[] = []

    for (const d of drivers) {
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
      const atCap = (weekHours[d.id][wLabel] ?? 0) >= capOf(d) - 0.5  // leave no room for even 1h
      if (fullyBlocked || atCap) {
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
      // (Loop also exits below when no candidate can be placed with score > 0.
      // We no longer break on totalShort === 0 — instead, drivers continue to
      // fill SPARE capacity slots within the +3 tolerance band, so a roster
      // with scaled-down demand still uses up its weekly cap.)

      // Per-slot priority boost captures BOTH kinds of starvation:
      //   absolute (× 5):  high-demand slot that's short by many bodies
      //   relative (× 50): low-demand slot that's mostly empty
      // The "starved" multiplier tiers — each threshold halves the prior:
      //   ratio ≥ 0.8 → ×5 (severely empty)
      //   ratio ≥ 0.5 → ×3 (half empty)
      //   ratio ≥ 0.25 → ×2 (notably short)
      // The 0.25 tier was added because real roster data showed 9-10 AM
      // routinely at 20-30% short (e.g. 6/10) — below the old 0.5
      // trigger — yet losing pattern selection to over-covered PM
      // slots. The new tier nudges drivers earlier without trampling
      // PM peak coverage entirely.
      const slotPriority: number[] = []
      for (let s = 0; s < required.length; s++) {
        if (shortfall[s] > 0 && required[s] > 0) {
          const ratio = shortfall[s] / required[s]
          let priority = Math.max(shortfall[s] * 5, ratio * 50)
          if (ratio >= 0.8) priority *= 5
          else if (ratio >= 0.5) priority *= 3
          else if (ratio >= 0.25) priority *= 2
          slotPriority[s] = priority
        } else {
          slotPriority[s] = 0
        }
      }

      // Eligible drivers: not yet assigned today, under cap, night-rest OK for morning shifts.
      // Rotate the base order by `dayIndex` so different drivers get "first pick"
      // on different days when their weekly hours are tied — prevents the
      // alphabetically-first driver from systematically losing hours.
      const offset = drivers.length > 0 ? dayIndex % drivers.length : 0
      const rotated = [...drivers.slice(offset), ...drivers.slice(0, offset)]
      const candidates = rotated.filter((d) => {
        if (!available.includes(d) || assigned.has(d.id)) return false
        if ((daysWorked[d.id][wLabel] ?? 0) >= MAX_DAYS_PER_WEEK) return false
        // Skip drivers whose designated off day is today — rotates off
        // days across the week so Wed isn't everyone's default off day.
        if (designatedOffDow(d.id, wLabel) === dow) return false
        return true
      })
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
      // (e) doesn't push any slot above target+3 (hard ops tolerance).
      let placed = false
      for (const d of candidates) {
        const remaining = capOf(d) - (weekHours[d.id][wLabel] ?? 0)
        if (remaining < effectiveMin) continue  // not enough room for shortest allowed pattern

        // `maxHoursPerDay` is treated as a SOFT cap — most drivers stay
        // at/below it, but the algorithm may give a few drivers a single
        // extra hour when that overflow shift covers a real coverage
        // gap. The overflow is clamped at the LEGAL daily max (9h) so
        // schedules never silently push a driver into 10h+ daily
        // overtime, regardless of what the user set as `maxHoursPerDay`.
        // The quadratic length penalty below makes overflow rare
        // (e.g. with max=8, going to 9h costs 6000 score, only worth
        // it when the extra hour hits a critically short slot).
        //
        // SPREAD-ACROSS-6-DAYS: instead of `ceil(cap/6)` which leaves a
        // 3h sliver at the end of the week (5×8h=40h, 3h<min=4h → off
        // on day 6 → 2 days off total), divide the driver's REMAINING
        // hours by the REMAINING work-week days. This makes the per-day
        // target shrink as the week progresses, so a cap=43 driver does
        // ~7h shifts early and an 8h shift at the end, getting their
        // 6th day fitted in. Without this, 57% of driver-weeks defaulted
        // to 2 days off.
        const daysAlreadyWorkedThisWeek = daysWorked[d.id][wLabel] ?? 0
        const workDaysLeft = Math.max(1, MAX_DAYS_PER_WEEK - daysAlreadyWorkedThisWeek)
        const calendarDaysLeft = Math.max(1, remainingDows.length)  // includes today
        const spreadDays = Math.min(workDaysLeft, calendarDaysLeft)
        const spreadTarget = Math.ceil(remaining / spreadDays)
        const perDayTarget = Math.min(Math.ceil(capOf(d) / MAX_DAYS_PER_WEEK), spreadTarget)
        const softMax = Math.min(maxHoursPerDay + 1, LEGAL_DAILY_MAX_HOURS, MAX_HOURS_PER_DAY)
        const dailyCap = Math.min(remaining, softMax, Math.max(effectiveMin, spreadTarget))

        const blocks = blockedBitmap(timeOff, d, dateStr, dow)

        let bestPattern: boolean[] | null = null
        let bestScore = -1

        for (const p of allPatterns) {
          const h = slotHours(p)
          if (h < effectiveMin || h > softMax) continue
          // Overflow gate: a shift longer than the user-set max is only
          // allowed for drivers who've already worked a max-length shift
          // this week. So a "9h driver" must have already done their
          // 8h elsewhere — the overflow is a bonus hour for the team's
          // hardest workers, not a default.
          if (h > maxHoursPerDay && !hasMaxShiftThisWeek[d.id][wLabel]) continue
          if (h > dailyCap) continue
          if (h > remaining) continue
          if (firstActive(p) <= MORNING_SLOT_THRESHOLD && workedNightYesterday(d.id)) continue
          if (blocks && p.some((on, i) => on && blocks[i])) continue  // pattern conflicts with blocked slot

          // Hard over-coverage cap: refuse any pattern that would push a
          // slot beyond target + coverageTolerance(target). Tried
          // relaxing this for patterns that also fill shortfall, but
          // benchmarking showed it INCREASED severe gaps (relaxed runs:
          // 130 → 198 severe) because freed-up dirty patterns out-scored
          // cleaner gap-only ones. The cap stays as a hard constraint.
          let exceedsLimit = false
          for (let s = 0; s < p.length; s++) {
            if (p[s] && actualCov[s] + 1 > required[s] + coverageTolerance(required[s])) {
              exceedsLimit = true
              break
            }
          }
          if (exceedsLimit) continue

          // Score = base contribution + most-starved-slot priority boost.
          //
          // Base: shortfall × 10 (absolute demand) + 50 × shortfall/target
          // (relative urgency). Pure absolute scoring picks "10 AM-4 PM"
          // over "9 AM-3 PM" because mid-day demand outweighs morning, so
          // a per-slot priority boost is added separately below.
          //
          // Over-covered slots are PENALIZED (not just zero-rewarded).
          // For each unit a slot is already over target, the pattern
          // loses 30 points. This actively pushes the algorithm to
          // pick patterns that DON'T pile onto already-covered slots —
          // user's policy is "we'd accept gaps during not-busy times,
          // like 2-4 PM" since those slots are already over-staffed.
          let score = 0
          for (let s = 0; s < p.length; s++) {
            if (!p[s]) continue
            if (shortfall[s] > 0) {
              const t = required[s] || shortfall[s]
              score += shortfall[s] * 10 + (shortfall[s] / t) * 50
            } else {
              // overage = how many bodies past target this slot already has
              const overage = actualCov[s] - required[s]
              if (overage >= 0) score -= (overage + 1) * 700
            }
          }
          // Priority boost = sum of (slot priority × 20) for slots the
          // pattern covers. Multiple critical slots stack, so a pattern
          // hitting Sat 6 PM AND 7 PM scores much higher than one hitting
          // only one of them.
          for (let s = 0; s < p.length; s++) {
            if (p[s] && slotPriority[s] > 0) score += slotPriority[s] * 20
          }
          // Soft length preference: pay a *quadratic* penalty for each
          // hour above `perDayTarget - 1` (7h for the default cap=45).
          // Quadratic so 8h is mildly discouraged (-1500) but 9h is
          // strongly discouraged (-6000) — 9h shifts then only happen
          // when the extra hour covers a critically short slot. Goal:
          // most drivers settle around 6-7h, a healthy minority at 8h,
          // and only a few at the daily max. The user feedback was
          // "we're fine with a few working the max hours, but we don't
          // want every full-timer doing it."
          const preferredLength = Math.max(effectiveMin, perDayTarget - 1)
          if (h > preferredLength) {
            const over = h - preferredLength
            score -= over * over * 1500
          }
          if (score > bestScore) {
            bestScore = score
            bestPattern = p
          }
        }

        if (bestPattern && bestScore > 0) {
          const h = slotHours(bestPattern)
          weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + h
          daysWorked[d.id][wLabel] = (daysWorked[d.id][wLabel] ?? 0) + 1
          lastSlotWorked[d.id][dateStr] = lastActive(bestPattern)
          // Flag the driver as "earned the overflow" once they've done a
          // shift at the user-set max. Used by the overflow gate above.
          if (h >= maxHoursPerDay) hasMaxShiftThisWeek[d.id][wLabel] = true
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

// ─── Hiring recommendation ───────────────────────────────────────────────────

export interface CoverageHealth {
  /** Total weekly under-coverage in driver-hours. 0 = fully met. */
  weeklyShortfallHours: number
  /** Total weekly over-coverage in driver-hours. */
  weeklyOverstaffHours: number
  /** Suggested number of additional full-time drivers to close the gap. */
  recommendedAdditionalDrivers: number
  /** Per-date breakdown of shortfall, sorted descending. */
  worstDays: { date: string; dayLabel: string; shortfall: number }[]
}

/**
 * Analyzes a generated schedule's coverage vs effective per-day targets and
 * returns a hiring recommendation. Averages over all weeks the schedule spans
 * so multi-week imports don't artificially inflate the gap.
 */
/**
 * Per-slot coverage tolerance band (15% of the target, min 1). A slot is
 * inside its tolerance when |actual − required| ≤ coverageTolerance(target).
 * Small slots get tight bands (target 10 → ±2), heavy slots get loose ones
 * (target 56 → ±8) — matches ops policy "we can be flex ±15%".
 */
export const COVERAGE_GAP_TOLERANCE_PCT = 0.15

/** Integer tolerance for a given slot target. */
export function coverageTolerance(required: number): number {
  if (required <= 0) return 0
  return Math.max(1, Math.round(required * COVERAGE_GAP_TOLERANCE_PCT))
}

export function analyzeCoverageHealth(
  schedule: GeneratedDriverSchedule,
  coverageScale: number,
  coverageOverrides: Record<number, number[]>,
): CoverageHealth {
  const perDate = schedule.dates.map((di) => {
    const target = effectiveCoverage(di.dayOfWeek, coverageScale, coverageOverrides)
    const actual = schedule.coverageActual[di.date] ?? new Array(target.length).fill(0)
    // ALL under-coverage counts (no tolerance subtraction). Per policy
    // the coverage targets are a hard minimum — any gap is a real gap.
    let shortfall = 0
    let overstaff = 0
    for (let s = 0; s < target.length; s++) {
      const diff = target[s] - (actual[s] ?? 0)
      if (diff > 0) shortfall += diff
      else if (diff < 0) overstaff += -diff
    }
    return { date: di.date, dayLabel: di.dayLabel, shortfall, overstaff }
  })
  const weekCount = new Set(schedule.dates.map((d) => d.weekLabel)).size || 1
  const weeklyShortfallHours = perDate.reduce((s, d) => s + d.shortfall, 0) / weekCount
  const weeklyOverstaffHours = perDate.reduce((s, d) => s + d.overstaff, 0) / weekCount
  // Assume a new FT driver realistically contributes ~35h/week (cap minus some
  // slack for night-rest constraints, weekend rotation, and time-off).
  const FT_USABLE_HOURS = 35
  const recommendedAdditionalDrivers = Math.ceil(weeklyShortfallHours / FT_USABLE_HOURS)
  const worstDays = [...perDate]
    .filter((d) => d.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall)
    .slice(0, 3)
    .map(({ date, dayLabel, shortfall }) => ({ date, dayLabel, shortfall }))
  return { weeklyShortfallHours, weeklyOverstaffHours, recommendedAdditionalDrivers, worstDays }
}

// ─── Coverage + hour color helpers (UI) ─────────────────────────────────────

export type CoverageStatus = 'ok' | 'over' | 'mild' | 'short'

/**
 * Color-codes how far a slot's actual coverage is from its target:
 *   - 'ok'    at-or-above target with required > 0
 *   - 'mild'  over target but within +15% (still ok-ish, soft yellow)
 *   - 'short' ANY under-coverage (red — coverage targets are hard minimums)
 *   - 'over'  required = 0 but staffed (unusual — slate)
 *
 * The under-coverage tolerance was REMOVED per user policy:
 *   "coverage targets proposed must be respected, we can't have less
 *    drivers than the minimum."
 * Over-coverage still gets a 15% "mild" band because being a bit over
 * isn't a problem — only a waste.
 */
export function coverageStatus(actual: number, required: number): CoverageStatus {
  if (required === 0) return actual > 0 ? 'over' : 'ok'
  const diff = required - actual
  if (diff > 0) return 'short'  // any shortfall = severe per policy
  if (diff === 0) return 'ok'
  // diff < 0 → over target
  const tol = coverageTolerance(required)
  if (Math.abs(diff) <= tol) return 'mild'
  return 'over'
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
