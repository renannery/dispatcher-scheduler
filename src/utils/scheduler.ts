import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DAY_TEMPLATES,
  effectiveCoverage,
  LONG_SHIFT_BREAK_MIN,
  MAX_BREAK_HARD_HOURS,
  MAX_BREAK_PREFERRED_HOURS,
  MED_SHIFT_BREAK_MIN,
  midShiftBreakSlots,
  MIN_BLOCK_HOURS,
  patternMaxBreakHours,
  patternWorkBlocks,
  PEAK_SLOT_INDICES,
  SLOTS,
} from '@/data/coverageTemplate'
import type {
  Dispatcher,
  DispatcherDayEntry,
  DispatcherSchedule,
  DispatcherTimeOff,
  GeneratedSchedule,
} from '@/types/schedule'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fri, Sat, Sun — the "heavy" weekend days the fairness picker spreads. */
export const HEAVY_DAYS = new Set([5, 6, 0]) // Fri, Sat, Sun

/** Soft target: try to give every dispatcher 2 days off per week, fall back
 *  to 1 day off only when coverage demand makes 2 infeasible. The picker
 *  never *elects* a 3rd off-day on top of recurring blocks. */
const MAX_DAYS_OFF_PER_WEEK = 2

/** Legal weekly maximum. Once a dispatcher reaches this they're forced off
 *  the rest of the week (treated like time-off, doesn't count against the
 *  off-days fairness cap). Daily max (9 h) is enforced via pattern shapes. */
const WEEKLY_CAP_HOURS = 45

/** Soft target the picker tries to keep everyone under, even when there's
 *  spare cap room. Dispatchers are on fixed monthly salary so a tight
 *  band keeps weekly hours equitable. Only relaxed when no eligible
 *  dispatcher fits — then we fall back to the legal 45 h cap. */
const SOFT_WEEKLY_TARGET = 38

function slotHours(slots: boolean[]): number {
  return slots.reduce((sum, on, i) => sum + (on ? SLOTS[i].hours : 0), 0)
}

function weekLabel(date: Date): string {
  // Work week runs Thu → Wed
  // (dow + 3) % 7 gives the number of days since the last Thursday
  const dow = date.getDay()
  const thu = addDays(date, -((dow + 3) % 7))
  const wed = addDays(thu, 6)
  return `${format(thu, 'MMM d')} – ${format(wed, 'MMM d')}`
}

/** Index of first working slot in a pattern (-1 if none). */
function firstActiveSlot(pattern: boolean[]): number {
  return pattern.findIndex((v) => v)
}

/** Index of last working slot in a pattern (-1 if none). */
function lastActiveSlot(pattern: boolean[]): number {
  for (let i = pattern.length - 1; i >= 0; i--) {
    if (pattern[i]) return i
  }
  return -1
}

/**
 * A "night shift" ends at slot 17 (9–10 PM) or later.
 * Dispatchers who worked a night shift should not be assigned a morning
 * pattern (starts at slot 0/1/2 — 8/9/10 AM) the following day.
 */
const NIGHT_SLOT_THRESHOLD = 17  // 9 PM
const MORNING_SLOT_THRESHOLD = 2 // starts ≤ 10 AM

// ---------------------------------------------------------------------------
// Coverage-aware swap pass — runs after the main greedy assignment to
// extend single-block shifts into peak-break splits when it closes a
// real coverage gap on the morning/late edge. A peak-time break is only
// allowed when the peak slot is currently over-covered (slack to lend).
// ---------------------------------------------------------------------------

const PEAK_SLOT_SET_INTERNAL = new Set(PEAK_SLOT_INDICES)

/** True when this shift bitmap satisfies every dispatcher shape rule
 *  (min 3h block, max 1 break, break-by-length, ≤9h daily). */
function isValidShiftShape(slots: boolean[]): boolean {
  const blocks = patternWorkBlocks(slots, SLOTS)
  if (blocks.length === 0) return false
  if (blocks.length > 2) return false // at most one break per shift
  if (blocks.length > 1 && Math.min(...blocks) < MIN_BLOCK_HOURS) return false
  const totalWork = blocks.reduce((s, h) => s + h, 0)
  if (totalWork > 9) return false
  const maxBreak = patternMaxBreakHours(slots, SLOTS)
  if (maxBreak > MAX_BREAK_HARD_HOURS) return false
  if (totalWork >= 8 && maxBreak < LONG_SHIFT_BREAK_MIN) return false
  if (totalWork > 6 && totalWork < 8 && maxBreak < MED_SHIFT_BREAK_MIN) return false
  return true
}

