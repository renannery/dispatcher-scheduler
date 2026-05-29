import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DRIVER_DAY_TEMPLATES,
  DRIVER_SLOTS,
  LEGAL_DAILY_MAX_HOURS,
  LEGAL_PT_WEEKLY_MAX_HOURS,
  LEGAL_WEEKLY_MAX_HOURS,
  MAX_HOURS_PER_DAY,
  OT_DAILY_BONUS,
  OT_FLEET_PCT,
  OT_WEEKLY_BONUS,
  SHOPPER_COVERAGE,
  USER_CAP_BUFFER_PCT,
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
  // Legal pre-OT weekly max for the driver's employment type:
  //   FT → 45h, PT → 30h
  const legalWeeklyMaxOf = (d: Driver) =>
    d.employmentType === 'full' ? LEGAL_WEEKLY_MAX_HOURS : LEGAL_PT_WEEKLY_MAX_HOURS
  // Soft buffer over the user-set cap (+10% by default). Used in
  // cap-fill phases so a few drivers can stretch past their target
  // cap to fill coverage gaps, but clamped at the legal pre-OT
  // weekly max FOR THAT EMPLOYMENT TYPE — so a PT with user cap=28
  // can stretch to 30 (PT legal max), and an FT with cap=43 can
  // stretch to 45 (FT legal max). Never silently triggers legal OT.
  const bufferedCapOf = (d: Driver) => Math.min(
    Math.round(capOf(d) * (1 + USER_CAP_BUFFER_PCT)),
    legalWeeklyMaxOf(d),
  )

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
    // Extra entries for slow days (more drivers off there). Capped at +2
    // so no single day exceeds ~3 entries in a 7-day pool — keeps no
    // single day's off probability above ~23% (was up to 30% on slow
    // days like Wed, which over-emptied Wed on tight rosters).
    const extra = Math.min(2, Math.max(0, Math.round((avgDailyDemand - dailyDemands[i]) / 15)))
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

  // Iterate dates with the SLOWEST day of each work-week scheduled
  // FIRST. Without this, busy days like Fri/Sat fill drivers to cap
  // before Wed gets considered — on tight rosters Wed ends up with
  // 30-100h shortfall just because everyone hit cap earlier.
  // Sorting slowest-first lets Wed get first pick of drivers; busier
  // days still fill later because pattern scoring favors their bigger
  // shortfall.
  const datesByWorkWeek = new Map<string, Date[]>()
  for (const d of allDates) {
    const wk = weekLabel(d)
    if (!datesByWorkWeek.has(wk)) datesByWorkWeek.set(wk, [])
    datesByWorkWeek.get(wk)!.push(d)
  }
  const iterationDates: Date[] = []
  for (const dates of datesByWorkWeek.values()) {
    const sorted = [...dates].sort((a, b) => {
      const ra = effectiveCoverage(a.getDay(), coverageScale, coverageOverrides).reduce((s, v) => s + v, 0)
      const rb = effectiveCoverage(b.getDay(), coverageScale, coverageOverrides).reduce((s, v) => s + v, 0)
      return ra - rb  // slowest first
    })
    iterationDates.push(...sorted)
  }

  // Seed shifts the rotation starting point so each Regenerate yields a
  // different driver order — without it, the algorithm is deterministic and
  // Regenerate appears to do nothing.
  let dayIndex = seed
  for (const date of iterationDates) {
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
    // On the last work-week day (Wed), allow short orphan-filler shifts
    // (down to 3h) so drivers with a 3h sliver of remaining cap can
    // still get placed and hit their weekly target. Other days keep
    // the user-set min (default 4).
    const effectiveMin = isLastWorkWeekDay ? Math.min(minHoursPerDay, 3) : minHoursPerDay

    // Split into off / available
    const available: Driver[] = []
    const dayOff: Driver[] = []

    for (const d of drivers) {
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
      // atCap uses the BUFFERED cap (user cap + 10%, clamped at legal)
      // so drivers near their user-set target stay eligible for the
      // main pass if shortfall remains. The main pass's spread logic
      // still aims for user cap, but a few drivers can stretch into
      // the buffer when needed.
      const atCap = (weekHours[d.id][wLabel] ?? 0) >= bufferedCapOf(d) - 0.5
      // Shoppers don't work Sundays (grocery store is closed).
      const isShopperOnSunday = d.isShopper && dow === 0
      if (fullyBlocked || atCap || isShopperOnSunday) {
        dayOff.push(d)
      } else {
        available.push(d)
      }
    }

    const allPatterns = template.shiftPatterns
      .map((raw) => raw.map((v) => v === 1))
      .filter((p) => slotHours(p) <= MAX_HOURS_PER_DAY)

    const actualCov = new Array(DRIVER_SLOTS.length).fill(0)
    const shopperCov = new Array(DRIVER_SLOTS.length).fill(0)
    const shopperRequired = SHOPPER_COVERAGE[dow] ?? new Array(DRIVER_SLOTS.length).fill(0)
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
      function computePriority(req: number[], shrt: number[]): number[] {
        return req.map((r, s) => {
          if (shrt[s] <= 0 || r <= 0) return 0
          const ratio = shrt[s] / r
          let priority = Math.max(shrt[s] * 5, ratio * 50)
          if (ratio >= 0.8) priority *= 5
          else if (ratio >= 0.5) priority *= 3
          else if (ratio >= 0.25) priority *= 2
          return priority
        })
      }
      const slotPriority = computePriority(required, shortfall)
      // Parallel shopper shortfall/priority — shoppers are scored
      // against SHOPPER demand (groceries), not driver demand.
      const shopperShortfall = shopperRequired.map((r, s) =>
        Math.max(0, r - shopperCov[s]))
      const shopperSlotPriority = computePriority(shopperRequired, shopperShortfall)

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
        // EXCEPT in three cases (designated off is OVERRIDDEN):
        //   0. The driver is a SHOPPER — their only off day is Sunday
        //      (handled elsewhere), so they always work Mon-Sat. Skip
        //      the rotation filter entirely for them.
        //   1. The day still has ANY coverage shortfall — pulling the
        //      driver in helps fill gaps. This is the dominant fix for
        //      Wed, where the demand-weighted pool puts 25% of drivers
        //      off but Wed's actual demand (312h) still needs them.
        //   2. The driver is significantly under their weekly cap
        //      (< 70%) — let them use their hours rather than strand cap.
        if (!d.isShopper && designatedOffDow(d.id, wLabel) === dow) {
          const usedFraction = (weekHours[d.id][wLabel] ?? 0) / capOf(d)
          const shouldOverride = totalShort > 0 || usedFraction < 0.7
          if (!shouldOverride) return false
        }
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

          // Score shoppers against SHOPPER demand, others against driver
          // demand. This is the single key change: shopper shifts now
          // get picked to fill GROCERY coverage, not driver coverage.
          const myReq = d.isShopper ? shopperRequired : required
          const myCov = d.isShopper ? shopperCov : actualCov
          const myShort = d.isShopper ? shopperShortfall : shortfall
          const myPriority = d.isShopper ? shopperSlotPriority : slotPriority

          // Hard over-coverage cap: refuse any pattern that would push
          // this pool's slot beyond target + tolerance.
          let exceedsLimit = false
          for (let s = 0; s < p.length; s++) {
            if (p[s] && myCov[s] + 1 > myReq[s] + coverageTolerance(myReq[s])) {
              exceedsLimit = true
              break
            }
          }
          if (exceedsLimit) continue

          // Score = base contribution + most-starved-slot priority boost.
          let score = 0
          for (let s = 0; s < p.length; s++) {
            if (!p[s]) continue
            if (myShort[s] > 0) {
              const t = myReq[s] || myShort[s]
              score += myShort[s] * 10 + (myShort[s] / t) * 50
            } else {
              const overage = myCov[s] - myReq[s]
              if (overage > 0) score -= overage * 700
              else score += 1
            }
          }
          for (let s = 0; s < p.length; s++) {
            if (p[s] && myPriority[s] > 0) score += myPriority[s] * 20
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
          // Increment the right pool's coverage based on driver type.
          // Drivers contribute to actualCov (driver demand); shoppers
          // contribute to shopperCov (groceries demand).
          const targetCov = d.isShopper ? shopperCov : actualCov
          for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) targetCov[s]++
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

  // ─── Phase 1 of cap-fill: ADD a shift on an off-day ────────────────────
  // If a driver has < 6 days worked AND remaining cap >= effective min,
  // try to place a new short shift on one of their off-days BEFORE the
  // extend pass. Otherwise the extend pass would push existing shifts to
  // max (e.g. 5×8h → 5×9h = 45h cap), eating the leftover that could
  // have funded a 6th day. Adding-then-extending gives us 6 days at
  // ~7-8h each (more fair) instead of 5 days at max.
  for (const d of drivers) {
    if (d.isShopper) continue  // shoppers always work 6 days already
    // Phase 1 add-shift also uses the BUFFERED cap so drivers can
    // pick up a new short shift on an off-day even when slightly past
    // target cap. Without this, drivers at user cap (e.g., 40h) couldn't
    // help with Wed shortfall even with 4h of buffer headroom available.
    const cap = bufferedCapOf(d)
    for (let i = 0; i < scheduleMap[d.id].length; i++) {
      const entry = scheduleMap[d.id][i]
      if (!entry.isOff) continue
      const dateStr = entry.date
      const dow = entry.dayOfWeek
      const wLabel = weekLabel(parseISO(dateStr))
      const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
      const minShift = (dow === 3) ? 3 : minHoursPerDay  // Wed allows 3h orphan filler
      if (remaining < minShift) continue
      if ((daysWorked[d.id][wLabel] ?? 0) >= MAX_DAYS_PER_WEEK) continue
      if (d.isShopper) continue
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks && blocks.length > 0 && blocks.every(Boolean)) continue
      const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
      const cov = coverageActual[dateStr]

      // Find a short pattern (≤ remaining) that fits the driver's
      // blocks and doesn't push any slot past the over-cap. Pick the
      // one that covers the most short slots.
      //
      // Use a generous +15% over-cap tolerance HERE (vs the main
      // pass's +5%) so cap-fill shifts can squeeze into days where
      // most slots are at the +5% ceiling. Leaving a driver at 5 days
      // with 3-4h orphan is worse than over-staffing one slot by 1 body.
      const fillTolerance = (req: number) => req <= 0 ? 0 : Math.max(1, Math.round(req * 0.15))
      const template = DRIVER_DAY_TEMPLATES[dow]
      let bestPattern: boolean[] | null = null
      let bestFit = -1
      for (const raw of template.shiftPatterns) {
        const p = raw.map(v => v === 1)
        const h = slotHours(p)
        if (h < minShift || h > remaining) continue
        if (h > Math.min(maxHoursPerDay + 1, LEGAL_DAILY_MAX_HOURS)) continue
        if (firstActive(p) <= MORNING_SLOT_THRESHOLD) {
          const yest = scheduleMap[d.id][i - 1]
          if (yest && !yest.isOff) {
            let yestLast = -1
            for (let z = yest.slots.length - 1; z >= 0; z--) if (yest.slots[z]) { yestLast = z; break }
            if (yestLast >= NIGHT_SLOT_THRESHOLD) continue
          }
        }
        if (blocks && p.some((on, idx) => on && blocks[idx])) continue
        let exceeds = false
        let helps = 0
        for (let s = 0; s < p.length; s++) {
          if (!p[s]) continue
          if (cov[s] + 1 > required[s] + fillTolerance(required[s])) { exceeds = true; break }
          if (required[s] - cov[s] > 0) helps++
        }
        if (exceeds) continue
        // Prefer the pattern that covers the most under-target slots.
        // Tie-break: prefer SHORTER pattern (saves cap for other off-days).
        const score = helps * 10 - h
        if (score > bestFit) {
          bestFit = score
          bestPattern = p
        }
      }
      if (!bestPattern) continue

      // Apply: replace the OFF entry with a real shift.
      const h = slotHours(bestPattern)
      entry.isOff = false
      entry.slots = [...bestPattern]
      entry.totalHours = h
      weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + h
      daysWorked[d.id][wLabel] = (daysWorked[d.id][wLabel] ?? 0) + 1
      for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) cov[s]++
      lastSlotWorked[d.id][dateStr] = lastActive(bestPattern)
    }
  }

  // ─── Phase 2 of cap-fill: EXTEND existing shifts by 1h ───────────────────
  // After the main per-day scheduling, some drivers still have unused
  // weekly cap (e.g. 36/43h = 7h orphaned). The user's manual edits show
  // ops would extend those drivers' existing shifts by 1h on either side
  // (e.g. "11AM-7PM 7h → 10AM-7PM 8h") or "11AM-7PM 7h → 11AM-8PM 8h").
  // This pass does the same automatically: for each (driver, day) with
  // a scheduled shift and remaining weekly cap, try to extend by 1h at
  // the start, then at the end. Validates:
  //  - doesn't exceed maxHoursPerDay (the soft cap)
  //  - doesn't break night-rest with the NEXT day's morning shift
  //  - doesn't push any newly-covered slot beyond +15% over-cap
  //  - the new slot is within operating hours (required > 0)
  //  - the driver wasn't blocked off on that slot
  for (const d of drivers) {
    for (let i = 0; i < scheduleMap[d.id].length; i++) {
      const entry = scheduleMap[d.id][i]
      if (entry.isOff) continue
      const dateStr = entry.date
      const dow = entry.dayOfWeek
      const wLabel = weekLabel(parseISO(dateStr))
      const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
      const cov = coverageActual[dateStr]
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      // Phase 2 extend uses the BUFFERED cap (user cap + 10%, clamped
      // at legal max). Lets the algorithm stretch a few drivers past
      // their target cap to fill residual gaps, but never past legal.
      const cap = bufferedCapOf(d)

      // Try extending up to 2 times (1h on each side, in priority order).
      for (let pass = 0; pass < 2; pass++) {
        const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
        if (remaining < 1) break

        const slots = entry.slots
        const currentHours = slots.filter(Boolean).length
        if (currentHours >= maxHoursPerDay + 1) break  // already at soft max
        if (currentHours >= LEGAL_DAILY_MAX_HOURS) break  // legal max

        const first = slots.findIndex(s => s)
        const last = (() => { for (let s = slots.length - 1; s >= 0; s--) if (slots[s]) return s; return -1 })()

        // Candidate slots to add: one before, one after. Prefer the one
        // that's MORE under-target (or short on coverage). If neither is
        // valid, give up.
        const candidates: number[] = []
        if (first > 0) candidates.push(first - 1)
        if (last >= 0 && last < slots.length - 1) candidates.push(last + 1)

        let best: number | null = null
        let bestShortfall = -1
        for (const s of candidates) {
          if (required[s] <= 0) continue                       // outside ops hours
          if (blocks && blocks[s]) continue                    // driver-blocked slot
          // For non-shoppers, the extension counts toward driver
          // coverage — refuse if it'd push past the over-cap. Use the
          // generous +15% tolerance for cap-fill (vs the main pass's
          // +5%) so drivers can hit their weekly cap.
          const fillTol = required[s] <= 0 ? 0 : Math.max(1, Math.round(required[s] * 0.15))
          if (!d.isShopper && cov[s] + 1 > required[s] + fillTol) continue
          // Night-rest: if extending into the morning of NEXT day would
          // conflict, skip. The night-rest rule applies to MORNING shifts
          // after a closing shift the day before — we check shifts we
          // EXTEND into closing only against tomorrow's start.
          if (s >= NIGHT_SLOT_THRESHOLD) {
            const tomorrow = scheduleMap[d.id][i + 1]
            if (tomorrow && !tomorrow.isOff) {
              const tFirst = tomorrow.slots.findIndex(x => x)
              if (tFirst >= 0 && tFirst <= MORNING_SLOT_THRESHOLD) continue
            }
          }
          // Pick the slot with the larger shortfall.
          const slotShort = Math.max(0, required[s] - cov[s])
          if (slotShort > bestShortfall) {
            bestShortfall = slotShort
            best = s
          }
        }

        if (best === null) break

        // Apply the extension.
        slots[best] = true
        entry.totalHours = (entry.totalHours ?? 0) + 1
        if (!d.isShopper) cov[best]++  // shoppers don't count toward driver coverage
        weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + 1
        if (best > (lastSlotWorked[d.id][dateStr] ?? -1)) {
          lastSlotWorked[d.id][dateStr] = best
        }
      }
    }
  }

  // ─── Phase 3 of cap-fill: OVERTIME pass (last resort) ────────────────────
  // After Phase 1 (add shift) + Phase 2 (extend within 45h cap), if any
  // day still has driver shortfall, allow up to OT_FLEET_PCT of FT drivers
  // (5 drivers for a 53-FT roster) to go past the legal weekly cap by
  // OT_WEEKLY_BONUS and past the daily cap by OT_DAILY_BONUS. The pass
  // picks the highest-utilized drivers (already running close to cap, so
  // already proven willing/available) and extends their shifts to cover
  // residual gaps. Each extension is real legal overtime — shown as the
  // purple OT pill in the UI so payroll knows.
  const ftDrivers = drivers.filter(d => d.employmentType === 'full' && !d.isShopper)
  const otBudget = Math.max(1, Math.floor(ftDrivers.length * OT_FLEET_PCT))
  // Track per-driver OT used (across all weeks), capped at OT_WEEKLY_BONUS per week
  const otWeekHours: Record<string, Record<string, number>> = {}
  for (const d of ftDrivers) otWeekHours[d.id] = {}

  // Find dates with remaining shortfall
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i]
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const wLabel = weekLabel(date)
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    let shortfall = 0
    for (let s = 0; s < required.length; s++) shortfall += Math.max(0, required[s] - cov[s])
    if (shortfall === 0) continue

    // Build OT-eligible pool for THIS week. Two layers of fairness:
    //   1. STRIDE-SELECT 5 drivers spread across the alphabet (not
    //      5 alphabetically-adjacent ones). For a 53-FT fleet and
    //      budget=5, stride=10 → pick indexes [0,10,20,30,40].
    //   2. ROTATE the start offset per week so different drivers get
    //      picked each week. Offset advances by 1 each week so over
    //      `stride` weeks every driver has been visited once.
    // Without this, ties on weekHours broke alphabetically and the
    // A-named drivers always got OT.
    const weekIdx = weekIndexByLabel.get(wLabel) ?? 0
    const fleetSize = ftDrivers.length
    const stride = fleetSize > 0 ? Math.max(1, Math.floor(fleetSize / otBudget)) : 1
    const startOffset = fleetSize > 0 ? (weekIdx + seed) % fleetSize : 0
    const candidates: Driver[] = []
    const seen = new Set<string>()
    for (let i = 0; i < otBudget && i < fleetSize; i++) {
      const idx = (startOffset + i * stride) % fleetSize
      const d = ftDrivers[idx]
      if (!seen.has(d.id)) {
        candidates.push(d)
        seen.add(d.id)
      }
    }

    for (const d of candidates) {
      // Per-driver OT hours used so far this week.
      const otUsed = otWeekHours[d.id][wLabel] ?? 0
      if (otUsed >= OT_WEEKLY_BONUS) continue  // OT budget exhausted

      // Find this driver's shift on this day (or null if off).
      const entry = scheduleMap[d.id].find(e => e.date === dateStr)
      if (!entry) continue
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)

      // EXTEND case: existing shift, add 1h on either side (10h daily max
      // via OT_DAILY_BONUS = 1, so 9h + 1 = 10h).
      if (!entry.isOff) {
        const currentHours = entry.totalHours ?? 0
        if (currentHours >= LEGAL_DAILY_MAX_HOURS + OT_DAILY_BONUS) continue
        const slots = entry.slots
        const first = slots.findIndex(s => s)
        let last = -1
        for (let z = slots.length - 1; z >= 0; z--) if (slots[z]) { last = z; break }
        const tries: number[] = []
        if (first > 0) tries.push(first - 1)
        if (last >= 0 && last < slots.length - 1) tries.push(last + 1)
        let placed = false
        for (const s of tries) {
          if (placed) break
          if (required[s] <= 0) continue
          if (blocks && blocks[s]) continue
          if (cov[s] + 1 > required[s]) continue  // only fill REAL shortfall, no piling on
          slots[s] = true
          entry.totalHours = currentHours + 1
          cov[s]++
          weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + 1
          otWeekHours[d.id][wLabel] = otUsed + 1
          placed = true
        }
      }
      // Note: we don't ADD a new shift on an off-day for OT — that's
      // a bigger schedule disruption. Extending an existing shift by 1h
      // is the cleanest OT pattern (driver already on-site, just stays
      // longer or comes in earlier).
    }
  }

  // ─── Phase 4 of cap-fill: REBALANCE (shift-later swap) ──────────────────
  // After Phases 1-3 some days still show "morning over-staffed, evening
  // peak short". This pass walks each day and tries to SWAP a driver's
  // current pattern for a different one (same length, same template
  // pool, respecting blocks + night-rest) that reduces the day's total
  // shortfall. Matches the user's manual edits where drivers were
  // shifted from 9 AM starts to 11 AM-12 PM starts to land coverage
  // on the 6-8 PM dinner peak.
  for (let dayIdx = 0; dayIdx < allDates.length; dayIdx++) {
    const date = allDates[dayIdx]
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    const template = DRIVER_DAY_TEMPLATES[dow]
    const allPatterns = template.shiftPatterns
      .map((raw) => raw.map((v) => v === 1))
      .filter((p) => slotHours(p) <= MAX_HOURS_PER_DAY)

    function totalUnder(c: number[]): number {
      let t = 0
      for (let s = 0; s < required.length; s++) t += Math.max(0, required[s] - c[s])
      return t
    }
    if (totalUnder(cov) === 0) continue

    // Pass repeatedly until no improvement (max 50 iterations safety).
    for (let iter = 0; iter < 50; iter++) {
      let bestDriver: Driver | null = null
      let bestPattern: boolean[] | null = null
      let bestImprovement = 0
      const beforeUnder = totalUnder(cov)
      if (beforeUnder === 0) break

      for (const d of drivers) {
        if (d.isShopper) continue  // shoppers tracked separately
        const entry = scheduleMap[d.id][dayIdx]
        if (!entry || entry.isOff || entry.date !== dateStr) continue
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        const curHours = entry.totalHours ?? 0

        // Compute coverage as if THIS driver's current pattern were removed.
        const covWithout = [...cov]
        for (let s = 0; s < entry.slots.length; s++) if (entry.slots[s]) covWithout[s]--

        for (const p of allPatterns) {
          const h = slotHours(p)
          if (h !== curHours) continue                 // keep same length (preserves cap)
          // No-op: skip if pattern is the SAME as current.
          let same = true
          for (let s = 0; s < p.length; s++) {
            if (p[s] !== entry.slots[s]) { same = false; break }
          }
          if (same) continue
          if (blocks && p.some((on, i) => on && blocks[i])) continue
          // Night-rest with TOMORROW (only matters if shift ends past closing).
          let pLast = -1
          for (let s = p.length - 1; s >= 0; s--) if (p[s]) { pLast = s; break }
          if (pLast >= NIGHT_SLOT_THRESHOLD) {
            const tomorrow = scheduleMap[d.id][dayIdx + 1]
            if (tomorrow && !tomorrow.isOff && firstActive(tomorrow.slots) <= MORNING_SLOT_THRESHOLD) continue
          }
          // Night-rest with YESTERDAY (only matters if THIS shift starts in the morning).
          const pFirst = firstActive(p)
          if (pFirst <= MORNING_SLOT_THRESHOLD) {
            const yest = scheduleMap[d.id][dayIdx - 1]
            if (yest && !yest.isOff) {
              let yLast = -1
              for (let s = yest.slots.length - 1; s >= 0; s--) if (yest.slots[s]) { yLast = s; break }
              if (yLast >= NIGHT_SLOT_THRESHOLD) continue
            }
          }

          // Compute new coverage with this pattern, check if total under improves.
          const covWith = [...covWithout]
          for (let s = 0; s < p.length; s++) if (p[s]) covWith[s]++
          const newUnder = totalUnder(covWith)
          const improvement = beforeUnder - newUnder
          if (improvement > bestImprovement) {
            // The swap is reducing TOTAL shortfall — accept it even if
            // a slot it touches is already over the +5% main cap. The
            // alternative (leaving the gap) is worse than mild extra
            // over-coverage on a slot that was already over.
            bestImprovement = improvement
            bestDriver = d
            bestPattern = p
          }
        }
      }

      if (!bestDriver || !bestPattern) break

      // Apply the swap.
      const entry = scheduleMap[bestDriver.id][dayIdx]
      for (let s = 0; s < entry.slots.length; s++) if (entry.slots[s]) cov[s]--
      entry.slots = [...bestPattern]
      for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) cov[s]++
      lastSlotWorked[bestDriver.id][dateStr] = lastActive(bestPattern)
    }
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
 * Per-slot OVER-coverage tolerance band — how much above target a slot can
 * be staffed before the algorithm refuses to add more. Tightened from
 * 15% to 5% (min 1 body) so that days like Thu/Fri stop being over-staffed
 * (which was leaving Wed structurally starved). Under-coverage has ZERO
 * tolerance per ops policy ("coverage targets are hard minimums") — see
 * `coverageStatus()` and `analyzeCoverageHealth()` for that.
 *
 * Small slots still get tight bands (target 10 → ±1, target 22 → ±1)
 * because of the min-1 floor. Heavy slots get a +5% ceiling (target 56 →
 * +3, target 39 → +2) so over-coverage on big slots is also limited.
 */
export const COVERAGE_GAP_TOLERANCE_PCT = 0.05

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
