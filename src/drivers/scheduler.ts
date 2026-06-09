import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DONOR_SLOTS,
  DRIVER_DAY_TEMPLATES,
  DRIVER_SLOTS,
  LEGAL_DAILY_MAX_HOURS,
  LEGAL_PT_WEEKLY_MAX_HOURS,
  LEGAL_WEEKLY_MAX_HOURS,
  LOW_PRIORITY_WEIGHT,
  MAX_HOURS_PER_DAY,
  OT_DAILY_BONUS,
  OT_FLEET_PCT,
  OT_WEEKLY_BONUS,
  SHOPPER_COVERAGE,
  USER_CAP_BUFFER_PCT,
  WEEKEND_SPLIT_PATTERN,
  effectiveCoverage,
  floorCoverageFor,
  isFloorPrioritySlot,
  isFloorSlot,
  isProtectedOpeningSlot,
  slotPriorityWeight,
} from './coverageTemplate'
import type {
  Driver,
  DriverDayEntry,
  DriverSchedule,
  DriverTimeOff,
  GeneratedDriverSchedule,
} from './types'

// ─── Minimum rest between consecutive shifts (12 hours) ────────────────
// Ops policy: a driver who finishes a shift must have at least MIN_REST_H
// hours off before starting the next one. With slot 0 = 8-9 AM and slot
// 14 = 10-11 PM (ending at 23:00), the math:
//   yesterday's end hour = 8 + lastSlot + 1 = 9 + lastSlot  (in 24h time)
//   today's start hour   = 8 + firstSlot                    (next day)
//   rest hours = 24 - (9 + lastSlot) + (8 + firstSlot)
//              = 23 + firstSlot - lastSlot
// So rest ≥ 12 ⇔ firstSlot ≥ lastSlot - 11.
//
// Example: closes at 11 PM (slot 14, ends 23:00). lastSlot=14, need
// firstSlot ≥ 3 (= 11 AM start). 11 PM → 11 AM = 12h ✓.
// Example: closes at 10 PM (slot 13, ends 22:00). lastSlot=13, need
// firstSlot ≥ 2 (= 10 AM start). 10 PM → 10 AM = 12h ✓.
//
// Replaces the previous coarse "(lastSlot ≥ 13) AND (firstSlot ≤ 2) →
// block" check, which over-blocked some valid 12h pairs and under-blocked
// some sub-12h ones (e.g. 9 PM close → 8 AM start = 11h, was allowed).
const MIN_REST_HOURS = 12

/** True when starting `firstSlot` the day after working through `lastSlot`
 *  would give less than MIN_REST_HOURS of rest. Returns false (allowed)
 *  when either slot is invalid. */
function violatesMinRest(lastSlot: number, firstSlot: number): boolean {
  if (lastSlot < 0 || firstSlot < 0) return false
  const restHours = 23 + firstSlot - lastSlot
  return restHours < MIN_REST_HOURS
}

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

/** True if the pattern has at least one "off" slot between its first and
 *  last "on" slot — i.e. there's a real break in the middle. */
function patternHasBreak(p: boolean[]): boolean {
  const first = firstActive(p)
  const last = lastActive(p)
  if (first < 0 || last <= first) return false
  for (let i = first + 1; i < last; i++) if (!p[i]) return true
  return false
}

// ─── Shift-shape rules ───────────────────────────────────────────────────
// Per ops policy on shift block shapes (every day, every driver):
//   - Every contiguous work block must be >= 3 hours. No 1- or 2-hour
//     blocks. This applies to BOTH halves of a split shift — a 1h trailing
//     block from a donor swap is the bug that triggered the rule.
//   - The break between two work blocks within a day must be <= 3 hours.
//     The standard weekend split-shift break (13:00–16:00 = 3h) is exactly
//     the ceiling. Anything longer is "two separate shifts" by ops' read.
//   - At most ONE break per day — i.e. <= 2 work blocks total. A shift
//     can be continuous (1 block) or split (2 blocks), never three pieces.
//
// Total day length is a separate rule (>= 4h) enforced upstream via
// effectiveMin = max(4, minHoursPerDay) at every pattern-selection site.
// The orphan-filler 3h patterns were deleted from coverageTemplate.ts
// so a future relaxation of effectiveMin can't accidentally re-enable
// a 3h day.
export const MIN_BLOCK_HOURS = 3
export const MAX_BREAK_HOURS = 3
export const MAX_BLOCKS_PER_DAY = 2

/** Walk a slot bitmap and return every contiguous work block as
 *  `[startSlotIdx, endSlotIdx]` inclusive. Empty array for an off day. */
export function workBlocks(slots: boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let s = -1
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] && s < 0) s = i
    else if (!slots[i] && s >= 0) { out.push([s, i - 1]); s = -1 }
  }
  if (s >= 0) out.push([s, slots.length - 1])
  return out
}

/** True when the slot bitmap violates ANY of the shift-shape rules:
 *  sub-3h block, >3h break, or more than 2 blocks. Off days never
 *  violate (no blocks, no rules to apply). */
export function violatesShape(slots: boolean[]): boolean {
  const b = workBlocks(slots)
  if (b.length === 0) return false
  if (b.length > MAX_BLOCKS_PER_DAY) return true
  for (const [s, e] of b) {
    if (e - s + 1 < MIN_BLOCK_HOURS) return true
  }
  for (let i = 1; i < b.length; i++) {
    const gap = b[i][0] - b[i - 1][1] - 1
    if (gap > MAX_BREAK_HOURS) return true
  }
  return false
}

/**
 * Score multiplier for a protected opening slot (8/9/10 AM) that is
 * still BELOW its hard floor — 80% on Sat/Sun, 65% weekdays. Returns
 * 1.0 when the slot has reached or passed the floor, or isn't an
 * opening slot. Returns OPENING_BELOW_FLOOR_BOOST otherwise.
 *
 * Used by main-pass, Phase 6, and Phase 8 scoring to make the
 * optimizer aggressively chase under-floor opening slots, even at the
 * cost of overstaffing peaks slightly. Self-regulates: as soon as the
 * slot reaches floor the boost flips back to 1.0, so we don't overshoot.
 *
 * 10× was chosen so an opening slot's contribution (raw 100 × weight
 * 3.0 × boost 10 = 3000) dominates a peak slot's contribution (raw
 * 100 × weight 2.5 × 1 = 250) by roughly 10×, ensuring the opening
 * always wins when it's under floor.
 */
const OPENING_BELOW_FLOOR_BOOST = 10
function openingFloorBoost(
  dow: number,
  slot: number,
  currentCov: number,
  target: number,
): number {
  if (!isProtectedOpeningSlot(dow, slot)) return 1
  if (target <= 0) return 1
  const floor = floorCoverageFor(target, dow, slot)
  return currentCov < floor ? OPENING_BELOW_FLOOR_BOOST : 1
}

// Build-time sanity check: assert every pattern in the pools conforms
// to the shape rules. Catches a future pool edit (or template tweak)
// that would silently produce an illegal shape. Runs once at module
// load — cheap, no runtime cost per generation.
;(() => {
  const seen = new Set<string>()
  const dump = (label: string, p: number[] | boolean[]) => {
    const bools = p.map((v) => !!v)
    const key = label + ':' + bools.map((v) => (v ? '1' : '0')).join('')
    if (seen.has(key)) return
    seen.add(key)
    if (violatesShape(bools)) {
      throw new Error(`Shift-shape rule violated in pattern pool: ${label} ${bools.map((v) => (v ? '1' : '0')).join('')}`)
    }
  }
  for (const dow of Object.keys(DRIVER_DAY_TEMPLATES)) {
    const tpl = DRIVER_DAY_TEMPLATES[Number(dow)]
    for (const p of tpl.shiftPatterns) dump(`dow=${dow}`, p)
  }
  dump('WEEKEND_SPLIT_PATTERN', WEEKEND_SPLIT_PATTERN)
})()

/** Minimum shift length above which a break (≥1h) is required.
 *  Legal/ops rule: ANY 8h+ shift must include at least one hour of
 *  break. Applies to drivers and shoppers uniformly — the previous
 *  9h-driver / 8h-shopper split was relaxed too far on the driver
 *  side; ops escalated it to 8h-for-all. */