/** Net coverage gain of replacing oldSlots with newSlots, where `cov` is
 *  the current per-slot coverage. Gains count for under-target slots and
 *  losses count when dropping at-target slots below target. Over-target
 *  slots can be lent freely (no penalty). */
function computeCoverageGain(
  oldSlots: boolean[],
  newSlots: boolean[],
  cov: number[],
  req: number[],
): number {
  let net = 0
  for (let i = 0; i < oldSlots.length; i++) {
    const old = oldSlots[i] ? 1 : 0
    const nw = newSlots[i] ? 1 : 0
    if (old === nw) continue
    if (old === 0 && nw === 1) {
      // Adding coverage: gain if slot is under target
      if (cov[i] < req[i]) net += 1
      // small penalty for over-covering (still counts a tiny bit so we don't
      // expand into already-saturated slots for no reason)
      else net -= 0.1
    } else {
      // Removing coverage: loss only if it pushes us below target
      const after = cov[i] - 1
      if (after < req[i]) net -= 2
    }
  }
  return net
}

/** Attempts to extend a single-block shift into a peak-break split that
 *  closes a morning/late coverage gap. Returns the new bitmap or null. */
function trySwapForCoverage(
  slots: boolean[],
  cov: number[],
  req: number[],
): boolean[] | null {
  const blocks = patternWorkBlocks(slots, SLOTS)
  // Only attempt swaps on simple single-block shifts. Multi-block patterns
  // already have a break placed by the template designer.
  if (blocks.length !== 1) return null
  const totalWork = blocks[0]
  if (totalWork >= 9) return null // already at daily max

  const firstOn = slots.findIndex((v) => v)
  const lastOn = (() => { for (let i = slots.length - 1; i >= 0; i--) if (slots[i]) return i; return -1 })()
  if (firstOn < 0 || lastOn < 0) return null

  // Find contiguous adjacent under-covered slots we could extend into.
  const morningGain: number[] = []
  for (let j = firstOn - 1; j >= 0; j--) {
    if (cov[j] < req[j]) morningGain.unshift(j)
    else break
  }
  const eveningGain: number[] = []
  for (let j = lastOn + 1; j < slots.length; j++) {
    if (cov[j] < req[j]) eveningGain.push(j)
    else break
  }
  if (morningGain.length === 0 && eveningGain.length === 0) return null

  // Try each side independently, prefer the side with more gap to close.
  const sides = [
    { ext: morningGain, hours: morningGain.reduce((s, j) => s + SLOTS[j].hours, 0) },
    { ext: eveningGain, hours: eveningGain.reduce((s, j) => s + SLOTS[j].hours, 0) },
  ].filter((s) => s.ext.length > 0).sort((a, b) => b.hours - a.hours)

  for (const side of sides) {
    // Build the extended shift (no break yet)
    const extended = [...slots]
    side.ext.forEach((j) => (extended[j] = true))
    const extFirstOn = extended.findIndex((v) => v)
    let extLastOn = -1
    for (let i = extended.length - 1; i >= 0; i--) if (extended[i]) { extLastOn = i; break }

    // Quick win: if extension keeps total ≤ 6 h we don't need any break.
    const extWork = slotHours(extended)
    if (extWork <= 6 && isValidShiftShape(extended) && computeCoverageGain(slots, extended, cov, req) > 0) {
      return extended
    }

    // Otherwise we need a break. Required break duration by shift length.
    const needBreak = extWork > 8 ? LONG_SHIFT_BREAK_MIN
                    : extWork > 6 ? MED_SHIFT_BREAK_MIN
                    : 0

    // Try every contiguous break position that keeps both blocks ≥ 3 h
    // and respects the peak-slot rule (peak slot in the break must be
    // currently over-covered — we can only LEND slack we have).
    let best: boolean[] | null = null
    let bestGain = 0
    for (let bs = extFirstOn + 1; bs < extLastOn; bs++) {
      for (let bl = 1; bl <= 4; bl++) {
        const be = bs + bl - 1
        if (be >= extLastOn) break
        // Build the break slot list
        const breakSlots: number[] = []
        let bh = 0
        for (let k = bs; k <= be; k++) {
          breakSlots.push(k)
          bh += SLOTS[k].hours
        }
        if (bh < needBreak - 0.01) continue
        // Peak-break check: only allow when over-covered now AND staying
        // at or above target after this dispatcher steps off the slot.
        const peakIssue = breakSlots.some((s) => PEAK_SLOT_SET_INTERNAL.has(s) && cov[s] - 1 < req[s])
        if (peakIssue) continue
        const candidate = [...extended]
        breakSlots.forEach((s) => (candidate[s] = false))
        if (!isValidShiftShape(candidate)) continue
        const gain = computeCoverageGain(slots, candidate, cov, req)
        if (gain > bestGain) {
          best = candidate
          bestGain = gain
        }
      }
    }
    if (best) return best
  }
  return null
}

