import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DAY_TEMPLATES,
  effectiveCoverage,
  LONG_SHIFT_BREAK_MIN,
  MAX_BREAK_HARD_HOURS,
  MAX_BREAK_PREFERRED_HOURS,
  MED_SHIFT_BREAK_MIN,
  MIN_BLOCK_HOURS,
  patternMaxBreakHours,
  patternWorkBlocks,
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
 *  band keeps weekly hours equitable. Set to 42 h (≈the floor the user
 *  wants every dispatcher near) so the picker fills closer to that
 *  before deprioritizing them — was 38 which left most dispatchers in
 *  the 30-36 h band. Only relaxed when no eligible dispatcher fits —
 *  then we fall back to the legal 45 h cap. */
const SOFT_WEEKLY_TARGET = 42

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

/** Hard over-coverage ceiling per slot. With required=R the slot can have
 *  at most R+1 dispatchers — never 4/1, never 5/3. Keeps the picker from
 *  piling people onto a slot we don't actually need them at. */
const MAX_OVER_COVERAGE = 1

// ---------------------------------------------------------------------------
// Coverage-aware swap pass — runs after the main greedy assignment to
// extend single-block shifts into peak-break splits when it closes a
// real coverage gap on the morning/late edge. A peak-time break is only
// allowed when the peak slot is currently over-covered (slack to lend).
// ---------------------------------------------------------------------------

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
        // Only constraint: the dispatcher stepping off this slot can't
        // push it BELOW required coverage. Peak slots no longer get any
        // special protection — the user's directive is "as long as the
        // numbers match, peak breaks are fine."
        const dropsBelow = breakSlots.some((s) => cov[s] - 1 < req[s])
        if (dropsBelow) continue
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
  /** Pre-shift weekly hours per dispatcher id. Used to reject swaps
   *  that would push the dispatcher past the 45 h legal cap. */
  preShiftWeekHours?: Record<string, number>,
): void {
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) {
    pattern.forEach((on, si) => { if (on) cov[si]++ })
  }
  for (let i = 0; i < assignments.length; i++) {
    const orig = assignments[i].pattern
    const swapped = trySwapForCoverage(orig, cov, required)
    if (!swapped) continue
    // Cap check: the original shift's hours were already in weekHours
    // counted upstream; the SWAP adds (newHours - oldHours). Reject the
    // swap if that delta pushes the dispatcher past the legal cap.
    if (preShiftWeekHours) {
      const id = assignments[i].dispatcher.id
      const delta = slotHours(swapped) - slotHours(orig)
      const projected = (preShiftWeekHours[id] ?? 0) + slotHours(swapped)
      if (delta > 0 && projected > WEEKLY_CAP_HOURS) continue
    }
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

  // Per-dispatcher running count of split shifts (worked day with a
  // mid-shift break ≥ 2 h). Used as a tiebreak in the picker so split
  // patterns rotate fairly across the roster — without it the same
  // dispatcher tends to absorb every split because they happen to sort
  // lowest on week-hours after one.
  const splitsSoFar: Record<string, number> = {}
  dispatchers.forEach((d) => (splitsSoFar[d.id] = 0))

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
    const patternMeta = template.shiftPatterns.map((raw, idx) => {
      const bool = raw.map((v) => v === 1)
      return {
        idx,
        bool,
        hours: slotHours(bool),
        first: firstActiveSlot(bool),
        last: lastActiveSlot(bool),
        isMorning: firstActiveSlot(bool) <= MORNING_SLOT_THRESHOLD,
        maxBreak: patternMaxBreakHours(bool, SLOTS),
      }
    })

    // Sort patterns: morning first, then LONGEST shifts first so they go
    // to the least-loaded dispatcher. Break-size penalty (over the 2 h
    // preferred cap) is the last tiebreak. Peak-time breaks no longer get
    // a sort penalty — coverage targets + the over-coverage cap (req+1)
    // are the constraints that matter.
    const byLengthThenBreak = (a: typeof patternMeta[number], b: typeof patternMeta[number]) => {
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

    const cappedDispatchers = cappedToday
    const workingPool = availablePool.filter((d) => !electedOffIds.has(d.id))

    // Balance sort: prefer this-week-behind dispatchers FIRST so each
    // calendar week ends up with a tight hour spread (was running 27-40 h
    // wide), then break ties on cumulative total to keep the period-long
    // total band tight too. The cumulative side still self-corrects
    // because last week's loser usually starts this week's pick order.
    const sortedWorking = [...workingPool].sort((a, b) => {
      const wA = weekHours[a.id][wLabel] ?? 0
      const wB = weekHours[b.id][wLabel] ?? 0
      if (wA !== wB) return wA - wB
      return totalHoursWorked[a.id] - totalHoursWorked[b.id]
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

    // Day's required coverage — needed up here so the picker can enforce
    // the over-coverage cap (no slot > required + 1). Used again later
    // by the swap pass + rescue.
    const dayRequired = effectiveCoverage(dow, coverageOverrides)
    const runningCov = new Array(SLOTS.length).fill(0)

    // ── Smart pattern ordering + drop ──────────────────────────────────
    // "Uniqueness" = slots where THIS pattern is the only one in the
    // pool covering a required slot, OR where the pool's covering
    // patterns are still short of the requirement (req > coverers).
    // The 2nd clause matters when two patterns share a critical slot
    // (e.g. Late C + Late D both covering Sun 10-11 PM at req=3) —
    // without it, both score 0 and get demoted/dropped, leaving the
    // slot uncovered. Drop only fires when patterns > working
    // dispatchers; lowest-scoring + shortest go first.
    const coverageCount = new Array(SLOTS.length).fill(0)
    for (const pp of sortedPatterns) {
      pp.bool.forEach((on, i) => { if (on) coverageCount[i]++ })
    }
    const scoredPatterns = sortedPatterns.map((pp) => {
      let unique = 0
      for (let i = 0; i < pp.bool.length; i++) {
        if (!pp.bool[i] || dayRequired[i] === 0) continue
        if (coverageCount[i] === 1) unique++
        else if (coverageCount[i] < dayRequired[i]) unique++
      }
      return { p: pp, unique }
    })
    let prioritizedPatterns = sortedPatterns
    const patternsToDrop = Math.max(0, sortedPatterns.length - sortedWorking.length)
    if (patternsToDrop > 0) {
      const dropSort = [...scoredPatterns].sort((a, b) => a.unique - b.unique || a.p.hours - b.p.hours)
      const dropped = new Set(dropSort.slice(0, patternsToDrop).map((x) => x.p))
      prioritizedPatterns = sortedPatterns.filter((pp) => !dropped.has(pp))
    }
    prioritizedPatterns = [...prioritizedPatterns].sort((a, b) => {
      const ua = scoredPatterns.find((x) => x.p === a)!.unique
      const ub = scoredPatterns.find((x) => x.p === b)!.unique
      if (ua !== ub) return ub - ua
      if (a.isMorning !== b.isMorning) return a.isMorning ? -1 : 1
      if (a.hours !== b.hours) return b.hours - a.hours
      return a.maxBreak - b.maxBreak
    })

    for (const p of prioritizedPatterns) {
      // Over-coverage cap: skip the whole pattern if it would push ANY
      // already-covered slot past required + MAX_OVER_COVERAGE. Avoids
      // 4/1 / 5/3 / 5/1 stacking that the user explicitly called out.
      // Over-coverage cap is TIERED:
      //   - Default cap: req + MAX_OVER_COVERAGE (req+1). User's hard
      //     rule — never 5/1, 5/3.
      //   - When the pattern ALSO closes a deficit elsewhere, the cap
      //     loosens by one (req+2) for incidentally-covered low-req
      //     slots. This lets evening closers run when they bring a
      //     missing body to a critical late slot but happen to stack
      //     a low-req slot like 8:30-9 PM. Never req+3.
      let fillsDeficit = false
      for (let i = 0; i < p.bool.length; i++) {
        if (p.bool[i] && runningCov[i] < dayRequired[i]) { fillsDeficit = true; break }
      }
      const cap = MAX_OVER_COVERAGE + (fillsDeficit ? 1 : 0)
      let overShoots = false
      for (let i = 0; i < p.bool.length; i++) {
        if (p.bool[i] && runningCov[i] + 1 > dayRequired[i] + cap) {
          overShoots = true; break
        }
      }
      if (overShoots) continue

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
      // Continue (not break) so a later pattern still gets a chance even
      // when this one has zero eligible candidates — otherwise Late B
      // gets silently skipped when an earlier pattern's filter rejects
      // everyone, leaving the closing slots uncovered.
      if (eligible.length === 0) continue

      // Hours-balance preference: prefer dispatchers whose post-shift weekly
      // hours stay at or below the soft target (38 h). This stops one
      // dispatcher from accumulating to 42-45 h while others sit at 30 h.
      // Falls back to all eligible if nobody fits (rare — usually means a
      // tight day where someone has to absorb the extra hours).
      const withinSoft = eligible.filter(
        (d) => (weekHours[d.id][wLabel] ?? 0) + p.hours <= SOFT_WEEKLY_TARGET,
      )
      let pickFrom = withinSoft.length > 0 ? withinSoft : eligible

      // Split-shift fairness: when this pattern IS a split (≥ 2 h
      // mid-shift break), prefer the candidate who has accumulated
      // the fewest splits so far. Without this the same dispatcher
      // tends to absorb every split because they keep sorting lowest
      // on week-hours — user observed a 16-vs-1 spread.
      if (p.maxBreak >= 2) {
        pickFrom = [...pickFrom].sort((a, b) => {
          const sA = splitsSoFar[a.id], sB = splitsSoFar[b.id]
          if (sA !== sB) return sA - sB
          // Preserve original week-hours ordering as tiebreak.
          return (weekHours[a.id][wLabel] ?? 0) - (weekHours[b.id][wLabel] ?? 0)
        })
      }

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
      if (p.maxBreak >= 2) splitsSoFar[dispatcher.id]++
      p.bool.forEach((on, i) => { if (on) runningCov[i]++ })
    }

    // Patterns already used by the picker — rescue/must-work prefer
    // UNUSED patterns to avoid the duplicate-Early-A stacking the
    // user flagged. Tracked by index since pattern bitmaps are stable
    // refs in patternMeta.
    const usedPatternIdx = new Set<number>()
    for (const a of assignments) {
      const idx = patternMeta.findIndex((pm) => pm.bool === a.pattern)
      if (idx >= 0) usedPatternIdx.add(idx)
    }

    // Coverage-aware swap pass: extend single-block shifts into peak-break
    // splits when adjacent slots are under-covered AND the peak slot we'd
    // break at is currently over-covered (slack to lend). This is what
    // lets michelle's Bridge 11a-5p become 9a-6p with a non-peak break
    // when 9-10a is missing a body and the dispatcher has the headroom.
    // dayRequired was computed earlier (before the picker) so the
    // over-coverage cap could use it. Just pass it through.
    const preShiftWeekHours: Record<string, number> = {}
    for (const d of dispatchers) preShiftWeekHours[d.id] = weekHours[d.id][wLabel] ?? 0
    coverageAwareSwapPass(assignments, dayRequired, preShiftWeekHours)
    coverageRequired[dateStr] = dayRequired

    // ── Coverage rescue pass ───────────────────────────────────────────
    // Hard constraint: never leave a required slot under-covered if we
    // have any off-pool dispatcher who could legally fill it.
    //
    // Pool: everyone NOT currently assigned — elected-off AND unassigned
    // working (the leftover dispatcher when patternsNeeded < availablePool
    // and the picker only assigned one-per-pattern). Filling from the
    // unassigned-working pool is the cheapest path to lift weekly hours
    // from 30-36 h into the 40+ band the user wants.
    //
    // Each iteration picks the (dispatcher, pattern) combo that fills
    // the MOST under-covered required slots in one go. Respects 45 h
    // legal cap, time-off, night-rest, and the over-coverage cap
    // (req + MAX_OVER_COVERAGE).
    {
      const cov = new Array(SLOTS.length).fill(0)
      for (const { pattern } of assignments) {
        pattern.forEach((on, i) => { if (on) cov[i]++ })
      }
      const rescuePool = [
        ...availablePool.filter((d) => electedOffIds.has(d.id)),
        ...sortedWorking.filter((d) => !usedIds.has(d.id)),
      ]
      for (let safety = 0; safety < 50; safety++) {
        // Build the deficit vector: how many MORE bodies each slot needs.
        const deficit = dayRequired.map((req, i) => Math.max(0, req - cov[i]))
        const totalDeficit = deficit.reduce((s, d) => s + d, 0)
        if (totalDeficit === 0) break
        if (rescuePool.length === 0) break

        // Score every (pattern × dispatcher) combo by net coverage
        // benefit: fill - over. Hard ceiling at req+3 so rescue can't
        // pile bodies indefinitely on a low-req slot just because the
        // pattern also closes a critical late-evening gap. fill > 0
        // is the gating condition.
        let best: { p: typeof patternMeta[number]; dIdx: number; score: number } | null = null
        for (let pIdx = 0; pIdx < patternMeta.length; pIdx++) {
          const p = patternMeta[pIdx]
          let fill = 0, over = 0, blown = false
          for (let i = 0; i < p.bool.length; i++) {
            if (!p.bool[i]) continue
            if (deficit[i] > 0) fill++
            if (cov[i] + 1 > dayRequired[i] + MAX_OVER_COVERAGE) over++
            if (cov[i] + 1 > dayRequired[i] + MAX_OVER_COVERAGE + 2) { blown = true; break }
          }
          if (fill === 0 || blown) continue
          // Penalise re-using a pattern already in play — user prefers
          // a different shape when both fill the same deficit.
          const dupPenalty = usedPatternIdx.has(pIdx) ? 1 : 0
          const score = fill - over - dupPenalty
          for (let i = 0; i < rescuePool.length; i++) {
            const d = rescuePool[i]
            if (p.isMorning && workedNightYesterday(d.id)) continue
            const blocks = blockedBitmap(timeOff, d, dateStr, dow)
            if (blocks && p.bool.some((on, j) => on && blocks[j])) continue
            if ((weekHours[d.id][wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) continue
            if (!best || score > best.score) best = { p, dIdx: i, score }
          }
        }
        if (!best) break

        // Rescue the best combo.
        const d = rescuePool[best.dIdx]
        assignments.push({ dispatcher: d, pattern: best.p.bool })
        usedIds.add(d.id)
        if (best.p.maxBreak >= 2) splitsSoFar[d.id]++
        best.p.bool.forEach((on, j) => { if (on) cov[j]++ })
        usedPatternIdx.add(patternMeta.indexOf(best.p))
        // Roll back off-day accounting only for elected-off dispatchers —
        // unassigned working ones never had it bumped in the first place.
        if (electedOffIds.has(d.id)) {
          weekOffDays[d.id][wLabel] = Math.max(0, (weekOffDays[d.id][wLabel] ?? 1) - 1)
          totalElectedOff[d.id] = Math.max(0, totalElectedOff[d.id] - 1)
          if (isWeekend) weekendOffTotal[d.id] = Math.max(0, weekendOffTotal[d.id] - 1)
          electedOffIds.delete(d.id)
        }
        rescuePool.splice(best.dIdx, 1)
      }
    }

    // ── Must-work pass ────────────────────────────────────────────────
    // Hard cap MAX_DAYS_OFF_PER_WEEK at the assignment layer (not just
    // the elected-off slice). Anyone in availablePool who is NOT used
    // today and who would land at 3+ days off this week must work,
    // even if it stacks coverage above req+1. The user's rule: never
    // 3 days off — wasted resources while gaps remain.
    {
      const mustWork = availablePool.filter(
        (d) => !usedIds.has(d.id) && (weekOffDays[d.id][wLabel] ?? 0) >= MAX_DAYS_OFF_PER_WEEK,
      )
      const cov = new Array(SLOTS.length).fill(0)
      for (const { pattern } of assignments) {
        pattern.forEach((on, i) => { if (on) cov[i]++ })
      }
      for (const d of mustWork) {
        // Score every legal pattern by NET coverage benefit:
        //   score = (gap-fills) - (over-coverage past req)
        // Pick max score (positive = net coverage win). If every
        // pattern scores negative, the LEAST-negative wins — that's
        // the smallest over-coverage hit needed to keep this person
        // off the 3rd-off list. Rescue pass already ran, so the
        // gap-fills available here are the ones that exceed
        // MAX_OVER_COVERAGE elsewhere in the same pattern — a real
        // trade we're consciously accepting. Tiebreaks: prefer
        // shorter shifts to limit the hours hit when neutral.
        let pick: { p: typeof patternMeta[number]; score: number; pIdx: number } | null = null
        for (let pIdx = 0; pIdx < patternMeta.length; pIdx++) {
          const p = patternMeta[pIdx]
          if (p.isMorning && workedNightYesterday(d.id)) continue
          const blocks = blockedBitmap(timeOff, d, dateStr, dow)
          if (blocks && p.bool.some((on, j) => on && blocks[j])) continue
          if ((weekHours[d.id][wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) continue
          let fill = 0, over = 0
          for (let i = 0; i < p.bool.length; i++) {
            if (!p.bool[i]) continue
            const newCov = cov[i] + 1
            if (cov[i] < dayRequired[i]) fill++
            if (newCov > dayRequired[i]) over += newCov - dayRequired[i]
          }
          // Fill weighted 2× over: closing one gap is worth two units
          // of over-coverage. Captures the user's "I want gaps covered,
          // not just more hours" rule — only assign over-cap patterns
          // when they genuinely close coverage. Dup penalty discourages
          // re-using a pattern the picker already placed.
          const dupPenalty = usedPatternIdx.has(pIdx) ? 1 : 0
          const score = fill * 2 - over - dupPenalty
          const better =
            !pick ||
            score > pick.score ||
            (score === pick.score && p.hours < pick.p.hours)
          if (better) pick = { p, score, pIdx }
        }
        if (pick) {
          assignments.push({ dispatcher: d, pattern: pick.p.bool })
          usedIds.add(d.id)
          if (pick.p.maxBreak >= 2) splitsSoFar[d.id]++
          usedPatternIdx.add(pick.pIdx)
          pick.p.bool.forEach((on, i) => { if (on) cov[i]++ })
        }
        // If nothing fits (all patterns blocked or week-cap-blown), we
        // accept the 3rd off as last resort — better than violating
        // time-off / 45 h cap.
      }
    }

    // Any leftover unassigned working dispatchers ARE off today — count
    // that toward their weekly off-day tally so the next day's
    // eligibleForOff filter sees them at the cap. Without this the cap
    // was silently bypassed and we'd see 3+ days off slip through.
    for (const d of sortedWorking) {
      if (!usedIds.has(d.id)) {
        weekOffDays[d.id][wLabel] = (weekOffDays[d.id][wLabel] ?? 0) + 1
        if (isWeekend) weekendOffTotal[d.id] += 1
      }
    }

    // Dispatchers not assigned are off today. Built AFTER the rescue
    // pass so rescued dispatchers correctly move out of the off pool.
    const dayOff = [
      ...sortedWorking.filter((d) => !usedIds.has(d.id)),
      ...cappedDispatchers,
      ...availablePool.filter((d) => electedOffIds.has(d.id)),
      ...blockedToday,
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