function breakRequiredAt(_d: Driver): number {
  return 8
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
  drivers: allDrivers,
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
  // Drivers with `pendingAvailability` are deferred: they stay in the
  // roster but the generator pretends they don't exist for THIS run.
  // The schedule output appends them back at the end as all-off rows so
  // the UI keeps showing them with a "Pending availability" banner,
  // and ops can flip the flag off + slot them in via
  // `addDriverIncremental` once availability arrives — no full
  // regenerate required.
  const pendingDrivers = allDrivers.filter((d) => d.pendingAvailability)
  const drivers = allDrivers.filter((d) => !d.pendingAvailability)
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

  // ─── Closer cap (Layer 2 of the morning-shortfall fix) ─────────────────
  // Drivers whose shift ENDS at slot ≥ CLOSER_END_THRESHOLD (10 PM end)
  // can't open the next morning under the 12h rest rule — they'd need
  // to start no earlier than 10 AM. So every additional "closer" eats
  // into the pool of drivers available to staff the 9 AM target.
  //
  // Approach: count closers per date by SCANNING scheduleMap on demand
  // (every placement/extension checks the live count). Costs O(drivers)
  // per check but avoids the bookkeeping bugs that a manually-maintained
  // counter accumulates across 8 mutation sites (main pass + Phase 1, 2,
  // 3, 4, 5, 6, 8). The main pass also adds a per-pattern score penalty
  // for the 21st+ closer to bias placement toward earlier-ending
  // alternatives at the source.
  const CLOSER_END_THRESHOLD = 13
  const MAX_CLOSERS_PER_NIGHT = 20
  const CLOSER_OVERAGE_PENALTY = 10000

  function countClosersOn(dateStr: string): number {
    let n = 0
    for (const id of Object.keys(scheduleMap)) {
      const entry = scheduleMap[id].find((e) => e.date === dateStr)
      if (!entry || entry.isOff) continue
      let last = -1
      for (let z = entry.slots.length - 1; z >= 0; z--) {
        if (entry.slots[z]) { last = z; break }
      }
      if (last >= CLOSER_END_THRESHOLD) n++
    }
    return n
  }

  function dayHasMorningOpening(dow: number): boolean {
    const r = effectiveCoverage((dow + 1) % 7, coverageScale, coverageOverrides)
    return r[0] + r[1] + r[2] > 0
  }

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

  // Deterministically shuffled driver order, used as the rotation base.
  // The simple `(dayIndex % drivers.length)` rotation only cycles through
  // 14 indices (one per iteration day) — on rosters bigger than 14, drivers
  // beyond that slice NEVER get "first pick" and end up systematically
  // bottom-of-queue. Real-roster data on 88-driver snapshots showed A-C
  // drivers averaging 78-82h/2wk vs D+ averaging 65h — purely a position-in-
  // array bias from alphabetical CSV imports.
  //
  // Shuffling once at the start (seeded so Regenerate is reproducible)
  // breaks the bias: the rotation now walks a randomized order, so
  // "first pick" is spread fairly across the whole pool.
  function fnv1a(str: string): number {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  const shuffledDrivers = [...drivers].sort((a, b) =>
    fnv1a(a.id + ':' + seed) - fnv1a(b.id + ':' + seed)
  )

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

    /** Last slot the driver worked yesterday (−1 if off / not scheduled). */
    const yesterdaysLastSlot = (id: string) =>
      lastSlotWorked[id][yesterday] ?? -1

    /** First slot of TOMORROW's shift, if already placed in scheduleMap.
     *  Returns −1 when tomorrow hasn't been processed yet (slowest-first
     *  iteration means today's "tomorrow" may already be in scheduleMap)
     *  or when tomorrow is OFF. Used by the main pass to enforce 12h
     *  rest BOTH directions, not just against yesterday. */
    const tomorrow = format(addDays(date, 1), 'yyyy-MM-dd')
    const tomorrowsFirstSlot = (id: string): number => {
      const entry = scheduleMap[id].find((e) => e.date === tomorrow)
      if (!entry || entry.isOff) return -1
      return entry.slots.findIndex((s) => s)
    }

    // Per ops policy: every workday must be at least 4 hours. No
    // 3h orphan-filler shortcuts, even on the last work-week day.
    // Drivers with only a 3h sliver of remaining cap just leave the
    // sliver unused — better than placing a too-short shift.
    const effectiveMin = Math.max(4, minHoursPerDay)

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
      // Rotate the SHUFFLED order by `dayIndex * stride` so each day's
      // "first pick" lands at a different EVENLY-SPACED point in the pool,
      // not adjacent. With contiguous `dayIndex % len` rotation, dayIndex
      // only reaches 14 distinct positions over a 2-week schedule — on
      // rosters of 88 drivers, that left positions 14+ stuck at the bottom
      // of every queue. Stride-based rotation (stride ≈ len / 14) walks
      // through 14 widely-separated positions so each driver-section gets
      // their turn at "first pick" once over the schedule horizon.
      // Combined with the seeded shuffle above this eliminates the residual
      // "drivers at top of array win" bias.
      const len = shuffledDrivers.length
      const stride = len > 0 ? Math.max(1, Math.ceil(len / 14)) : 1
      const offset = len > 0 ? (dayIndex * stride) % len : 0
      const rotated = [...shuffledDrivers.slice(offset), ...shuffledDrivers.slice(0, offset)]
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
          if (violatesMinRest(yesterdaysLastSlot(d.id), firstActive(p))) continue
          // Rest check against tomorrow too, in case tomorrow was already
          // placed by a higher-priority earlier iteration (Mon/Tue often
          // get scheduled before Sun under slowest-first order).
          {
            const tFirst = tomorrowsFirstSlot(d.id)
            if (tFirst >= 0 && violatesMinRest(lastActive(p), tFirst)) continue
          }
          if (blocks && p.some((on, i) => on && blocks[i])) continue  // pattern conflicts with blocked slot
          // Long-shift break rule (drivers 9h+, shoppers 8h+). Reject any
          // continuous pattern at or past the driver's threshold.
          if (h >= breakRequiredAt(d) && !patternHasBreak(p)) continue

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

          // Score = base contribution × per-slot priority weight + most-
          // starved-slot priority boost. The weight multiplier (peak
          // boost, slow-zone dampening) lives in coverageTemplate.ts —
          // a 3 PM slot has weight 0.3 so filling it earns less, while
          // a Fri 6 PM peak has weight 2.5 so filling it earns more.
          // Shoppers use weight 1.0 across the board (they're scored
          // against the SHOPPER pool, not driver coverage targets).
          let score = 0
          for (let s = 0; s < p.length; s++) {
            if (!p[s]) continue
            // Below-floor boost: when a protected opening slot (8-10 AM
            // on weekends, with the stricter 80% floor) is still below
            // its hard floor, multiply this slot's contribution by 10×.
            // Self-regulates: once the slot reaches floor, boost is 1×.
            // Lets the optimizer aggressively chase openers even when a
            // longer 9 AM-start pattern would otherwise win on peak-slot
            // sum. Shoppers don't get the boost (separate pool, no floor).
            const boost = d.isShopper ? 1 : openingFloorBoost(dow, s, myCov[s], myReq[s])
            const w = (d.isShopper ? 1 : slotPriorityWeight(dow, s)) * boost
            if (myShort[s] > 0) {
              const t = myReq[s] || myShort[s]
              score += w * (myShort[s] * 10 + (myShort[s] / t) * 50)
            } else {
              const overage = myCov[s] - myReq[s]
              if (overage > 0) score -= overage * 700
              else score += w  // base "spare-fill" bonus, weighted
            }
          }
          for (let s = 0; s < p.length; s++) {
            if (p[s] && myPriority[s] > 0) {
              const boost = d.isShopper ? 1 : openingFloorBoost(dow, s, myCov[s], myReq[s])
              const w = (d.isShopper ? 1 : slotPriorityWeight(dow, s)) * boost
              score += w * myPriority[s] * 20
            }
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
          // Layer 1 — Opening-floor penalty. Scoped to the PROTECTED
          // opening slots (8-10 AM) because those are the slots that
          // were getting drained to feed peaks. Penalizing every floor
          // slot would make every pattern score deeply negative on
          // busy days (sum of unfilled peak shortfalls dominates), so
          // the main pass would refuse to place patterns at all.
          // Restricting to opening slots gives the algorithm the bias
          // we want — pull drivers into morning — without nuking the
          // rest of the day's scoring.
          const OPENING_FLOOR_PENALTY = 1500
          if (!d.isShopper) {
            for (let s = 0; s < p.length; s++) {
              if (!isProtectedOpeningSlot(dow, s)) continue
              const stillShortAfter = myReq[s] - (myCov[s] + (p[s] ? 1 : 0))
              if (stillShortAfter > 0) score -= OPENING_FLOOR_PENALTY * stillShortAfter
            }
          }
          // Layer 2 — Closer-cap penalty. If this pattern ENDS at slot
          // ≥ 13 (closer) AND the next day has positive morning targets,
          // dock the score once we've already booked MAX_CLOSERS_PER_NIGHT
          // closers for today. Effect: the 21st+ closer pays a steep
          // cost, so the algorithm picks a shorter-end equivalent pattern
          // for that driver — keeping them rest-eligible to open tomorrow.
          if (!d.isShopper && lastActive(p) >= CLOSER_END_THRESHOLD && dayHasMorningOpening(dow)) {
            const closersSoFar = countClosersOn(dateStr)
            const overQuota = Math.max(0, closersSoFar + 1 - MAX_CLOSERS_PER_NIGHT)
            if (overQuota > 0) score -= CLOSER_OVERAGE_PENALTY * overQuota
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
  // Iterates shuffledDrivers so cap-fill doesn't reintroduce alphabetical
  // bias by always processing A-named drivers first.

  // ─── Re-sort scheduleMap into calendar order BEFORE Phase 1+ ───────────
  // The main pass appends entries in slowest-first iteration order (e.g.
  // Wed,Tue,Thu,Mon,Fri,Sat,Sun) — NOT calendar order. Phase 1+ scan
  // each driver's entry list and assume `[i-1]` is yesterday and `[i+1]`
  // is tomorrow for night-rest / shift-extension checks. If we don't
  // sort, those checks compare against the wrong neighbor and the strict
  // 12h rest rule produces violations the algorithm thought it was
  // avoiding. Sort once here so every later phase sees a canonical
  // calendar-ordered schedule.
  for (const id of Object.keys(scheduleMap)) {
    scheduleMap[id].sort((a, b) => a.date.localeCompare(b.date))
  }

  for (const d of shuffledDrivers) {
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
      // Per ops policy: every workday is at least 4 hours. No 3h
      // orphan-filler shifts even when they'd help close peak gaps —
      // ops rejected those because they were too short to be worth
      // dispatching a driver for.
      const minShift = 4
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
        {
          const yest = scheduleMap[d.id][i - 1]
          if (yest && !yest.isOff) {
            if (violatesMinRest(lastActive(yest.slots), firstActive(p))) continue
          }
          const tomorrow = scheduleMap[d.id][i + 1]
          if (tomorrow && !tomorrow.isOff) {
            const tFirst = tomorrow.slots.findIndex(x => x)
            if (tFirst >= 0 && violatesMinRest(lastActive(p), tFirst)) continue
          }
        }
        if (blocks && p.some((on, idx) => on && blocks[idx])) continue
        let exceeds = false
        let weightedHelps = 0
        for (let s = 0; s < p.length; s++) {
          if (!p[s]) continue
          if (cov[s] + 1 > required[s] + fillTolerance(required[s])) { exceeds = true; break }
          if (required[s] - cov[s] > 0) weightedHelps += slotPriorityWeight(dow, s)
        }
        if (exceeds) continue
        // Prefer patterns that fill the most weighted-under-target slots
        // (peak slots count more than slow slots). Tie-break: shorter
        // pattern (saves cap for other off-days).
        const score = weightedHelps * 10 - h
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
  // Iterates shuffledDrivers so the extend pass doesn't favor early-
  // alphabet drivers when distributing the leftover +1h hours.
  for (const d of shuffledDrivers) {
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
        // Ops rule: long shifts MUST include a break (≥1h). Drivers at 9h+,
        // shoppers at 8h+ (stricter — on-feet grocery work). If extending
        // would push this shift past the threshold while still continuous,
        // refuse — the algorithm should pick a different driver or just
        // leave the gap.
        if (currentHours + 1 >= breakRequiredAt(d) && !patternHasBreak(slots)) break

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
          // Closer-cap check: if the extension would turn this driver
          // into a closer (newLast ≥ CLOSER_END_THRESHOLD) AND the day
          // already has ≥ MAX_CLOSERS_PER_NIGHT closers AND tomorrow
          // has morning targets, refuse. Prevents Phase 2 from quietly
          // pushing the closer pool past the cap the main pass enforced.
          if (!d.isShopper) {
            const currentLast = lastActive(slots)
            const newLast = Math.max(s, currentLast)
            const isClosingExtension = newLast >= CLOSER_END_THRESHOLD && currentLast < CLOSER_END_THRESHOLD
            if (isClosingExtension && dayHasMorningOpening(dow) && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue
          }
          // Min-rest check: extending the END of today's shift may shrink
          // rest before TOMORROW's start, extending the START may shrink
          // rest after YESTERDAY's end. Check both directions because
          // Phase 2 can pick either side of the existing shift.
          {
            const tomorrow = scheduleMap[d.id][i + 1]
            if (tomorrow && !tomorrow.isOff) {
              const tFirst = tomorrow.slots.findIndex(x => x)
              const newLast = Math.max(s, lastActive(slots))
              if (violatesMinRest(newLast, tFirst)) continue
            }
          }
          {
            const yest = scheduleMap[d.id][i - 1]
            if (yest && !yest.isOff) {
              const yLast = lastActive(yest.slots)
              const newFirst = Math.min(s, slots.findIndex(x => x))
              if (violatesMinRest(yLast, newFirst)) continue
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
        // Ops rule: 8h+ shifts MUST include a break (uniform for drivers
        // and shoppers). If extending into OT would push a still-continuous
        // shift past 8h, skip — OT bonus waits for another driver whose
        // shift can absorb the extra hour.
        if (currentHours + 1 >= breakRequiredAt(d) && !patternHasBreak(slots)) continue
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
          // 12h rest check both directions — Phase 3 extends either side.
          {
            const entryIdx = scheduleMap[d.id].indexOf(entry)
            const tomorrow = scheduleMap[d.id][entryIdx + 1]
            if (tomorrow && !tomorrow.isOff) {
              const tFirst = tomorrow.slots.findIndex(x => x)
              const newLast = Math.max(s, last)
              if (violatesMinRest(newLast, tFirst)) continue
            }
            const yest = scheduleMap[d.id][entryIdx - 1]
            if (yest && !yest.isOff) {
              const yLast = lastActive(yest.slots)
              const newFirst = Math.min(s, first)
              if (violatesMinRest(yLast, newFirst)) continue
            }
          }
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
          // 12h rest with TOMORROW.
          const pLast = lastActive(p)
          {
            const tomorrow = scheduleMap[d.id][dayIdx + 1]
            if (tomorrow && !tomorrow.isOff && violatesMinRest(pLast, firstActive(tomorrow.slots))) continue
          }
          // 12h rest with YESTERDAY.
          const pFirst = firstActive(p)
          {
            const yest = scheduleMap[d.id][dayIdx - 1]
            if (yest && !yest.isOff) {
              const yLast = lastActive(yest.slots)
              if (violatesMinRest(yLast, pFirst)) continue
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

  // ─── Phase 5 of cap-fill: NARROW GAP-FILLER (last resort) ───────────────
  // After Phases 1-4, real-roster diagnostics show a residual pattern:
  // a target slot (e.g. 7-8 PM) is still short by 1-2 bodies AND has plenty
  // of headroom under its own +15% ceiling, BUT every pattern that covers
  // it also touches an adjacent slot already AT the +15% ceiling — so the
  // strict over-cap check rejects all candidates and the gap stays open
  // even with 27 idle drivers having cap remaining.
  //
  // This pass is the escape valve. For each day with residual shortfall:
  //   1. Walk off-day drivers (who didn't take a shift today) with cap
  //      remaining and < 6 days worked this week.
  //   2. Try patterns that cover AT LEAST ONE shortfall slot.
  //   3. Accept if the net SHORTFALL REDUCTION > 0 — even if the pattern
  //      pushes a non-shortfall slot past +15%, the absolute hard cap
  //      here is +30% (so we never silently double-staff).
  //   4. Prefer SHORTER patterns (3-5h) to minimize over-coverage damage.
  //
  // This phase is intentionally narrow — it only fires when the strict
  // phases have given up, and only for drivers who're sitting idle.
  const narrowFillTolerance = (req: number) => req <= 0 ? 0 : Math.max(1, Math.round(req * 0.30))
  for (let dayIdx = 0; dayIdx < allDates.length; dayIdx++) {
    const date = allDates[dayIdx]
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const wLabel = weekLabel(date)
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    const template = DRIVER_DAY_TEMPLATES[dow]

    // Compute current shortfall — bail if day is fully covered.
    const shortfallSlots = new Set<number>()
    for (let s = 0; s < required.length; s++) {
      if (required[s] - cov[s] > 0) shortfallSlots.add(s)
    }
    if (shortfallSlots.size === 0) continue

    // Limit narrow-fill patterns to 3-5h to minimize over-coverage damage.
    const narrowPatterns = template.shiftPatterns
      .map(raw => raw.map(v => v === 1))
      .filter(p => {
        const h = slotHours(p)
        // Per ops policy: 4h minimum shift. Phase 5 still keeps the
        // upper bound narrow (≤5h) to minimize over-coverage damage.
        return h >= 4 && h <= 5
      })

    // Try to place narrow shifts until shortfall stops shrinking.
    let safety = 50
    while (safety-- > 0) {
      // Recompute shortfall each iteration.
      let totalShort = 0
      for (let s = 0; s < required.length; s++) totalShort += Math.max(0, required[s] - cov[s])
      if (totalShort === 0) break

      let bestDriver: Driver | null = null
      let bestPattern: boolean[] | null = null
      let bestReduction = 0

      for (const d of drivers) {
        if (d.isShopper) continue  // shoppers tracked separately
        // Only place on a driver's OFF day (don't disrupt existing shifts).
        const entry = scheduleMap[d.id][dayIdx]
        if (!entry || !entry.isOff) continue
        if ((daysWorked[d.id][wLabel] ?? 0) >= MAX_DAYS_PER_WEEK) continue
        const cap = bufferedCapOf(d)
        const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
        if (remaining < 4) continue  // 4h-min policy
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        if (blocks && blocks.length > 0 && blocks.every(Boolean)) continue
        // Min-rest lookup against yesterday's close and tomorrow's start.
        const yest = scheduleMap[d.id][dayIdx - 1]
        const yestLast = (yest && !yest.isOff) ? lastActive(yest.slots) : -1
        const tomorrow = scheduleMap[d.id][dayIdx + 1]
        const tomorrowFirst = (tomorrow && !tomorrow.isOff) ? tomorrow.slots.findIndex(x => x) : -1

        for (const p of narrowPatterns) {
          const h = slotHours(p)
          if (h > remaining) continue
          if (h > Math.min(maxHoursPerDay + 1, LEGAL_DAILY_MAX_HOURS)) continue
          if (blocks && p.some((on, i) => on && blocks[i])) continue
          if (violatesMinRest(yestLast, firstActive(p))) continue
          if (tomorrowFirst >= 0 && violatesMinRest(lastActive(p), tomorrowFirst)) continue

          // Check that the pattern actually fills a shortfall slot.
          let touchesShortfall = false
          for (let s = 0; s < p.length; s++) {
            if (p[s] && shortfallSlots.has(s)) { touchesShortfall = true; break }
          }
          if (!touchesShortfall) continue

          // Compute hard +30% absolute ceiling — never silently double-staff.
          let exceedsAbsolute = false
          let reduction = 0
          for (let s = 0; s < p.length; s++) {
            if (!p[s]) continue
            if (cov[s] + 1 > required[s] + narrowFillTolerance(required[s])) {
              exceedsAbsolute = true
              break
            }
            if (required[s] - cov[s] > 0) reduction++
          }
          if (exceedsAbsolute) continue
          if (reduction === 0) continue

          // Prefer SHORTER patterns at equal reduction (less over-coverage damage).
          // Score: reduction × 100 - hours.
          const score = reduction * 100 - h
          if (score > bestReduction) {
            bestReduction = score
            bestDriver = d
            bestPattern = p
          }
        }
      }

      if (!bestDriver || !bestPattern) break

      // Apply: replace OFF entry with the new shift.
      const entry = scheduleMap[bestDriver.id][dayIdx]
      const h = slotHours(bestPattern)
      entry.isOff = false
      entry.slots = [...bestPattern]
      entry.totalHours = h
      weekHours[bestDriver.id][wLabel] = (weekHours[bestDriver.id][wLabel] ?? 0) + h
      daysWorked[bestDriver.id][wLabel] = (daysWorked[bestDriver.id][wLabel] ?? 0) + 1
      for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) cov[s]++
      lastSlotWorked[bestDriver.id][dateStr] = lastActive(bestPattern)
      // Recompute shortfall set for next iteration.
      shortfallSlots.clear()
      for (let s = 0; s < required.length; s++) {
        if (required[s] - cov[s] > 0) shortfallSlots.add(s)
      }
    }
  }

  // ─── Phase 6: SPREAD pass — eliminate "3+ days off" ─────────────────────
  // On surplus-capacity rosters (e.g. 78 FT drivers with ~2300h demand),
  // the main pass picks ~30 drivers per day and stops once each day's
  // coverage is met. Late-alphabet drivers (D15, D6, etc.) end up with
  // 3-4 days worked while early-alphabet drivers (Adip, Bobby, etc.)
  // hit 6 days. The rotation only helps with ties — once a driver lags
  // a few hours behind, ascending-hours sort keeps picking them on slow
  // days only, leaving them stranded on busy ones.
  //
  // This pass forces SPREAD: any driver with remaining cap and < 6 days
  // worked gets a SHORT (4-5h) shift placed on one of their off-days,
  // even when the day is fully covered, as long as it doesn't push
  // slots past the standard +25% over-cap (or +50% on busy days).
  //
  // The user's explicit rules:
  //   "No driver should have 3+ days off" — drivers fill empty days
  //   until they hit 6.
  //   "Busy days (Fri/Sat/Sun/Thu) should run over coverage" — Phase 6
  //   walks off-days in priority order so busy days fill first.
  //   "Drivers with spare cap should improve yellow slow-day slots" —
  //   slow days also receive spread (after busy days saturate).
  // Spread tolerance is +25% — looser than the main pass's +15% because
  // by the time Phase 6 runs, many slots are already at or near +15% from
  // Phase 5's gap-filling. The hard absolute cap is +30% (matches Phase 5)
  // so spread fairness wins over coverage strictness, but never blows past
  // double-staffing.
  // Standard spread tolerance is +25%, but on BUSY days (Fri/Sat/Sun/Thu)
  // ops wants visibly over-staffed coverage — loosen the per-slot ceiling
  // to +50% so 4-5h patterns can land on busy days even when adjacent
  // slots are already at the +25% standard ceiling. Without this, peak
  // slots like Sat 6-7 PM stay at-target because every pattern covering
  // them also touches a saturated 5 PM / 8 PM slot.
  const spreadFillTol = (req: number) => req <= 0 ? 0 : Math.max(1, Math.round(req * 0.25))
  const busySpreadFillTol = (req: number) => req <= 0 ? 0 : Math.max(2, Math.round(req * 0.50))
  // Ops-defined busy-day priority. Sorting off-days by this DESC means
  // surplus drivers land on Fri/Sat/Sun/Thu before Mon/Tue/Wed, so the
  // busy days end up visibly over-staffed (gray "over" status) instead
  // of barely-at-target.
  //
  // User: "Our busy days are Thu/Fri/Sat/Sun. In order: 1 Friday, 2
  // Saturday, 3 Sunday, 4 Thursday. We can prioritize these days to
  // have more people than the coverage target."
  //
  // Within a priority tier, fall back to total template demand so
  // higher-demand days still win ties. Mon/Tue/Wed get priority 0
  // and are filled last (and rarely, since busy days absorb most
  // surplus first).
  const BUSY_DAY_PRIORITY: Record<number, number> = {
    5: 100,  // Friday  — busiest
    6:  80,  // Saturday
    0:  60,  // Sunday
    4:  40,  // Thursday
    1:   0,  // Mon
    2:   0,  // Tue
    3:   0,  // Wed
  }
  const dayDemand = new Map<string, number>()
  const dayPriority = new Map<string, number>()
  for (const date of allDates) {
    const dow = date.getDay()
    const sum = effectiveCoverage(dow, coverageScale, coverageOverrides).reduce((a, b) => a + b, 0)
    const dateStr = format(date, 'yyyy-MM-dd')
    dayDemand.set(dateStr, sum)
    // Composite: explicit ops priority (×1000) + raw demand for tie-break.
    dayPriority.set(dateStr, BUSY_DAY_PRIORITY[dow] * 1000 + sum)
  }
  for (const d of shuffledDrivers) {
    if (d.isShopper) continue  // shoppers already work all 6 non-Sundays
    // Walk this driver's off-days in OPS-PRIORITY order so spare capacity
    // lands on busy days (Fri/Sat/Sun/Thu) first.
    const offEntryIndexes = scheduleMap[d.id]
      .map((e, idx) => ({ idx, priority: e.isOff ? (dayPriority.get(e.date) ?? 0) : -1 }))
      .filter(x => x.priority >= 0)
      .sort((a, b) => b.priority - a.priority)
      .map(x => x.idx)
    for (const i of offEntryIndexes) {
      const entry = scheduleMap[d.id][i]
      if (!entry.isOff) continue  // may have been filled by an earlier iteration
      const dateStr = entry.date
      const dow = entry.dayOfWeek
      const wLabel = weekLabel(parseISO(dateStr))
      const currentDays = daysWorked[d.id][wLabel] ?? 0
      if (currentDays >= MAX_DAYS_PER_WEEK) continue
      // Allow up to 6 days per week on ANY day (not just busy days).
      // Per user feedback: drivers with 2 days off and spare weekly cap
      // should improve coverage on the still-yellow slow-day slots, not
      // sit idle. The priority order above (Fri > Sat > Sun > Thu >
      // slow days) ensures busy days fill FIRST — slow days only
      // receive a driver's 6th day once busy days hit their +50%
      // ceiling. PT drivers naturally stop at 5 days because their
      // 30h cap is used up.
      const isBusyDay = (BUSY_DAY_PRIORITY[dow] ?? 0) > 0
      const cap = bufferedCapOf(d)
      const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
      if (remaining < 4) continue  // 4h-min policy
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks && blocks.length > 0 && blocks.every(Boolean)) continue

      const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
      const cov = coverageActual[dateStr]
      const template = DRIVER_DAY_TEMPLATES[dow]

      // Short patterns only (4-5h) — minimizes over-coverage damage.
      // 4h is the policy minimum; 5h ceiling keeps Phase 6 from
      // ballooning into long shifts that should've come from the
      // main pass.
      let bestPattern: boolean[] | null = null
      let bestScore = -Infinity
      for (const raw of template.shiftPatterns) {
        const p = raw.map(v => v === 1)
        const h = slotHours(p)
        if (h < 4 || h > 5) continue
        if (h > remaining) continue
        if (blocks && p.some((on, idx) => on && blocks[idx])) continue
        // 12h rest with yesterday's close and tomorrow's start.
        {
          const yest = scheduleMap[d.id][i - 1]
          if (yest && !yest.isOff && violatesMinRest(lastActive(yest.slots), firstActive(p))) continue
        }
        {
          const tomorrow = scheduleMap[d.id][i + 1]
          if (tomorrow && !tomorrow.isOff) {
            const tFirst = tomorrow.slots.findIndex(x => x)
            if (tFirst >= 0 && violatesMinRest(lastActive(p), tFirst)) continue
          }
        }
        // Closer-cap: Phase 6 places NEW shifts on off-days. If the new
        // pattern ends ≥ CLOSER_END_THRESHOLD and today's closer count is
        // already at the cap AND tomorrow has morning targets, skip.
        if (lastActive(p) >= CLOSER_END_THRESHOLD
            && dayHasMorningOpening(dow)
            && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue
        let exceeds = false
        let slotScore = 0
        // Busy days get the looser +50% ceiling so peak slots (which are
        // sandwiched between already-saturated 5 PM / 8 PM slots) can
        // still be filled.
        const tolFn = isBusyDay ? busySpreadFillTol : spreadFillTol
        const standardTol = (req: number) =>
          req <= 0 ? 0 : Math.max(1, Math.round(req * 0.15))
        for (let s = 0; s < p.length; s++) {
          if (!p[s]) continue
          if (cov[s] + 1 > required[s] + tolFn(required[s])) { exceeds = true; break }
          // Score each slot the pattern touches based on its current
          // coverage status (matches UI color buckets), THEN multiply by
          // the per-slot priority weight so peak slots (weight 2.5 on Fri
          // 12-2/6-8 PM) are preferentially filled and slow slots
          // (weight 0.3 at 3 PM) are passively avoided. Apply the
          // below-floor boost so under-floor opening slots dominate the
          // score and Phase 6 lands openers when they're available.
          const w = slotPriorityWeight(dow, s) * openingFloorBoost(dow, s, cov[s], required[s])
          const diff = cov[s] - required[s]  // pos = over, 0 = at, neg = short
          let raw: number
          if (diff < 0) raw = 100
          else if (diff === 0) raw = 30
          else if (diff <= standardTol(required[s])) raw = 20
          else raw = 1
          slotScore += raw * w
        }
        if (exceeds) continue
        // Final score: per-slot weighted score minus length (prefer shorter
        // among equally-valuable patterns).
        const score = slotScore - h
        if (score > bestScore) {
          bestScore = score
          bestPattern = p
        }
      }
      if (!bestPattern) continue

      // Apply.
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

  // ─── Phase 6.5: TIGHT-WEEK 2nd day-off elimination ──────────────────────
  // When ANY floor slot in a work-week is below target, drivers should
  // not idle a 2nd day off — their hours can help close the gap. Phase 6
  // already eliminates 3+ days off, but only when a 4-5h pattern fits
  // under the standard +25%/+50% over-coverage ceiling. In tight weeks,
  // those ceilings are exactly what's stopping drivers from being placed
  // (every pattern hits an over-target slot). Phase 6.5 walks 2-day-off
  // drivers in tight weeks and assigns them a short shift with a relaxed
  // ceiling — patterns may push adjacent slots past the standard
  // tolerance as long as the pattern lands at least one body on a
  // currently-short slot.
  //
  // Hard rules preserved: weekly cap (buffered), 6-day max, 4h-min shift,
  // 12h rest, time-off blocks, break rule, closer cap. Only the soft
  // over-coverage ceiling is relaxed.
  //
  // Skipped entirely on weeks that are NOT tight (every floor slot >= target)
  // — those drivers KEEP their 2-day weekend per ops policy.
  const weekIsTight = (wLabel: string): boolean => {
    for (const di of allDates) {
      if (weekLabel(di) !== wLabel) continue
      const dateStr = format(di, 'yyyy-MM-dd')
      const dow = di.getDay()
      const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
      const cov = coverageActual[dateStr]
      if (!cov) continue
      for (let s = 0; s < required.length; s++) {
        if (!isFloorSlot(dow, s)) continue
        if (required[s] > (cov[s] ?? 0)) return true
      }
    }
    return false
  }
  // Cache so we don't re-scan the whole week for every driver.
  const tightWeekCache = new Map<string, boolean>()
  const isTight = (wLabel: string): boolean => {
    if (!tightWeekCache.has(wLabel)) tightWeekCache.set(wLabel, weekIsTight(wLabel))
    return tightWeekCache.get(wLabel)!
  }
  // Per-slot ceiling for Phase 6.5: tighter than spread's +50% on adjacent
  // slots but loose enough that "every pattern touches a saturated slot"
  // (the symptom Phase 6 stalls on) gets unstuck. +75% on the cushion
  // slots, with the constraint that the pattern MUST hit at least one
  // currently-short slot to actually help.
  const tightFillTol = (req: number) =>
    req <= 0 ? 0 : Math.max(2, Math.round(req * 0.75))
  for (const d of shuffledDrivers) {
    if (d.isShopper) continue
    // Walk weeks the driver has rosters in. daysWorked entries are keyed
    // by weekLabel, so the union of those keys is all the weeks the driver
    // touches.
    for (const wLabel of Object.keys(daysWorked[d.id])) {
      if (!isTight(wLabel)) continue
      const currentDays = daysWorked[d.id][wLabel] ?? 0
      // < 5 days worked == >= 2 days off. == 5 means 1 day off (OK).
      if (currentDays >= MAX_DAYS_PER_WEEK - 1) continue

      // Walk this driver's off-days in the tight week, sorted by total
      // shortfall on that date (highest deficit first) so the new shift
      // lands where it helps most.
      const offEntryIndexes = scheduleMap[d.id]
        .map((e, idx) => {
          if (!e.isOff) return { idx, deficit: -1 }
          if (weekLabel(parseISO(e.date)) !== wLabel) return { idx, deficit: -1 }
          const dow = e.dayOfWeek
          const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
          const cov = coverageActual[e.date] ?? []
          let deficit = 0
          for (let s = 0; s < required.length; s++) {
            const d2 = required[s] - (cov[s] ?? 0)
            if (d2 > 0 && isFloorSlot(dow, s)) deficit += d2
          }
          return { idx, deficit }
        })
        .filter(x => x.deficit > 0)
        .sort((a, b) => b.deficit - a.deficit)
        .map(x => x.idx)

      for (const i of offEntryIndexes) {
        const entry = scheduleMap[d.id][i]
        if (!entry.isOff) continue
        // Re-check days worked — earlier iteration may have moved us to 5.
        if ((daysWorked[d.id][wLabel] ?? 0) >= MAX_DAYS_PER_WEEK - 1) break

        const dateStr = entry.date
        const dow = entry.dayOfWeek
        const cap = bufferedCapOf(d)
        const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
        if (remaining < 4) break  // out of capacity in this week
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        if (blocks && blocks.length > 0 && blocks.every(Boolean)) continue

        const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
        const cov = coverageActual[dateStr]
        const template = DRIVER_DAY_TEMPLATES[dow]

        // 4-6h patterns — wider than Phase 6's 4-5h since this is the
        // emergency lever, not the routine spread.
        let bestPattern: boolean[] | null = null
        let bestScore = -Infinity
        for (const raw of template.shiftPatterns) {
          const p = raw.map(v => v === 1)
          const h = slotHours(p)
          if (h < 4 || h > 6) continue
          if (h > remaining) continue
          if (blocks && p.some((on, idx) => on && blocks[idx])) continue
          {
            const yest = scheduleMap[d.id][i - 1]
            if (yest && !yest.isOff && violatesMinRest(lastActive(yest.slots), firstActive(p))) continue
          }
          {
            const tomorrow = scheduleMap[d.id][i + 1]
            if (tomorrow && !tomorrow.isOff) {
              const tFirst = tomorrow.slots.findIndex(x => x)
              if (tFirst >= 0 && violatesMinRest(lastActive(p), tFirst)) continue
            }
          }
          if (lastActive(p) >= CLOSER_END_THRESHOLD
              && dayHasMorningOpening(dow)
              && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue

          // RELAXED ceiling. Pattern must (a) hit at least one
          // currently-short FLOOR slot to actually help, and (b) stay
          // within the relaxed +75% ceiling on every slot it touches.
          let exceeds = false
          let helpsShort = false
          let slotScore = 0
          for (let s = 0; s < p.length; s++) {
            if (!p[s]) continue
            if (cov[s] + 1 > required[s] + tightFillTol(required[s])) { exceeds = true; break }
            const w = slotPriorityWeight(dow, s) * openingFloorBoost(dow, s, cov[s], required[s])
            const diff = cov[s] - required[s]
            if (diff < 0 && isFloorSlot(dow, s)) { helpsShort = true }
            let raw: number
            if (diff < 0) raw = 200          // short — what we're after
            else if (diff === 0) raw = 30
            else raw = 1                     // over-target — discouraged
            slotScore += raw * w
          }
          if (exceeds || !helpsShort) continue
          const score = slotScore - h        // prefer shorter among equals
          if (score > bestScore) {
            bestScore = score
            bestPattern = p
          }
        }
        if (!bestPattern) continue

        // Apply.
        const h = slotHours(bestPattern)
        entry.isOff = false
        entry.slots = [...bestPattern]
        entry.totalHours = h
        weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + h
        daysWorked[d.id][wLabel] = (daysWorked[d.id][wLabel] ?? 0) + 1
        for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) cov[s]++
        lastSlotWorked[d.id][dateStr] = lastActive(bestPattern)
        // Tight-week cache may flip stale now that we placed a shift.
        // Cheap to re-query later; just invalidate this week.
        tightWeekCache.delete(wLabel)
        // Only fill ONE additional day per loop iteration so the cache
        // recomputes between placements. The outer driver loop will
        // pick this driver up again on the next pass if the week is
        // still tight AND they still have <5 days.
        break
      }
    }
  }

  // ─── Phase 7: TRIM SURPLUS — bring over-cap drivers back to user cap ────
  // After Phases 1-6 some drivers run between user cap and the +10% buffer
  // (e.g. cap=40 → 41-44h). When coverage is already over-staffed on the
  // slots their shifts cover, those extra hours aren't BUYING anything —
  // they just push payroll past the user's preferred cap. Phase 7 walks
  // over-cap drivers and trims 1h at a time from start/end of shifts where
  // the trimmed slot would stay AT OR ABOVE its coverage target (no new
  // shortfall created).
  //
  // Matches user's manual workflow on real rosters:
  //   D10: 90h → 81h by trimming early/late slots from 5 shifts
  //   D7:  90h → 81h same pattern
  //   Shakti Pandey: 89h → 81h
  //   Etoye Barnes: 86h → 80h
  //
  // Constraints:
  //   - never reduce a shift below 4h (policy minimum)
  //   - never trim a slot whose coverage would drop below target (no
  //     new shortfall)
  //   - prefer trimming slots with the LARGEST current over-coverage
  //     (least valuable hours)
  //   - shoppers untouched (their coverage is a parallel pool)
  for (const d of shuffledDrivers) {
    if (d.isShopper) continue
    const userCap = capOf(d)  // user-set cap, NOT buffered
    for (const wLabel of Object.keys(weekHours[d.id])) {
      let safety = 50
      while (safety-- > 0) {
        if ((weekHours[d.id][wLabel] ?? 0) <= userCap) break

        // Search every shift in this work-week for the best trim candidate.
        let bestEntry: DriverDayEntry | null = null
        let bestSide: 'first' | 'last' | null = null
        let bestSlotIdx = -1
        let bestOver = -1
        for (const entry of scheduleMap[d.id]) {
          if (entry.isOff) continue
          if (weekLabel(parseISO(entry.date)) !== wLabel) continue
          const h = (entry.totalHours ?? entry.slots.filter(Boolean).length)
          if (h <= 4) continue  // 4h-min policy: can't trim further
          const required = effectiveCoverage(entry.dayOfWeek, coverageScale, coverageOverrides)
          const cov = coverageActual[entry.date]
          const first = entry.slots.findIndex(s => s)
          let last = -1
          for (let z = entry.slots.length - 1; z >= 0; z--) if (entry.slots[z]) { last = z; break }

          // Build the post-trim candidate for each side so we can also
          // shape-check it. A trim that shrinks the boundary block
          // below 3h must be refused even when coverage allows it,
          // per the new shift-shape rules.
          const trimCandidate = (sideSlot: number): boolean[] => {
            const cand = [...entry.slots]
            cand[sideSlot] = false
            return cand
          }

          // First-side trim: would the first slot stay AT or ABOVE target?
          const fOver = cov[first] - required[first]
          if (fOver >= 1 && !violatesShape(trimCandidate(first))) {
            // Score by current over-coverage — trim the most-over slots first.
            if (fOver > bestOver) {
              bestOver = fOver
              bestEntry = entry
              bestSide = 'first'
              bestSlotIdx = first
            }
          }
          // Last-side trim: same check.
          if (last !== first) {
            const lOver = cov[last] - required[last]
            if (lOver >= 1 && !violatesShape(trimCandidate(last))) {
              if (lOver > bestOver) {
                bestOver = lOver
                bestEntry = entry
                bestSide = 'last'
                bestSlotIdx = last
              }
            }
          }
        }

        if (!bestEntry || bestSlotIdx < 0) break  // nothing safe to trim

        // Apply the trim.
        bestEntry.slots[bestSlotIdx] = false
        bestEntry.totalHours = (bestEntry.totalHours ?? 0) - 1
        coverageActual[bestEntry.date][bestSlotIdx]--
        weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) - 1
        // Update lastSlotWorked if we trimmed the last slot.
        if (bestSide === 'last') {
          let newLast = -1
          for (let z = bestEntry.slots.length - 1; z >= 0; z--) if (bestEntry.slots[z]) { newLast = z; break }
          lastSlotWorked[d.id][bestEntry.date] = newLast
        }
      }
    }
  }

  // ─── Phase 8: PUSH UNDER-CAP — extend shifts of under-cap drivers ───────
  // Snap10 diagnosis: 18 FT drivers at cap, 64 under cap. The under-cap
  // drivers all had 6 × 6.5h shifts averaging 39h. Root cause: Phase 2
  // extension ran BEFORE Phase 6 added their 6th day, so the newly-added
  // 6th-day shifts never got the +1h treatment.
  //
  // Phase 8 mirrors Phase 7 in reverse — for every driver under their user
  // cap with cap-room and coverage room, extend their shifts (+1h at start
  // or end) until at user cap or no safe extension exists. Uses Phase 6's
  // slot-status scoring so the new hours go to yellow slots first (still
  // under +15% ceiling), pushing them into gray over-staff territory the
  // user explicitly asked for.
  const pushFillTol = (req: number) =>
    req <= 0 ? 0 : Math.max(1, Math.round(req * 0.25))
  const pushBusyTol = (req: number) =>
    req <= 0 ? 0 : Math.max(2, Math.round(req * 0.50))
  const yellowTol = (req: number) =>
    req <= 0 ? 0 : Math.max(1, Math.round(req * 0.15))
  for (const d of shuffledDrivers) {
    if (d.isShopper) continue
    const userCap = capOf(d)
    for (const wLabel of Object.keys(weekHours[d.id])) {
      let safety = 60
      while (safety-- > 0) {
        const remaining = userCap - (weekHours[d.id][wLabel] ?? 0)
        if (remaining <= 0) break

        // Walk every shift in this work-week, pick the (entry, slot) that
        // maximizes slot-status score (yellow > at-target > gray).
        let bestEntry: DriverDayEntry | null = null
        let bestSlotIdx = -1
        let bestScore = -Infinity
        for (let idx = 0; idx < scheduleMap[d.id].length; idx++) {
          const entry = scheduleMap[d.id][idx]
          if (entry.isOff) continue
          if (weekLabel(parseISO(entry.date)) !== wLabel) continue
          const slots = entry.slots
          const h = slots.filter(Boolean).length
          if (h >= maxHoursPerDay + 1) continue       // soft daily max
          if (h >= LEGAL_DAILY_MAX_HOURS) continue    // legal daily max
          // Break rule (drivers 9h+, shoppers 8h+).
          if (h + 1 >= breakRequiredAt(d) && !patternHasBreak(slots)) continue

          const dow = entry.dayOfWeek
          const isBusyDay = (BUSY_DAY_PRIORITY[dow] ?? 0) > 0
          const tolFn = isBusyDay ? pushBusyTol : pushFillTol
          const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
          const cov = coverageActual[entry.date]
          const blocks = blockedBitmap(timeOff, d, entry.date, dow)
          const first = slots.findIndex(s => s)
          let last = -1
          for (let z = slots.length - 1; z >= 0; z--) if (slots[z]) { last = z; break }
          const tries: number[] = []
          if (first > 0) tries.push(first - 1)
          if (last >= 0 && last < slots.length - 1) tries.push(last + 1)

          for (const s of tries) {
            if (required[s] <= 0) continue                    // outside ops hours
            if (blocks && blocks[s]) continue                 // driver-blocked slot
            if (cov[s] + 1 > required[s] + tolFn(required[s])) continue
            // Closer-cap: if this extension would turn the driver into
            // a new closer (newLast crosses CLOSER_END_THRESHOLD) AND
            // today's closer count is at the cap AND tomorrow has
            // morning targets, skip. Mirrors the Phase 2 check.
            {
              const currentLast = last
              const newLast = Math.max(s, currentLast)
              const isClosingExtension = newLast >= CLOSER_END_THRESHOLD && currentLast < CLOSER_END_THRESHOLD
              if (isClosingExtension
                  && dayHasMorningOpening(dow)
                  && countClosersOn(entry.date) >= MAX_CLOSERS_PER_NIGHT) continue
            }
            // 12h rest BOTH directions — Phase 8 can extend either side
            // of the existing shift (start earlier OR end later), so we
            // need to check against yesterday's close AND tomorrow's start.
            {
              const tomorrow = scheduleMap[d.id][idx + 1]
              if (tomorrow && !tomorrow.isOff) {
                const tFirst = tomorrow.slots.findIndex(x => x)
                const newLast = Math.max(s, lastActive(slots))
                if (tFirst >= 0 && violatesMinRest(newLast, tFirst)) continue
              }
              const yest = scheduleMap[d.id][idx - 1]
              if (yest && !yest.isOff) {
                const yLast = lastActive(yest.slots)
                const newFirst = Math.min(s, slots.findIndex(x => x))
                if (violatesMinRest(yLast, newFirst)) continue
              }
            }
            // Score by current coverage status × per-slot priority weight.
            // Status buckets: SHORT 100 / OK 30 / MILD 20 / OVER 1.
            // Weight: peak slots (Fri 12-2/6-8 PM = 2.5) pull spare cap
            // toward them; slow slots (3 PM = 0.3) get nearly ignored.
            // Below-floor opening boost amplifies the per-slot weight
            // on under-floor opening slots so Phase 8 push lands the
            // extra hour on 8/9/10 AM ahead of peak slots.
            const w = slotPriorityWeight(dow, s) * openingFloorBoost(dow, s, cov[s], required[s])
            const diff = cov[s] - required[s]
            let raw: number
            if (diff < 0) raw = 100
            else if (diff === 0) raw = 30
            else if (diff <= yellowTol(required[s])) raw = 20
            else raw = 1
            const slotScore = raw * w
            if (slotScore > bestScore) {
              bestScore = slotScore
              bestEntry = entry
              bestSlotIdx = s
            }
          }
        }

        if (!bestEntry || bestSlotIdx < 0) break

        // Apply the extension.
        const prevLast = lastActive(bestEntry.slots)
        bestEntry.slots[bestSlotIdx] = true
        bestEntry.totalHours = (bestEntry.totalHours ?? 0) + 1
        coverageActual[bestEntry.date][bestSlotIdx]++
        weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + 1
        if (bestSlotIdx > (lastSlotWorked[d.id][bestEntry.date] ?? -1)) {
          lastSlotWorked[d.id][bestEntry.date] = bestSlotIdx
        }
        void prevLast  // closer count is recomputed on demand, no manual track
      }
    }
  }

  // ─── Phase 8.5: WEEKEND SPLIT-SHIFT FALLBACK ────────────────────────
  //
  // Sat/Sun ONLY. Conservative dual-peak filler: when a weekend day
  // has BOTH a morning slot shortfall AND an evening slot shortfall,
  // assign the 10h split pattern (08:00-13:00 + 16:00-21:00, 3h
  // midday break) to one off-day driver per shortfall pair. One
  // driver covers both peaks instead of needing two separate hires.
  //
  // Strictly last-resort:
  //   - Pattern lives in coverageTemplate.WEEKEND_SPLIT_PATTERN, NOT
  //     in WEEKEND_PATTERNS. Main pass, spread, push never see it.
  //   - Number of splits per day = min(morningShort, eveningShort).
  //     If only one peak is short, NO splits happen — a regular
  //     half-shift from Phase 6/8 would already have fixed it.
  //   - Loop exits as soon as the cap is hit.
  //
  // Uses standard helpers (rest, cap, blocks, break, days-worked) so
  // every legality check matches Phase 6/8. The 3h break exceeds the
  // 2h "policy max" baked into the regular pool, but that policy is
  // enforced only by NOT putting 3h-break patterns in the pool —
  // this phase is the documented opt-in path.
  //
  // Manual 14:00-break variants (per user spec) are NOT generated
  // here, but admin slot-toggles in the day grid let ops produce
  // any custom split without restriction.
  const WEEKEND_DOWS = new Set([6, 0])  // Sat=6, Sun=0
  const SPLIT_MORNING_SLOTS = WEEKEND_SPLIT_PATTERN
    .map((v, i) => (v === 1 && i < 6 ? i : -1))
    .filter((i) => i >= 0)
  const SPLIT_EVENING_SLOTS = WEEKEND_SPLIT_PATTERN
    .map((v, i) => (v === 1 && i >= 6 ? i : -1))
    .filter((i) => i >= 0)
  const SPLIT_HOURS = WEEKEND_SPLIT_PATTERN.filter((v) => v === 1).length
  const SPLIT_FIRST = WEEKEND_SPLIT_PATTERN.findIndex((v) => v === 1)
  const SPLIT_LAST = (() => {
    for (let z = WEEKEND_SPLIT_PATTERN.length - 1; z >= 0; z--) {
      if (WEEKEND_SPLIT_PATTERN[z] === 1) return z
    }
    return -1
  })()

  for (const di of allDates) {
    const dow = di.getDay()
    if (!WEEKEND_DOWS.has(dow)) continue
    const dateStr = format(di, 'yyyy-MM-dd')
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    if (!cov) continue

    // How short is each half relative to target — clamped at 0. The
    // "max shortfall in the half" is what matters because the split
    // adds 1 body to EVERY slot in that half. If morning has slots
    // [0:0, 1:short by 2, 2:short by 3], the half's effective deficit
    // is 3 — and adding one split-driver covers all of those slots
    // simultaneously (reduces all shortfalls by 1 each).
    const morningShort = SPLIT_MORNING_SLOTS
      .map((s) => Math.max(0, required[s] - (cov[s] ?? 0)))
      .reduce((a, b) => Math.max(a, b), 0)
    const eveningShort = SPLIT_EVENING_SLOTS
      .map((s) => Math.max(0, required[s] - (cov[s] ?? 0)))
      .reduce((a, b) => Math.max(a, b), 0)
    let splitsNeeded = Math.min(morningShort, eveningShort)
    if (splitsNeeded <= 0) continue   // single-peak gap → not our problem

    for (const d of shuffledDrivers) {
      if (splitsNeeded <= 0) break
      if (d.isShopper) continue                   // shopper pool — separate
      const entry = scheduleMap[d.id].find((e) => e.date === dateStr)
      if (!entry) continue
      // Only convert an OFF day OR a short morning-only shift that
      // ends ≤ slot 4 (12 PM). Anything later already covers the
      // split's morning half — converting it would just shuffle hours.
      if (!entry.isOff) {
        if (lastActive(entry.slots) > 4) continue
      }

      const wLabel = weekLabel(parseISO(dateStr))
      const cap = bufferedCapOf(d)
      // Net hours change: remove existing shift's paid hours (if any),
      // add the 10h split.
      const existingH = entry.isOff ? 0 : (entry.totalHours ?? 0)
      const newWeeklyTotal = (weekHours[d.id][wLabel] ?? 0) - existingH + SPLIT_HOURS
      if (newWeeklyTotal > cap) continue

      // Day-count check. Converting an OFF day to a split adds 1
      // day worked; converting an existing short shift to a split
      // doesn't change the count.
      const wouldAddDay = entry.isOff
      const daysAfter = (daysWorked[d.id][wLabel] ?? 0) + (wouldAddDay ? 1 : 0)
      if (daysAfter > MAX_DAYS_PER_WEEK) continue

      // Block check — none of the split's active slots can be
      // blocked for this driver on this date.
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks) {
        let conflict = false
        for (let s = 0; s < WEEKEND_SPLIT_PATTERN.length; s++) {
          if (WEEKEND_SPLIT_PATTERN[s] === 1 && blocks[s]) { conflict = true; break }
        }
        if (conflict) continue
      }

      // 12h rest checks against neighbors. Yesterday's last slot
      // must give 12h+ rest before this driver starts at slot 0
      // (08:00). Tomorrow's first slot must give 12h+ rest after
      // this driver ends at slot 12 (21:00).
      const idx = scheduleMap[d.id].indexOf(entry)
      const yest = idx > 0 ? scheduleMap[d.id][idx - 1] : null
      if (yest && !yest.isOff) {
        const yLast = lastActive(yest.slots)
        if (violatesMinRest(yLast, SPLIT_FIRST)) continue
      }
      const tomorrow = idx + 1 < scheduleMap[d.id].length ? scheduleMap[d.id][idx + 1] : null
      if (tomorrow && !tomorrow.isOff) {
        const tFirst = tomorrow.slots.findIndex((s) => s)
        if (tFirst >= 0 && violatesMinRest(SPLIT_LAST, tFirst)) continue
      }

      // Apply the split. Replace the day's slots wholesale with
      // WEEKEND_SPLIT_PATTERN, update weekly hours / days-worked /
      // lastSlotWorked, then bump coverageActual on every newly-
      // active slot (and decrement on any slot that the OLD entry
      // had but the new split doesn't — only morning-only shifts
      // can hit this case, and only on slots 1-4).
      const oldSlots = [...entry.slots]
      const newSlots = WEEKEND_SPLIT_PATTERN.map((v) => v === 1)
      entry.isOff = false
      entry.slots = newSlots
      entry.totalHours = SPLIT_HOURS
      weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) - existingH + SPLIT_HOURS
      if (wouldAddDay) {
        daysWorked[d.id][wLabel] = (daysWorked[d.id][wLabel] ?? 0) + 1
      }
      lastSlotWorked[d.id][dateStr] = SPLIT_LAST
      for (let s = 0; s < newSlots.length; s++) {
        if (newSlots[s] && !oldSlots[s]) cov[s] = (cov[s] ?? 0) + 1
        else if (!newSlots[s] && oldSlots[s]) cov[s] = Math.max(0, (cov[s] ?? 0) - 1)
      }
      splitsNeeded--
    }
  }

  // ─── Phase 9: MORNING-EXTEND — backward-extend shifts to fill opening
  // floor gaps (Sat/Sun 8 AM, Sat/Sun 9 AM, etc.) ─────────────────────
  //
  // After Phases 1-8, opening slots can still be short because: (a) the
  // 12h rest rule bars prior-night closers from opening early, AND (b)
  // even drivers who COULD open are often assigned to start at 9 AM or
  // later (the highest-scoring pattern wasn't an 8 AM starter).
  //
  // This phase walks each date with floor-slot opening shortfall and,
  // for each shortfall slot in order [8a, 9a, 10a], finds drivers whose
  // current shift STARTS at the next-later slot and extends them
  // backward by 1h. Specifically targets Sat/Sun 8 AM (the only day-
  // type with required[0] > 0) and the broader 9-10 AM gaps too.
  //
  // Constraints honored at every extension:
  //   - within bufferedCapOf(d) for the week
  //   - within maxHoursPerDay + 1 soft daily ceiling
  //   - 8h+ break rule (refuses if extension creates 8h+ continuous)
  //   - 12h rest with yesterday's close
  //   - driver not blocked at the target slot
  //   - shopper rule (no Sunday work)
  //
  // Per slot, extends drivers in shuffledDrivers order (no alphabetical
  // bias) and stops as soon as the slot reaches target.
  const OPENING_SLOTS_TO_FILL = [0, 1, 2]  // 8 AM, 9 AM, 10 AM
  for (const di of allDates) {
    const dateStr = format(di, 'yyyy-MM-dd')
    const dow = di.getDay()
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    if (!cov) continue

    for (const targetSlot of OPENING_SLOTS_TO_FILL) {
      if (required[targetSlot] <= 0) continue
      let shortfall = required[targetSlot] - (cov[targetSlot] ?? 0)
      if (shortfall <= 0) continue

      // Find candidate drivers: those whose shift on this date STARTS
      // at targetSlot + 1 (so extending backward by 1 covers targetSlot).
      // Iterating shuffled order so we don't favor early-alphabet drivers.
      for (const d of shuffledDrivers) {
        if (shortfall <= 0) break
        // Skip shoppers entirely — they belong to a parallel pool
        // (groceries) and don't count toward DRIVER coverage. Extending
        // a shopper here would still bump `cov[targetSlot]` below
        // (polluting driver-coverage with shopper hours) AND wouldn't
        // help the actual gap.
        if (d.isShopper) continue

        const entry = scheduleMap[d.id].find((e) => e.date === dateStr)
        if (!entry || entry.isOff) continue
        const first = entry.slots.findIndex((s) => s)
        if (first !== targetSlot + 1) continue   // shift doesn't start adjacent to gap

        // Capacity check: extension adds 1h to weekly hours.
        const wLabel = weekLabel(parseISO(dateStr))
        const cap = bufferedCapOf(d)
        if ((weekHours[d.id][wLabel] ?? 0) + 1 > cap) continue

        // Daily-hour check: Phase 9 allows up to LEGAL_DAILY_MAX_HOURS +
        // OT_DAILY_BONUS (10h) because the floor slot would otherwise
        // stay structurally short — even drivers at the 9h soft cap
        // can give the extra hour. Shows up as daily OT in the UI
        // (purple pill in the hour cell on the day-grid), so payroll sees it.
        const newHours = (entry.totalHours ?? 0) + 1
        if (newHours > Math.min(maxHoursPerDay + 1, LEGAL_DAILY_MAX_HOURS + OT_DAILY_BONUS, MAX_HOURS_PER_DAY)) continue

        // Block check: driver mustn't be blocked at targetSlot.
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        if (blocks && blocks[targetSlot]) continue

        // Break rule: if extension makes shift 8h+, must already have a
        // break in the existing pattern (since we're only adding 1h at
        // the start, the post-extension shift inherits the original's
        // break state — but if it was 7h-continuous and becomes 8h-
        // continuous, the rule fires).
        if (newHours >= breakRequiredAt(d) && !patternHasBreak(entry.slots)) continue

        // 12h rest with yesterday's close: extending earlier brings the
        // start time forward, so rest with yesterday's last slot shrinks.
        const yest = scheduleMap[d.id].find((e) => {
          const ed = parseISO(e.date)
          const expected = addDays(parseISO(dateStr), -1)
          return format(ed, 'yyyy-MM-dd') === format(expected, 'yyyy-MM-dd')
        })
        if (yest && !yest.isOff) {
          const yLast = lastActive(yest.slots)
          if (violatesMinRest(yLast, targetSlot)) continue
        }

        // Apply the backward-extension.
        entry.slots[targetSlot] = true
        entry.totalHours = newHours
        cov[targetSlot]++
        weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + 1
        shortfall--
      }
    }
  }

  // ─── Phase 10: 40% COVERAGE FLOOR enforcement ───────────────────────────
  // Hard rule: no priority floor slot (opening 8-11 AM, lunch/dinner peaks,
  // closing 10 PM — every floor slot EXCEPT the 3-4 PM donor window) may
  // finish below 40% of its target. Concretely: a slot with target 5 must
  // close >= 2; a slot with target 36 must close >= 15.
  //
  // Three strategies, applied in order to the deepest-deficit floor slot
  // first (the slot that's furthest below 40%):
  //   (A) Aggressive shift extension — extend an adjacent shift (back OR
  //       forward) onto the violation slot, bypassing every soft over-
  //       coverage ceiling. Hard rules (cap, daily max, 12h rest, blocks,
  //       break) still enforced.
  //   (B) Aggressive off-day shift add — place a 4-5h shift on an off-day
  //       driver that includes the violation slot, same hard-rule
  //       enforcement, no over-coverage ceiling.
  //   (C) Cross-day swap from donor slots — find a driver who's working a
  //       donor slot (3 PM or 4 PM) on some date in the same week and CAN
  //       legally extend onto the violation slot. Remove their donor hour
  //       there, add an hour at the violation. Keeps weekly hours flat.
  //
  // Anything still below 40% after (A)+(B)+(C) is reported as
  // headcount-limited in the banner.
  const FLOOR_DAILY_HOUR_MAX = Math.min(
    maxHoursPerDay + 1,
    LEGAL_DAILY_MAX_HOURS + OT_DAILY_BONUS,
    MAX_HOURS_PER_DAY,
  )
  // Try (A) — adjacent extension — on a single (date, slot). Returns true
  // if it placed at least one driver. Loops drivers in shuffle order so
  // the load distributes across the roster.
  const tryAdjacentExtend = (dateStr: string, dow: number, slot: number): boolean => {
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    for (const d of shuffledDrivers) {
      if (d.isShopper && dow === 0) continue
      if (d.isShopper) continue   // shopper coverage is a parallel pool
      const idx = scheduleMap[d.id].findIndex((e) => e.date === dateStr)
      if (idx < 0) continue
      const entry = scheduleMap[d.id][idx]
      if (entry.isOff) continue                // off-day path = strategy (B)
      if (entry.slots[slot]) continue          // already covering slot
      const first = entry.slots.findIndex((s) => s)
      let last = -1
      for (let z = entry.slots.length - 1; z >= 0; z--) if (entry.slots[z]) { last = z; break }
      // Only extend if the violation slot is directly adjacent — slot
      // gaps would break the contiguous-shift invariant.
      if (slot !== first - 1 && slot !== last + 1) continue
      const wLabel = weekLabel(parseISO(dateStr))
      const cap = bufferedCapOf(d)
      if ((weekHours[d.id][wLabel] ?? 0) + 1 > cap) continue
      const newHours = (entry.totalHours ?? 0) + 1
      if (newHours > FLOOR_DAILY_HOUR_MAX) continue
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks && blocks[slot]) continue
      // Break rule: extension makes shift 8h+, must already have a break.
      if (newHours >= breakRequiredAt(d) && !patternHasBreak(entry.slots)) continue
      // 12h rest: backward extension shrinks rest with yesterday;
      // forward extension shrinks rest with tomorrow.
      if (slot < first) {
        const yest = scheduleMap[d.id][idx - 1]
        if (yest && !yest.isOff) {
          const yLast = lastActive(yest.slots)
          if (violatesMinRest(yLast, slot)) continue
        }
      } else {
        const tomorrow = scheduleMap[d.id][idx + 1]
        if (tomorrow && !tomorrow.isOff) {
          const tFirst = tomorrow.slots.findIndex((s) => s)
          if (tFirst >= 0 && violatesMinRest(slot, tFirst)) continue
        }
      }
      // Closer-cap: forward extension past CLOSER_END_THRESHOLD.
      if (slot >= CLOSER_END_THRESHOLD && last < CLOSER_END_THRESHOLD
          && dayHasMorningOpening(dow)
          && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue

      entry.slots[slot] = true
      entry.totalHours = newHours
      cov[slot] = (cov[slot] ?? 0) + 1
      weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + 1
      if (slot > (lastSlotWorked[d.id][dateStr] ?? -1)) {
        lastSlotWorked[d.id][dateStr] = slot
      }
      void required
      return true
    }
    return false
  }
  // Try (B) — off-day shift add. Picks a 4-5h pattern that includes the
  // violation slot, bypasses over-coverage ceilings entirely. Returns
  // true if it placed one.
  const tryOffDayShift = (dateStr: string, dow: number, slot: number): boolean => {
    const template = DRIVER_DAY_TEMPLATES[dow]
    for (const d of shuffledDrivers) {
      if (d.isShopper) continue
      const idx = scheduleMap[d.id].findIndex((e) => e.date === dateStr)
      if (idx < 0) continue
      const entry = scheduleMap[d.id][idx]
      if (!entry.isOff) continue
      const wLabel = weekLabel(parseISO(dateStr))
      const currentDays = daysWorked[d.id][wLabel] ?? 0
      if (currentDays >= MAX_DAYS_PER_WEEK) continue
      const cap = bufferedCapOf(d)
      const remaining = cap - (weekHours[d.id][wLabel] ?? 0)
      if (remaining < 4) continue
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks && blocks[slot]) continue

      // Pick the shortest pattern (4-5h) that COVERS the violation slot
      // and passes hard-rule checks. Skip patterns that don't touch
      // `slot` since those don't help.
      let bestPattern: boolean[] | null = null
      let bestHours = Infinity
      for (const raw of template.shiftPatterns) {
        const p = raw.map(v => v === 1)
        const h = slotHours(p)
        if (h < 4 || h > 5) continue
        if (h > remaining) continue
        if (!p[slot]) continue
        if (blocks && p.some((on, sIdx) => on && blocks[sIdx])) continue
        {
          const yest = scheduleMap[d.id][idx - 1]
          if (yest && !yest.isOff && violatesMinRest(lastActive(yest.slots), firstActive(p))) continue
        }
        {
          const tomorrow = scheduleMap[d.id][idx + 1]
          if (tomorrow && !tomorrow.isOff) {
            const tFirst = tomorrow.slots.findIndex(x => x)
            if (tFirst >= 0 && violatesMinRest(lastActive(p), tFirst)) continue
          }
        }
        if (lastActive(p) >= CLOSER_END_THRESHOLD
            && dayHasMorningOpening(dow)
            && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue
        if (h < bestHours) { bestHours = h; bestPattern = p }
      }
      if (!bestPattern) continue

      const h = bestHours
      entry.isOff = false
      entry.slots = [...bestPattern]
      entry.totalHours = h
      weekHours[d.id][wLabel] = (weekHours[d.id][wLabel] ?? 0) + h
      daysWorked[d.id][wLabel] = (daysWorked[d.id][wLabel] ?? 0) + 1
      const cov = coverageActual[dateStr]
      for (let s = 0; s < bestPattern.length; s++) if (bestPattern[s]) cov[s]++
      lastSlotWorked[d.id][dateStr] = lastActive(bestPattern)
      return true
    }
    return false
  }
  // Try (C) — donor-slot swap. Find a driver covering a 3 PM or 4 PM
  // donor slot on the violation date who can adjacently-extend onto the
  // violation slot — net hours unchanged.
  const tryDonorSwap = (dateStr: string, dow: number, slot: number): boolean => {
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    for (const d of shuffledDrivers) {
      if (d.isShopper) continue
      const idx = scheduleMap[d.id].findIndex((e) => e.date === dateStr)
      if (idx < 0) continue
      const entry = scheduleMap[d.id][idx]
      if (entry.isOff) continue
      if (entry.slots[slot]) continue                // already covers violation
      // Driver must currently cover one of the donor slots.
      let donorSlot = -1
      for (const ds of DONOR_SLOTS) {
        if (entry.slots[ds]) { donorSlot = ds; break }
      }
      if (donorSlot < 0) continue
      // The trimmed donor slot must stay >= floor of its target — though
      // donor slots have no floor by definition, we still gate on
      // "target > 0 AND would go below target by more than 1" to avoid
      // collapsing it entirely. (3 PM target is usually present but low.)
      const trimmedCov = (cov[donorSlot] ?? 0) - 1
      if (required[donorSlot] > 0 && trimmedCov < 0) continue
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      if (blocks && blocks[slot]) continue
      // The new shift after swap. Build candidate slot array: remove
      // donor slot, add violation slot. Then validate against the
      // full shift-shape rules (min-3h block, max-3h break, max 2
      // blocks). This is the Sonny-bug guard: a 7h block + 1h break
      // + 1h trailing block has only "one transition" but fails the
      // 3h-block rule and would never have shipped.
      const proposed = [...entry.slots]
      proposed[donorSlot] = false
      proposed[slot] = true
      if (violatesShape(proposed)) continue
      // Daily hours unchanged (1 off + 1 on), so no daily-max change.
      // 12h rest may change if the new first/last slot shifts.
      const newFirst = proposed.findIndex(s => s)
      let newLast = -1
      for (let z = proposed.length - 1; z >= 0; z--) if (proposed[z]) { newLast = z; break }
      {
        const yest = scheduleMap[d.id][idx - 1]
        if (yest && !yest.isOff) {
          const yLast = lastActive(yest.slots)
          if (violatesMinRest(yLast, newFirst)) continue
        }
      }
      {
        const tomorrow = scheduleMap[d.id][idx + 1]
        if (tomorrow && !tomorrow.isOff) {
          const tFirst = tomorrow.slots.findIndex(x => x)
          if (tFirst >= 0 && violatesMinRest(newLast, tFirst)) continue
        }
      }
      // Closer-cap if swap creates a new closer.
      if (newLast >= CLOSER_END_THRESHOLD) {
        let prevLast = -1
        for (let z = entry.slots.length - 1; z >= 0; z--) if (entry.slots[z]) { prevLast = z; break }
        const becomesCloser = prevLast < CLOSER_END_THRESHOLD
        if (becomesCloser
            && dayHasMorningOpening(dow)
            && countClosersOn(dateStr) >= MAX_CLOSERS_PER_NIGHT) continue
      }

      // Apply.
      entry.slots = proposed
      cov[donorSlot] = trimmedCov
      cov[slot] = (cov[slot] ?? 0) + 1
      lastSlotWorked[d.id][dateStr] = newLast
      return true
    }
    return false
  }

  // Walk all dates, for each find priority-floor slots still below 40%
  // and grind through (A)→(B)→(C) until either fixed or all three return
  // false (no legal placement). The outer while loop iterates because
  // applying (A) or (B) can OPEN new options (e.g. (B) added a driver
  // who is now adjacent to the next violation slot).
  for (const di of allDates) {
    const dateStr = format(di, 'yyyy-MM-dd')
    const dow = di.getDay()
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    if (!cov) continue
    let safety = 30
    while (safety-- > 0) {
      // Build sorted violation list each iteration so we always target the
      // deepest deficit (the slot furthest below its floor). Floor ratio
      // varies by slot — opening hours (8-10 AM) use the stricter
      // OPENING_FLOOR_RATIO so 3/7 type opens get pushed harder.
      const violations: { slot: number; deficit: number }[] = []
      for (let s = 0; s < required.length; s++) {
        if (!isFloorPrioritySlot(dow, s)) continue
        const floor = floorCoverageFor(required[s], dow, s)
        const deficit = floor - (cov[s] ?? 0)
        if (deficit > 0) violations.push({ slot: s, deficit })
      }
      if (violations.length === 0) break
      violations.sort((a, b) => b.deficit - a.deficit)
      const v = violations[0]
      const ok = tryAdjacentExtend(dateStr, dow, v.slot)
        || tryOffDayShift(dateStr, dow, v.slot)
        || tryDonorSwap(dateStr, dow, v.slot)
      if (!ok) break  // nothing more to do for this date; will be flagged
                      // as headcount-limited in the post-pass scan.
    }
  }

  // ─── Headcount-limited slot detection ───────────────────────────────────
  // Final scan: any priority floor slot still below 40% of its target is
  // a genuine headcount shortage. The redistribution phases tried every
  // legal placement; if those returned false, no driver can be added
  // without breaking a hard rule (time-off, cap, daily max, 12h rest).
  const headcountLimitedSlots: import('./types').HeadcountLimitedSlot[] = []
  const slotLabelForIndex = (sIdx: number): string => {
    // Slot 0 = 8 AM, slot 14 = 10 PM, +1 hour per slot.
    const h24 = 8 + sIdx
    const period = h24 >= 12 ? 'PM' : 'AM'
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12
    return `${h12} ${period}`
  }
  for (const di of allDates) {
    const dateStr = format(di, 'yyyy-MM-dd')
    const dow = di.getDay()
    const required = effectiveCoverage(dow, coverageScale, coverageOverrides)
    const cov = coverageActual[dateStr]
    if (!cov) continue
    const dayLabel = format(di, 'EEE, MMMM do')
    for (let s = 0; s < required.length; s++) {
      if (!isFloorPrioritySlot(dow, s)) continue
      const target = required[s]
      const floor = floorCoverageFor(target, dow, s)
      const achieved = cov[s] ?? 0
      if (achieved >= floor) continue
      headcountLimitedSlots.push({
        date: dateStr,
        dayLabel,
        slotIndex: s,
        slotLabel: slotLabelForIndex(s),
        achieved,
        target,
        floor,
        hoursShortOfFloor: floor - achieved,
      })
    }
  }

  const driverSchedules: DriverSchedule[] = drivers.map((d) => {
    const days = scheduleMap[d.id]
    const wh = weekHours[d.id]
    const totalHours = Object.values(wh).reduce((s, h) => s + h, 0)
    return { driver: d, days, weeklyHours: wh, totalHours }
  })

  // Append pending-availability drivers as all-off rows so the UI still
  // lists them in the schedule view (banner + roster pills) without
  // them affecting coverage, weekly hours, or any phase. Once ops flips
  // pendingAvailability off, the "Confirm & add" action in the
  // schedule view runs `addDriverIncremental` to slot them in.
  for (const d of pendingDrivers) {
    const days: DriverDayEntry[] = allDates.map((date) => ({
      date: format(date, 'yyyy-MM-dd'),
      dayLabel: format(date, 'EEE, MMMM do'),
      dayOfWeek: date.getDay(),
      slots: new Array(DRIVER_SLOTS.length).fill(false),
      totalHours: 0,
      isOff: true,
    }))
    const wh: Record<string, number> = {}
    for (const di of allDates) wh[weekLabel(di)] = 0
    driverSchedules.push({ driver: d, days, weeklyHours: wh, totalHours: 0 })
  }

  const dates = allDates.map((d) => ({
    date: format(d, 'yyyy-MM-dd'),
    dayLabel: format(d, 'EEE, MMMM do'),
    weekLabel: weekLabel(d),
    dayOfWeek: d.getDay(),
  }))

  return {
    startDate, endDate, fullTimeCap, partTimeCap, seed,
    dates, driverSchedules, coverageActual, headcountLimitedSlots,
  }
}

// ─── Slide schedule to new dates (no regeneration) ──────────────────────────
//
// When ops moves the date picker forward/backward by a multiple of 7 days
// (same length, same start day-of-week), they almost always want to KEEP
// the current driver-shift distribution and just re-label the dates. A
// full regenerate would re-randomize the schedule and lose any manual
// edits + Confirm-pending placements. This helper preserves the
// distribution exactly — same drivers, same patterns, same coverage
// numbers per DOW — and just re-keys every date by the offset.
//
// Returns null if the shape doesn't match (different length OR offset
// not a multiple of 7 days). Callers should fall back to a full
// regenerate in that case.

/** Compute the day-offset between two ISO dates as integer days. */
function offsetDays(fromISO: string, toISO: string): number {
  return differenceInDays(parseISO(toISO), parseISO(fromISO))
}

/**
 * Returns a new GeneratedDriverSchedule with every date shifted by
 * `(newStartDate - schedule.startDate)` days. Preserves driver shift
 * patterns, weekly hours, coverage counts (per-DOW), and headcount-
 * limited flags. Returns null when the shift can't safely re-key —
 * the caller should regenerate instead.
 */
export function slideScheduleDates(
  schedule: GeneratedDriverSchedule,
  newStartDate: string,
  newEndDate: string,
): GeneratedDriverSchedule | null {
  const oldLen = offsetDays(schedule.startDate, schedule.endDate)
  const newLen = offsetDays(newStartDate, newEndDate)
  if (oldLen !== newLen) return null              // different length
  const off = offsetDays(schedule.startDate, newStartDate)
  if (off === 0) return schedule                  // no-op
  if (off % 7 !== 0) return null                  // would shift weekday alignment

  const shiftISO = (iso: string): string =>
    format(addDays(parseISO(iso), off), 'yyyy-MM-dd')

  // 1. Per-driver day arrays + weeklyHours rekeyed.
  const driverSchedules: DriverSchedule[] = schedule.driverSchedules.map((ds) => {
    const days = ds.days.map((d) => {
      const nd = addDays(parseISO(d.date), off)
      return {
        ...d,
        date: format(nd, 'yyyy-MM-dd'),
        dayLabel: format(nd, 'EEE, MMMM do'),
        // dayOfWeek unchanged — offset is a multiple of 7.
      }
    })
    // weeklyHours is keyed by weekLabel (e.g. "Jun 4 – Jun 10"). Each
    // old key needs to map to the new week containing its shifted dates.
    // Recompute by walking days and accumulating into the new week label.
    const weeklyHours: Record<string, number> = {}
    for (const e of days) {
      const wLabel = weekLabel(parseISO(e.date))
      weeklyHours[wLabel] = (weeklyHours[wLabel] ?? 0) + (e.totalHours ?? 0)
    }
    return { ...ds, days, weeklyHours }
  })

  // 2. coverageActual: re-key each entry by the shifted date.
  const coverageActual: Record<string, number[]> = {}
  for (const [date, counts] of Object.entries(schedule.coverageActual)) {
    coverageActual[shiftISO(date)] = [...counts]
  }

  // 3. dates array: shift each entry.
  const dates = schedule.dates.map((di) => {
    const nd = addDays(parseISO(di.date), off)
    return {
      date: format(nd, 'yyyy-MM-dd'),
      dayLabel: format(nd, 'EEE, MMMM do'),
      weekLabel: weekLabel(nd),
      dayOfWeek: nd.getDay(),
    }
  })

  // 4. headcountLimitedSlots: re-key each entry's date + dayLabel.
  const headcountLimitedSlots = schedule.headcountLimitedSlots.map((s) => {
    const nd = addDays(parseISO(s.date), off)
    return {
      ...s,
      date: format(nd, 'yyyy-MM-dd'),
      dayLabel: format(nd, 'EEE, MMMM do'),
    }
  })

  return {
    ...schedule,
    startDate: newStartDate,
    endDate: newEndDate,
    dates,
    driverSchedules,
    coverageActual,
    headcountLimitedSlots,
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
 * be staffed before the algorithm refuses to add more. Set to 15% (min 1
 * body) per ops policy: it's better to over-staff a slot by a few bodies
 * than to leave a dinner-peak slot 1-2 short. Tested at 5% (tighter) but
 * that left structural dinner-peak gaps on large rosters; at 15% the
 * algorithm has room to land patterns even when adjacent slots are
 * already over.
 *
 * Under-coverage has ZERO tolerance per ops policy ("coverage targets
 * are hard minimums") — see `coverageStatus()` and `analyzeCoverageHealth()`.
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
    // Under-coverage on the single LOW-priority non-floor slot (3 PM)
    // is acceptable per ops policy — exclude from the shortfall total
    // so the hiring recommender doesn't urge new hires to cover a slot
    // ops explicitly wants thinner. Every floor slot (everything except
    // 3 PM) counts fully even when its weight happens to be < 0.5.
    let shortfall = 0
    let overstaff = 0
    for (let s = 0; s < target.length; s++) {
      const diff = target[s] - (actual[s] ?? 0)
      if (diff > 0) {
        if (isFloorSlot(di.dayOfWeek, s)) {
          shortfall += diff
        } else {
          const w = slotPriorityWeight(di.dayOfWeek, s)
          if (w >= LOW_PRIORITY_WEIGHT) shortfall += diff
        }
      } else if (diff < 0) {
        overstaff += -diff
      }
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

export type CoverageStatus = 'ok' | 'over' | 'mild' | 'short' | 'short-low-priority'

/**
 * Color-codes how far a slot's actual coverage is from its target:
 *   - 'ok'                 at-or-above target with required > 0
 *   - 'mild'               over target but within +15% (yellow)
 *   - 'short'              under-coverage on a NORMAL or HIGH-priority slot
 *                          (red — coverage targets are hard minimums there)
 *   - 'short-low-priority' under-coverage on a LOW-priority slot (3-4 PM)
 *                          (muted amber — acceptable shortfall per ops policy)
 *   - 'over'               required = 0 but staffed, or staffed > +15%
 *
 * The dow/slot parameters are optional so legacy callers (UI rendering
 * just based on actual/required without context) still work — they get
 * the standard short/red bucket. When the dow/slot ARE provided, an
 * under-target slot with priority weight < LOW_PRIORITY_WEIGHT (0.5)
 * gets the gentler 'short-low-priority' status instead of red.
 */
export function coverageStatus(
  actual: number,
  required: number,
  dow?: number,
  slot?: number,
): CoverageStatus {
  if (required === 0) return actual > 0 ? 'over' : 'ok'
  const diff = required - actual
  if (diff > 0) {
    // Per Rule 2: 3 PM (the one non-floor slot) may legitimately run
    // under target — flag amber, not red, so ops doesn't read it as a
    // service gap. EVERY OTHER slot is a hard floor (FLOOR_SLOTS in
    // coverageTemplate.ts) — under-coverage there stays red regardless
    // of priority weight, even when the weight is < LOW_PRIORITY_WEIGHT.
    if (dow !== undefined && slot !== undefined && !isFloorSlot(dow, slot)) {
      const w = slotPriorityWeight(dow, slot)
      if (w < LOW_PRIORITY_WEIGHT) return 'short-low-priority'
    }
    return 'short'
  }
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

// ─── Incremental add-driver ─────────────────────────────────────────────
//
// Adds a single driver to an EXISTING schedule without re-running the
// 8-phase pipeline. Every existing driver's shifts are kept exactly as
// they are; only the new driver gets new entries. Coverage at the slots
// they fill goes up — that's the expected outcome.
//
// Replaces the old "add-driver triggers full regenerate" flow which
// churned every driver's assignments. Per user spec:
//   - Hold all existing driverSchedules fixed
//   - Place the new driver into current coverage gaps, prioritizing
//     the largest deficits and honoring opening/peak weighting
//   - Don't push slots above target just to use up cap
//   - Respect 12h rest, 4-9h per day, weekly cap, and the new driver's
//     own time-off
//
// Returns a new GeneratedDriverSchedule and an UNDER-utilized flag set
// when the new driver's assigned hours are notably below their cap
// (less than 70% — i.e., not enough gaps to absorb them fully).

export interface AddDriverIncrementalResult {
  schedule: GeneratedDriverSchedule
  /** Hours assigned to the new driver. */
  assignedHours: number
  /** The driver's user-set weekly cap (FT or PT). */
  weeklyCap: number
  /** True when total assigned < ~70% × cap × week-count — the schedule
   *  didn't have enough gaps to absorb the new driver's full capacity. */
  underUtilized: boolean
}

export function addDriverIncremental({
  schedule,
  newDriver,
  timeOff,
  coverageScale = 1,
  coverageOverrides = {},
  minHoursPerDay = 4,
  maxHoursPerDay = MAX_HOURS_PER_DAY,
}: {
  schedule: GeneratedDriverSchedule
  newDriver: Driver
  timeOff: DriverTimeOff
  coverageScale?: number
  coverageOverrides?: Record<number, number[]>
  minHoursPerDay?: number
  maxHoursPerDay?: number
}): AddDriverIncrementalResult {
  const userCap = newDriver.employmentType === 'full'
    ? schedule.fullTimeCap
    : schedule.partTimeCap
  // Buffer over user cap matches scheduler's bufferedCapOf logic.
  const legalMax = newDriver.employmentType === 'full'
    ? LEGAL_WEEKLY_MAX_HOURS
    : LEGAL_PT_WEEKLY_MAX_HOURS
  const bufferedCap = Math.min(
    Math.round(userCap * (1 + USER_CAP_BUFFER_PCT)),
    legalMax,
  )

  // Effective min per shift (4h hard floor per ops policy).
  const effectiveMin = Math.max(4, minHoursPerDay)
  const softMaxPerDay = Math.min(maxHoursPerDay + 1, LEGAL_DAILY_MAX_HOURS, MAX_HOURS_PER_DAY)

  // Work in a shallow copy of coverageActual so we can incrementally
  // update as we place the new driver's shifts. We DON'T mutate the
  // existing driverSchedules.
  const newCoverageActual: Record<string, number[]> = {}
  for (const date of Object.keys(schedule.coverageActual)) {
    newCoverageActual[date] = [...schedule.coverageActual[date]]
  }

  // Build the new driver's empty days array (one entry per date).
  const newDays: DriverDayEntry[] = schedule.dates.map((di) => ({
    date: di.date,
    dayLabel: di.dayLabel,
    dayOfWeek: di.dayOfWeek,
    slots: new Array(DRIVER_SLOTS.length).fill(false),
    totalHours: 0,
    isOff: true,
  }))

  // Per work-week running totals (so we don't exceed weekly cap).
  const weekHours: Record<string, number> = {}
  // Per work-week running days-worked count (cap at MAX_DAYS_PER_WEEK = 6).
  const daysWorkedInWeek: Record<string, number> = {}
  const MAX_DAYS_PER_WEEK = 6

  // Pre-compute each date's per-slot priority weight for scoring (cached).
  const priorityByDate = new Map<string, number[]>()
  for (const di of schedule.dates) {
    const w = new Array(DRIVER_SLOTS.length)
    for (let s = 0; s < DRIVER_SLOTS.length; s++) {
      w[s] = newDriver.isShopper ? 1 : slotPriorityWeight(di.dayOfWeek, s)
    }
    priorityByDate.set(di.date, w)
  }

  // Iterate dates in calendar order — calculate the deficit (largest
  // weighted shortfall) for each date and try to place a pattern that
  // hits the deficit slots. Calendar order so rest checks against
  // already-placed adjacent days work correctly.
  for (let dayIdx = 0; dayIdx < schedule.dates.length; dayIdx++) {
    const di = schedule.dates[dayIdx]
    const wLabel = di.weekLabel
    if (newDriver.isShopper && di.dayOfWeek === 0) continue  // shoppers don't work Sundays

    const remainingWeek = bufferedCap - (weekHours[wLabel] ?? 0)
    if (remainingWeek < effectiveMin) continue
    if ((daysWorkedInWeek[wLabel] ?? 0) >= MAX_DAYS_PER_WEEK) continue

    const required = effectiveCoverage(di.dayOfWeek, coverageScale, coverageOverrides)
    const cov = newCoverageActual[di.date] ?? new Array(DRIVER_SLOTS.length).fill(0)
    const weights = priorityByDate.get(di.date)!
    const blocks = blockedBitmap(timeOff, newDriver, di.date, di.dayOfWeek)
    // Day completely blocked? skip.
    if (blocks && blocks.length > 0 && blocks.every(Boolean)) continue

    // Day's deficit (weighted shortfall sum). If zero, no incentive
    // to place — the new driver would just over-staff.
    let dayDeficit = 0
    for (let s = 0; s < required.length; s++) {
      const short = Math.max(0, required[s] - cov[s])
      dayDeficit += short * weights[s]
    }
    if (dayDeficit <= 0) continue

    // Probe every pattern in the day's template, scoring by how much
    // gap-coverage it provides. Score logic mirrors main pass: each
    // slot's contribution = max(0, shortfall) × priority weight.
    // Slots already at-or-over target contribute zero (per spec:
    // "Don't push slots above target just to use up their hours").
    const template = DRIVER_DAY_TEMPLATES[di.dayOfWeek]
    let bestPattern: boolean[] | null = null
    let bestScore = 0  // strict > 0 needed to place anything

    // Find adjacent days for rest checks.
    const yest = dayIdx > 0 ? newDays[dayIdx - 1] : null
    const tomorrow = dayIdx + 1 < newDays.length ? newDays[dayIdx + 1] : null
    const yestLast = (yest && !yest.isOff) ? lastActive(yest.slots) : -1
    const tomorrowFirst = (tomorrow && !tomorrow.isOff) ? tomorrow.slots.findIndex(s => s) : -1

    for (const raw of template.shiftPatterns) {
      const p = raw.map((v) => v === 1)
      const h = slotHours(p)
      if (h < effectiveMin || h > softMaxPerDay) continue
      if (h > remainingWeek) continue
      if (blocks && p.some((on, i) => on && blocks[i])) continue
      // Break rule for 8h+ shifts.
      if (h >= breakRequiredAt(newDriver) && !patternHasBreak(p)) continue
      // 12h rest with adjacent days that this new driver has already
      // accepted in earlier iterations.
      const pFirst = firstActive(p)
      const pLast = lastActive(p)
      if (yestLast >= 0 && violatesMinRest(yestLast, pFirst)) continue
      if (tomorrowFirst >= 0 && violatesMinRest(pLast, tomorrowFirst)) continue

      // Score: weighted shortfall on slots the pattern covers, capped
      // at the actual deficit per slot. Slots above target contribute 0.
      let score = 0
      let helpsAnyGap = false
      for (let s = 0; s < p.length; s++) {
        if (!p[s]) continue
        const short = required[s] - cov[s]
        if (short > 0) {
          score += weights[s] * 10 + weights[s] * (short / Math.max(1, required[s])) * 50
          helpsAnyGap = true
        }
        // Above-target slots don't subtract — we tolerate touching them
        // so a pattern that fills a real gap but also crosses an over-
        // staffed slot still scores positively.
      }
      // Length tie-break: prefer the SHORTER pattern when scores match.
      // Saves weekly cap for other days of the new driver.
      score -= h * 0.1
      if (!helpsAnyGap) continue  // no real gap → don't place
      if (score > bestScore) {
        bestScore = score
        bestPattern = p
      }
    }

    if (!bestPattern) continue  // no useful gap-filling pattern for this day

    // Apply the placement.
    const h = slotHours(bestPattern)
    newDays[dayIdx] = {
      date: di.date,
      dayLabel: di.dayLabel,
      dayOfWeek: di.dayOfWeek,
      slots: [...bestPattern],
      totalHours: h,
      isOff: false,
    }
    weekHours[wLabel] = (weekHours[wLabel] ?? 0) + h
    daysWorkedInWeek[wLabel] = (daysWorkedInWeek[wLabel] ?? 0) + 1
    // Only count toward DRIVER coverage if non-shopper (shoppers feed
    // the separate SHOPPER pool).
    if (!newDriver.isShopper) {
      for (let s = 0; s < bestPattern.length; s++) {
        if (bestPattern[s]) cov[s]++
      }
      newCoverageActual[di.date] = cov
    }
  }

  // Build the new DriverSchedule entry.
  const newDriverSchedule: DriverSchedule = {
    driver: newDriver,
    days: newDays,
    weeklyHours: { ...weekHours },
    totalHours: Object.values(weekHours).reduce((s, v) => s + v, 0),
  }

  // Append to the existing driverSchedules array (preserve order).
  // If a placeholder for this driver already exists (e.g. pending-
  // availability entry that the scheduler appended as all-off), REPLACE
  // it in place instead of appending a duplicate. Keyed by driver.id —
  // a freshly-imported driver won't collide.
  const existingIdx = schedule.driverSchedules.findIndex((ds) => ds.driver.id === newDriver.id)
  const newDriverSchedules = existingIdx >= 0
    ? schedule.driverSchedules.map((ds, i) => (i === existingIdx ? newDriverSchedule : ds))
    : [...schedule.driverSchedules, newDriverSchedule]

  // Under-utilized when total < 70% of the per-week cap × number of weeks.
  const weekCount = new Set(schedule.dates.map((d) => d.weekLabel)).size || 1
  const expectedHours = userCap * weekCount
  const assignedHours = newDriverSchedule.totalHours

  return {
    schedule: {
      ...schedule,
      driverSchedules: newDriverSchedules,
      coverageActual: newCoverageActual,
    },
    assignedHours,
    weeklyCap: userCap,
    underUtilized: assignedHours < expectedHours * 0.7,
  }
}