/** Iterate the day's assignments and apply at most one swap per dispatcher
 *  that improves coverage. Mutates the assignments array in place. */
function coverageAwareSwapPass(
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>,
  required: number[],
): void {
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) {
    pattern.forEach((on, si) => { if (on) cov[si]++ })
  }
  for (let i = 0; i < assignments.length; i++) {
    const orig = assignments[i].pattern
    const swapped = trySwapForCoverage(orig, cov, required)
    if (!swapped) continue
    // Apply swap + update running coverage
    orig.forEach((v, k) => { if (v) cov[k]-- })
    swapped.forEach((v, k) => { if (v) cov[k]++ })
    assignments[i].pattern = swapped
  }
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

function blockedBitmap(
  timeOff: DispatcherTimeOff,
  dispatcher: Dispatcher,
  date: string,
  dayOfWeek: number,
): boolean[] | null {
  const dateBm = timeOff[dispatcher.id]?.[date]
  const recurBm = dispatcher.recurringBlocks?.[dayOfWeek]
  const hasDate = !!dateBm && dateBm.length > 0
  const hasRecur = !!recurBm && recurBm.some(Boolean)
  if (!hasDate && !hasRecur) return null
  const n = Math.max(dateBm?.length ?? 0, recurBm?.length ?? 0)
  const out = new Array(n).fill(false)
  for (let i = 0; i < n; i++) out[i] = !!(dateBm?.[i] || recurBm?.[i])
  return out
}

export function generateSchedule(
  dispatchers: Dispatcher[],
  startDate: string,
  endDate: string,
  timeOff: DispatcherTimeOff,
  seed = 0,
  coverageOverrides: Record<number, number[]> = {},
): GeneratedSchedule {
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  const totalDays = differenceInDays(end, start) + 1

  const allDates = Array.from({ length: totalDays }, (_, i) => addDays(start, i))

  // Per-dispatcher, per-week hour accumulator
  const weekHours: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekHours[d.id] = {}))

  // Per-dispatcher, per-week off-day counter. Counts recurring blocks AND
  // elected off-days together, so a dispatcher with Fri as a recurring block
  // gets at most 1 more elected off-day in that week.
  const weekOffDays: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekOffDays[d.id] = {}))

  // Per-dispatcher total weekend (Fri/Sat/Sun) off-days across the whole
  // schedule. Used by the fairness picker to spread weekend off-days evenly.
  const weekendOffTotal: Record<string, number> = {}
  dispatchers.forEach((d) => (weekendOffTotal[d.id] = 0))

  // Per-dispatcher total elected off-days (excludes recurring/per-date blocks
  // and 45 h cap-hits). Used as a fairness tiebreak across weeks so the same
  // dispatcher isn't picked off every Thursday.
  const totalElectedOff: Record<string, number> = {}
  dispatchers.forEach((d) => (totalElectedOff[d.id] = 0))

  // Per-dispatcher running total of working hours across the entire schedule.
  // Used as a tiebreak so dispatchers who are *cumulatively* behind get the
  // next shift first, smoothing imbalances that build up week after week.
  const totalHoursWorked: Record<string, number> = {}
  dispatchers.forEach((d) => (totalHoursWorked[d.id] = 0))

  // Track the last active slot index each dispatcher worked on each date
  // (used to enforce the night-rest constraint)
  const lastSlotWorked: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (lastSlotWorked[d.id] = {}))

  const scheduleMap: Record<string, DispatcherDayEntry[]> = {}
  dispatchers.forEach((d) => (scheduleMap[d.id] = []))
  const coverageActual: Record<string, number[]> = {}
  const coverageRequired: Record<string, number[]> = {}

  let dayIndex = seed

  for (const date of allDates) {
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const template = DAY_TEMPLATES[dow]
    const wLabel = weekLabel(date)
    const dayLabel = format(date, 'EEE, MMMM do')
    const yesterday = format(addDays(date, -1), 'yyyy-MM-dd')

    // Pre-compute pattern metadata (once per day)
    const peakSlotSet = new Set(PEAK_SLOT_INDICES)
    const patternMeta = template.shiftPatterns.map((raw, idx) => {
      const bool = raw.map((v) => v === 1)
      const breakSlots = midShiftBreakSlots(bool)
      return {
        idx,
        bool,
        hours: slotHours(bool),
        first: firstActiveSlot(bool),
        last: lastActiveSlot(bool),
        isMorning: firstActiveSlot(bool) <= MORNING_SLOT_THRESHOLD,
        maxBreak: patternMaxBreakHours(bool, SLOTS),
        // True when this pattern's mid-shift break overlaps lunch (12-2 PM)
        // or dinner (5-8 PM) peak slots. Such patterns are *allowed* but
        // sorted AFTER peak-safe ones so the picker uses them only when no
        // peak-safe option remains — i.e., as flexibility for the leftover
        // dispatcher rather than a default.
        hasPeakBreak: breakSlots.some((i) => peakSlotSet.has(i)),
      }
    })

    // Sort patterns: morning first, then PEAK-SAFE first (peak-break shifts
    // sort after equivalent peak-safe ones), then LONGEST shifts first so
    // they go to the least-loaded dispatcher. Break-size penalty (over the
    // 2 h preferred cap) is the last tiebreak.
    const byLengthThenBreak = (a: typeof patternMeta[number], b: typeof patternMeta[number]) => {
      if (a.hasPeakBreak !== b.hasPeakBreak) return a.hasPeakBreak ? 1 : -1
      if (a.hours !== b.hours) return b.hours - a.hours
      const aOverPref = a.maxBreak > MAX_BREAK_PREFERRED_HOURS ? 1 : 0
      const bOverPref = b.maxBreak > MAX_BREAK_PREFERRED_HOURS ? 1 : 0
      if (aOverPref !== bOverPref) return aOverPref - bOverPref
      return a.maxBreak - b.maxBreak
    }
    const sortedPatterns = [
      ...patternMeta.filter((p) => p.isMorning).sort(byLengthThenBreak),
      ...patternMeta.filter((p) => !p.isMorning).sort(byLengthThenBreak),
    ]

    // Rotate dispatcher order for variety (step 3 per day visits all positions)
    const rotationOffset = (dayIndex * 3) % dispatchers.length
    dayIndex++
    const rotated = [
      ...dispatchers.slice(rotationOffset),
      ...dispatchers.slice(0, rotationOffset),
    ]

    // Phase A — classify dispatchers into:
    //   blockedToday  — fully blocked by recurring/per-date time-off
    //   cappedToday   — already at 45 h this week (forced off, doesn't count
    //                   toward the 2-days-off cap, treated like time-off)
    //   availablePool — could work today
    const isWeekend = HEAVY_DAYS.has(dow)
    const blockedToday: typeof dispatchers = []
    const cappedToday: typeof dispatchers = []
    const availablePool: typeof dispatchers = []

    for (const d of rotated) {
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
      if (fullyBlocked) {
        blockedToday.push(d)
        weekOffDays[d.id][wLabel] = (weekOffDays[d.id][wLabel] ?? 0) + 1
        if (isWeekend) weekendOffTotal[d.id] += 1
      } else if ((weekHours[d.id][wLabel] ?? 0) >= WEEKLY_CAP_HOURS) {
        cappedToday.push(d)
      } else {
        availablePool.push(d)
      }
    }

    // Phase B — fairness pick: how many in availablePool to elect OFF today.
    // The day needs at most `patternsNeeded` dispatchers; everyone past that
    // is potentially off. Cap each dispatcher at MAX_DAYS_OFF_PER_WEEK total.
    const patternsNeeded = template.shiftPatterns.length
    const desiredElectedOff = Math.max(0, availablePool.length - patternsNeeded)

    const eligibleForOff = availablePool.filter(
      (d) => (weekOffDays[d.id][wLabel] ?? 0) < MAX_DAYS_OFF_PER_WEEK,
    )

    // On weekend days, weekend-off fairness leads (so everyone cycles through
    // Fri/Sat/Sun off-days regardless of which weekday they were off). On
    // weekdays, prefer those with fewest off-days this week so the week's
    // off-days are spread evenly. totalElectedOff breaks all final ties so
    // the same person isn't picked off every same-weekday.
    eligibleForOff.sort((a, b) => {
      if (isWeekend) {
        const wA = weekendOffTotal[a.id]
        const wB = weekendOffTotal[b.id]
        if (wA !== wB) return wA - wB
      }
      const dA = weekOffDays[a.id][wLabel] ?? 0
      const dB = weekOffDays[b.id][wLabel] ?? 0
      if (dA !== dB) return dA - dB
      return totalElectedOff[a.id] - totalElectedOff[b.id]
    })

    const electedOffIds = new Set(
      eligibleForOff.slice(0, desiredElectedOff).map((d) => d.id),
    )
    for (const id of electedOffIds) {
      weekOffDays[id][wLabel] = (weekOffDays[id][wLabel] ?? 0) + 1
      totalElectedOff[id] += 1
      if (isWeekend) weekendOffTotal[id] += 1
    }

    const offToday: typeof dispatchers = [
      ...availablePool.filter((d) => electedOffIds.has(d.id)),
      ...blockedToday,
    ]
    const cappedDispatchers = cappedToday
    const workingPool = availablePool.filter((d) => !electedOffIds.has(d.id))

    // Sort available dispatchers by ascending weekly hours → balances totals
    // Balance sort: prefer dispatchers cumulatively behind on the
    // schedule (totalHoursWorked ASC), with this-week hours as a
    // secondary tiebreak so within a week we still pull from the
    // least-loaded. Dispatchers are on fixed monthly salary so a tight
    // total-hours band is more important than perfectly equal weekly
    // hours — the cumulative tracker self-corrects drift week over week.
    const sortedWorking = [...workingPool].sort((a, b) => {
      const tA = totalHoursWorked[a.id], tB = totalHoursWorked[b.id]
      if (tA !== tB) return tA - tB
      return (weekHours[a.id][wLabel] ?? 0) - (weekHours[b.id][wLabel] ?? 0)
    })

    // Night-rest check: did this dispatcher work a night shift yesterday?
    const workedNightYesterday = (dispId: string) =>
      (lastSlotWorked[dispId][yesterday] ?? -1) >= NIGHT_SLOT_THRESHOLD

    // Greedy assignment: each pattern picks the best eligible dispatcher.
    // Constraint: if any Senior is available, ensure at least one is assigned.
    const hasSeniors = sortedWorking.some((d) => d.level === 'Senior')
    const usedIds = new Set<string>()
    const assignments: Array<{ dispatcher: (typeof dispatchers)[0]; pattern: boolean[] }> = []
    let seniorAssigned = false

    for (const p of sortedPatterns) {
      // Morning patterns exclude dispatchers who worked night yesterday.
      // Also exclude any dispatcher whose blocks overlap this pattern, and
      // any whose current weekly hours + this shift would push past the cap.
      const eligible = sortedWorking.filter((d) => {
        if (usedIds.has(d.id)) return false
        if (p.isMorning && workedNightYesterday(d.id)) return false
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        if (blocks && p.bool.some((on, i) => on && blocks[i])) return false
        if ((weekHours[d.id][wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) return false
        return true
      })
      if (eligible.length === 0) break

      // Hours-balance preference: prefer dispatchers whose post-shift weekly
      // hours stay at or below the soft target (38 h). This stops one
      // dispatcher from accumulating to 42-45 h while others sit at 30 h.
      // Falls back to all eligible if nobody fits (rare — usually means a
      // tight day where someone has to absorb the extra hours).
      const withinSoft = eligible.filter(
        (d) => (weekHours[d.id][wLabel] ?? 0) + p.hours <= SOFT_WEEKLY_TARGET,
      )
      const pickFrom = withinSoft.length > 0 ? withinSoft : eligible

      // If no Senior has been assigned yet and Seniors are available, promote
      // the least-hours Senior to the front of the candidate list.
      let dispatcher: (typeof dispatchers)[0]
      if (hasSeniors && !seniorAssigned) {
        const seniors = pickFrom.filter((d) => d.level === 'Senior')
        dispatcher = seniors.length > 0 ? seniors[0] : pickFrom[0]
      } else {
        dispatcher = pickFrom[0]
      }

      if (dispatcher.level === 'Senior') seniorAssigned = true
      assignments.push({ dispatcher, pattern: p.bool })
      usedIds.add(dispatcher.id)
    }

    // Coverage-aware swap pass: extend single-block shifts into peak-break
    // splits when adjacent slots are under-covered AND the peak slot we'd
    // break at is currently over-covered (slack to lend). This is what
    // lets michelle's Bridge 11a-5p become 9a-6p with a non-peak break
    // when 9-10a is missing a body and the dispatcher has the headroom.
    const dayRequired = effectiveCoverage(dow, coverageOverrides)
    coverageAwareSwapPass(assignments, dayRequired)
    coverageRequired[dateStr] = dayRequired

    // Dispatchers not assigned are off today
    const dayOff = [
      ...sortedWorking.filter((d) => !usedIds.has(d.id)),
      ...cappedDispatchers,
      ...offToday,
    ]

    // Accumulate coverage and build schedule entries
    const actualCov = new Array(SLOTS.length).fill(0)

    for (const { dispatcher, pattern } of assignments) {
      const hours = slotHours(pattern)
      weekHours[dispatcher.id][wLabel] = (weekHours[dispatcher.id][wLabel] ?? 0) + hours
      totalHoursWorked[dispatcher.id] += hours
      lastSlotWorked[dispatcher.id][dateStr] = lastActiveSlot(pattern)

      scheduleMap[dispatcher.id].push({
        date: dateStr, dayLabel, dayOfWeek: dow,
        slots: [...pattern], totalHours: hours, isOff: false,
      })

      pattern.forEach((on, si) => { if (on) actualCov[si]++ })
    }

    for (const dispatcher of dayOff) {
      scheduleMap[dispatcher.id].push({
        date: dateStr, dayLabel, dayOfWeek: dow,
        slots: new Array(SLOTS.length).fill(false),
        totalHours: 0, isOff: true,
      })
    }

    coverageActual[dateStr] = actualCov
  }

  // Build final DispatcherSchedule objects
  const dispatcherSchedules: DispatcherSchedule[] = dispatchers.map((d) => {
    const days = scheduleMap[d.id]
    const wh = weekHours[d.id]
    const totalHours = Object.values(wh).reduce((s, h) => s + h, 0)
    return { dispatcher: d, days, weeklyHours: wh, totalHours }
  })

  const dates = allDates.map((d) => ({
    date: format(d, 'yyyy-MM-dd'),
    dayLabel: format(d, 'EEE, MMMM do'),
    weekLabel: weekLabel(d),
    dayOfWeek: d.getDay(),
  }))

  return { startDate, endDate, seed, dates, dispatcherSchedules, coverageActual, coverageRequired }
}

// ---------------------------------------------------------------------------
// Coverage & colour helpers
// ---------------------------------------------------------------------------

/** Per-slot coverage tolerance band as a fraction of the target (15%). */
export const COVERAGE_GAP_TOLERANCE_PCT = 0.15

export function coverageTolerance(required: number): number {
  if (required <= 0) return 0
  return Math.max(1, Math.round(required * COVERAGE_GAP_TOLERANCE_PCT))
}

export type CoverageStatus = 'ok' | 'over' | 'mild' | 'short'

export function coverageStatus(actual: number, required: number): CoverageStatus {
  if (required === 0) return actual > 0 ? 'over' : 'ok'
  const diff = required - actual
  if (diff === 0) return 'ok'
  const tol = coverageTolerance(required)
  if (Math.abs(diff) <= tol) return 'mild'
  return diff > 0 ? 'short' : 'over'
}

export function hoursStatusColor(hours: number): string {
  if (hours > 45) return 'text-red-600'
  if (hours >= 36) return 'text-emerald-600'
  return 'text-amber-600'
}

export function hoursStatusBg(hours: number): string {
  if (hours > 45) return 'bg-red-100 text-red-700 border-red-200'
  if (hours >= 36) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  return 'bg-amber-100 text-amber-700 border-amber-200'
}
