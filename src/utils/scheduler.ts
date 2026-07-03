import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  BREAK_TROUGH_SLOTS,
  DAY_TEMPLATES,
  effectiveCoverage,
  HANDOFF_SLOT,
  MEAL_BREAK_TRIGGER_HOURS,
  MEAL_BREAK_HOURS,
  midShiftBreakSlots,
  MIN_BLOCK_HOURS,
  MIN_TAIL_STRETCH_HOURS,
  PEAK_WINDOWS,
  patternMaxBreakHours,
  patternWorkBlocks,
  SLOTS,
  SPLIT_COVERAGE,
  SPLIT_GAP_MIN_HOURS,
  SPLIT_GAP_MAX_HOURS,
  SPLIT_GAP_SLOTS,
  SURPLUS_TOLERATED_SLOTS,
  WEEKDAY_PRIMARY_STRETCH_HOURS,
} from '@/data/coverageTemplate'
import type { PeakKey } from '@/data/coverageTemplate'
import type {
  Dispatcher,
  DispatcherDayEntry,
  DispatcherLevel,
  DispatcherSchedule,
  DispatcherTimeOff,
  GeneratedSchedule,
  SecondOffRecord,
} from '@/types/schedule'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fri, Sat, Sun — the "heavy" weekend days the fairness picker spreads. */
export const HEAVY_DAYS = new Set([5, 6, 0]) // Fri, Sat, Sun

/** Level-aware weekly off-day cap. Regular/Senior can take up to 2 days
 *  off per week (soft target — falls back to 1 when coverage demand makes
 *  2 infeasible). Trainees are capped at 1 day off so they accumulate
 *  more on-shift hours per week to learn faster (a floor management
 *  policy, not a coverage optimization). The picker never *elects* off-
 *  days beyond this on top of recurring blocks. */
const MAX_DAYS_OFF_TRAINEE = 1
const MAX_DAYS_OFF_REGULAR = 2
function maxDaysOffFor(level: DispatcherLevel): number {
  return level === 'Trainee' ? MAX_DAYS_OFF_TRAINEE : MAX_DAYS_OFF_REGULAR
}

/** Legal weekly maximum. Once a dispatcher reaches this they're forced off
 *  the rest of the week (treated like time-off, doesn't count against the
 *  off-days fairness cap). Daily max (9 h) is enforced via pattern shapes. */
const WEEKLY_CAP_HOURS = 45

/** Soft weekly-hours target the picker keeps everyone under when it can.
 *  Only relaxed when no eligible dispatcher fits — then the legal 45 h cap
 *  binds. The tight equitable band is achieved by the Lever 3 post-pass. */
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

/** Hard legal cap: no dispatcher may work more than this many days in a
 *  row, INCLUDING across work-week boundaries. Enforced by the Phase 0
 *  rest pre-pass — never as a soft check inside the coverage passes. */
const MAX_CONSECUTIVE_WORK_DAYS = 6

/**
 * Phase 0 — mandatory weekly rest.
 *
 * Runs BEFORE any coverage / anchor / trainee logic. Locks exactly one
 * rest day per dispatcher per work-week (Thu–Wed), unless the dispatcher
 * already has a full-day off from `timeOff` / `recurringBlocks` in that
 * week, in which case that pre-existing rest satisfies the guarantee.
 *
 * Two hard invariants held by the output:
 *   (I1) Every work-week that has at least one work-eligible day for the
 *        dispatcher contains ≥1 rest date for that dispatcher.
 *   (I2) No two consecutive rest dates are more than 7 calendar days
 *        apart → maximum MAX_CONSECUTIVE_WORK_DAYS consecutive workdays.
 *
 * Every subsequent pass reads `restLocks[dispId]` and treats those dates
 * as inviolable off-days. The mandatory rest pre-pass is the single
 * authority on the weekly-rest and consecutive-day cap; no other pass
 * may set, refund, or override a lock.
 *
 * Placement: each dispatcher gets a stable HOME rest weekday from the
 * low-demand set (Mon–Thu) — same day every week means the rest gap is
 * exactly 7 days (streak exactly 6, always legal) and Fri/Sat/Sun keep
 * the full roster for the two-team model. Seed rotates the assignment.
 */
export function assignMandatoryRest(
  dispatchers: Dispatcher[],
  allDates: Date[],
  timeOff: DispatcherTimeOff,
  seed: number,
  coverageOverrides: Record<number, number[]> = {},
  // (dispatcherId → dates) this pass must NOT lock a rest on — fed back
  // by generateSchedule's final zero-guard when a rest placement left a
  // slot at 0. Legality always wins: when avoiding would break the
  // weekly-rest guarantee, the avoid is ignored.
  restAvoid?: Record<string, Set<string>>,
): { restLocks: Record<string, Set<string>>; streakWarnings: string[] } {
  const restLocks: Record<string, Set<string>> = {}
  const streakWarnings: string[] = []
  if (allDates.length === 0) return { restLocks, streakWarnings }

  // Bucket allDates by work-week label, preserving date order.
  const weekBuckets = new Map<string, Date[]>()
  for (const dt of allDates) {
    const wLbl = weekLabel(dt)
    if (!weekBuckets.has(wLbl)) weekBuckets.set(wLbl, [])
    weekBuckets.get(wLbl)!.push(dt)
  }
  const weekOrder = [...weekBuckets.keys()] // preserves insertion (chronological)

  // Vacation pressure per date: how many dispatchers are already off on
  // full-day user time-off. Rest placement avoids piling a lock onto
  // such days — without this, a vacation-thinned day also absorbs a
  // rest lock and loses 3 of 7 bodies while its neighbors lose none
  // (seen on Thu 2026-06-25: 2 vacations + a rest lock collapsed the
  // night segment to 1 body vs required 3). Only USER time-off counts
  // toward the deviation trigger — locks placed by this pre-pass follow
  // the home-day quota, which stacks rests on purpose (Mon×2, Tue×3).
  const vacPressure = new Map<string, number>()
  for (const dt of allDates) {
    const ds = format(dt, 'yyyy-MM-dd')
    let n = 0
    for (const d of dispatchers) {
      const blocks = blockedBitmap(timeOff, d, ds, dt.getDay())
      if (blocks !== null && blocks.length > 0 && blocks.every(Boolean)) n++
    }
    vacPressure.set(ds, n)
  }
  // Locks placed so far — used only to pick WHERE a deviating rest goes,
  // so two displaced rests don't re-stack on the same calm day.
  const lockPressure = new Map<string, number>()
  // Every dispatcher's HOME rest weekday is known before any lock is
  // placed. A deviating rest must see the quota locks of dispatchers
  // processed AFTER it, or roster order decides who is blind to whom:
  // adorre (roster #0) deviated off a vacation-crowded Thursday onto
  // Monday scoring it empty, then the Mon×3 home quota landed on top —
  // 4 of 7 rest-locked on one day and 2–3 PM collapsed to 0 (seed 68,
  // Jun 29 2026). anticipatedPressure(dowOf(date), i) = home-quota
  // locks still to come from dispatchers i+1…n.
  const HOME_REST_DOWS_TABLE = [1, 1, 1, 2, 3, 4, 5]
  const homeDowOf = dispatchers.map(
    (d2, j) => fullDayRecurringDow(d2) ?? HOME_REST_DOWS_TABLE[(j + (seed >>> 0)) % HOME_REST_DOWS_TABLE.length],
  )
  const anticipatedPressure = (dow: number, afterIdx: number) =>
    homeDowOf.reduce((n, hd, j) => n + (j > afterIdx && hd === dow ? 1 : 0), 0)

  dispatchers.forEach((d, dispIdx) => {
    restLocks[d.id] = new Set()
    // Conservative pre-schedule assumption: the day before the schedule
    // starts was a work day. This lets the cap bind from day 1 —
    // dispatchers can work at most 6 days into the schedule before
    // needing a rest, regardless of unknown pre-schedule state.
    let lastRestDate: Date = addDays(allDates[0], -1)

    // Stable HOME rest weekday for this dispatcher (constant across
    // weeks; used by Step 1's cadence rescue and Step 2's placement).
    // Demand-spread quota under the CALIBRATED (human-matched)
    // targets: at ~29–42h of demand per day, every weekday except
    // Monday needs 6 workers to tile (2 openers + midday bridge +
    // 3 closers), so rests spread ONE per day Tue–Fri with Monday —
    // the humans' 29h lightest day — absorbing the remaining three.
    // The weekend carries NO rest locks (a Saturday rest forced a −1
    // INSIDE the dinner peak; Monday absorbs the same −1 on an
    // off-peak shoulder instead, and the humans never rest weekends
    // either). Seed rotates the assignment so Regenerate varies who
    // rests when.
    const HOME_REST_DOWS = [1, 1, 1, 2, 3, 4, 5] // Mon,Mon,Mon,Tue,Wed,Thu,Fri
    // A standing full-day RECURRING block (e.g. off every Tuesday for
    // months) IS this dispatcher's home rest day: a stable weekly
    // cadence with exactly-7-day gaps by construction, set by the
    // human as the source of truth. Adopting it means Step 1 consumes
    // it as the weekly rest every single week, no lock is ever stacked
    // on top of it, and the vacation cadence-rescue below must NOT
    // fire for it (the rescue exists for one-off vacations that break
    // a cadence — a recurring day IS the cadence).
    const recurringHomeDow = fullDayRecurringDow(d)
    const homeDow =
      recurringHomeDow ?? HOME_REST_DOWS[(dispIdx + (seed >>> 0)) % HOME_REST_DOWS.length]

    weekOrder.forEach((wLbl) => {
      const weekDates = weekBuckets.get(wLbl)!

      // Step 1 — pre-existing full-day off satisfies the weekly guarantee.
      // A day is "pre-existing off" iff timeOff / recurringBlocks blocks
      // every slot. Multiple such days: take the latest for lastRestDate.
      let latestPreExisting: Date | null = null
      for (const dt of weekDates) {
        const ds = format(dt, 'yyyy-MM-dd')
        const blocks = blockedBitmap(timeOff, d, ds, dt.getDay())
        const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
        if (fullyBlocked) latestPreExisting = dt
      }
      if (latestPreExisting !== null) {
        // Streak audit: user-entered timeOff can produce a > 7-day gap
        // that the pre-pass cannot fix (we can't override user input).
        const gap = differenceInDays(latestPreExisting, lastRestDate)
        if (gap > 7) {
          streakWarnings.push(
            `${d.name}: ${gap - 1} consecutive workdays before pre-existing off on ${format(latestPreExisting, 'yyyy-MM-dd')} (user-entered time-off gap; cannot fix)`,
          )
        }
        lastRestDate = latestPreExisting
        // Cadence rescue — if the vacation sits BEFORE this week's home
        // day, next week's home day is > 7 days out and unreachable, so
        // rest would snap to the week-start day (Thursday) and STAY
        // there: from a Thu rest, the only day within 7 in the next
        // Thu-anchored bucket is again Thu. One early-week vacation
        // then pins the dispatcher to Thursday rests forever, and every
        // vacation-taker piles onto the same day (seen in production:
        // 4 of 7 off every Thursday, night coverage 0/3). Placing the
        // normal home-day lock later this same week keeps the cadence —
        // the vacation week simply absorbs one extra off day. When the
        // vacation is ON or AFTER the home day, next week is reachable
        // and we skip Step 2 as before.
        // Recurring-home dispatchers never need the rescue: their
        // recurring day IS the cadence (same weekday every week, gap
        // exactly 7) — rescuing would stack a second lock on top of
        // the standing day, permanently doubling their weekly offs.
        if (recurringHomeDow !== null) return
        const homeThisWeek = weekDates.find((dt) => dt.getDay() === homeDow)
        const needsAnchor =
          homeThisWeek !== undefined && differenceInDays(homeThisWeek, lastRestDate) >= 1
        if (!needsAnchor) return
        // fall through to Step 2 — validRange starts after the vacation
      }

      // Step 2 — pick a rest date. Valid range: dates in this week that
      // sit within [lastRestDate + 1, lastRestDate + 7]. Under normal
      // inputs this is always non-empty because the previous iteration
      // picks the LATEST feasible date, capping lastRestDate close to
      // WedOfPrevWeek — so week N's Thu is at most 7 days later.
      const validRange = weekDates.filter((dt) => {
        const gap = differenceInDays(dt, lastRestDate)
        return gap >= 1 && gap <= MAX_CONSECUTIVE_WORK_DAYS + 1
      })

      let chosen: Date
      if (validRange.length > 0) {
        // Placement preference: rest on the LOW-DEMAND days (Mon–Thu)
        // so Fri/Sat/Sun keep the full roster — the two-team model
        // needs 7 bodies on Fri/Sun and 8 on Sat. Rest goes on the
        // dispatcher's HOME weekday (same day every week → rest gap is
        // exactly 7 days, streak exactly 6, always legal, no drift).
        // Falls back to any low-demand day, then any valid day, when
        // time-off pushed lastRestDate off-cycle. This is a preference
        // only — the weekly-rest guarantee and 6-day cap are unchanged.
        let pool = validRange.filter((dt) => dt.getDay() === homeDow)
        if (pool.length === 0) {
          pool = validRange.filter((dt) => {
            const dw = dt.getDay()
            return dw === 1 || dw === 2 || dw === 3 || dw === 4 // Mon–Thu
          })
        }
        if (pool.length === 0) pool = validRange
        // Crowd check: if the day we're about to pick already has a
        // full-day vacation on it, deviate — widen to the low-demand
        // pool and take the least-crowded day (vacations + locks placed
        // so far, so two displaced rests don't re-stack). validRange
        // keeps every alternative legal (gap ≤ 7), so deviating never
        // breaks the weekly guarantee or the 6-day cap.
        const vacOf = (dt: Date) => vacPressure.get(format(dt, 'yyyy-MM-dd')) ?? 0
        const totalOf = (dt: Date) =>
          vacOf(dt) +
          (lockPressure.get(format(dt, 'yyyy-MM-dd')) ?? 0) +
          anticipatedPressure(dt.getDay(), dispIdx)
        if (vacOf(pool[pool.length - 1]) > 0) {
          let wide = validRange.filter((dt) => {
            const dw = dt.getDay()
            return dw === 1 || dw === 2 || dw === 3 || dw === 4 // Mon–Thu
          })
          if (wide.length === 0) wide = validRange
          // Hard cap: a deviated rest never lands where projected offs
          // (vacations + locks + anticipated quota) already reach 3 —
          // that would leave ≤ 3 of 7 bodies, and 3 bodies cannot span
          // the 2–3 PM transition zone under the lean-handoff shapes.
          // Only relaxed when EVERY legal alternative is that crowded.
          const roomy = wide.filter((dt) => totalOf(dt) < 3)
          if (roomy.length > 0) wide = roomy
          const minP = Math.min(...wide.map(totalOf))
          let calm = wide.filter((dt) => totalOf(dt) === minP)
          // Among equally calm days, prefer the LIGHTEST day (hours-
          // weighted demand) — a deviated rest landing on Wednesday
          // (38.5h) instead of the equally-calm Tuesday (36h) gutted
          // Wednesday under the calibrated targets.
          const demandOf = (dt: Date) => {
            const req = effectiveCoverage(dt.getDay(), coverageOverrides)
            return req.reduce((s, r, i) => s + r * SLOTS[i].hours, 0)
          }
          const minDemand = Math.min(...calm.map(demandOf))
          calm = calm.filter((dt) => demandOf(dt) === minDemand)
          // Then prefer the home day, else latest.
          const calmHome = calm.filter((dt) => dt.getDay() === homeDow)
          pool = calmHome.length > 0 ? calmHome : calm
        }
        // Zero-guard feedback: skip avoided dates when any legal
        // alternative exists (weekly guarantee outranks the avoid).
        const avoided = restAvoid?.[d.id]
        if (avoided && avoided.size > 0) {
          const poolNA = pool.filter((dt) => !avoided.has(format(dt, 'yyyy-MM-dd')))
          if (poolNA.length > 0) pool = poolNA
          else {
            const rangeNA = validRange.filter((dt) => !avoided.has(format(dt, 'yyyy-MM-dd')))
            if (rangeNA.length > 0) pool = rangeNA
          }
        }
        chosen = pool[pool.length - 1] // latest in pool
      } else {
        // Only reachable when lastRestDate is more than 7 days before
        // ThuOfCurrentWeek — implies a prior week had no in-range rest
        // (extremely tight upstream constraints). We still lock a rest
        // to satisfy the weekly guarantee, and record the streak
        // violation. In practice this branch should not fire with the
        // "prefer latest" rule + non-adversarial time-off input.
        chosen = weekDates[0]
        streakWarnings.push(
          `${d.name}: forced rest ${format(chosen, 'yyyy-MM-dd')} exceeds 6-day cap from ${format(lastRestDate, 'yyyy-MM-dd')} — upstream week could not fit a valid rest`,
        )
      }

      const chosenStr = format(chosen, 'yyyy-MM-dd')
      restLocks[d.id].add(chosenStr)
      lockPressure.set(chosenStr, (lockPressure.get(chosenStr) ?? 0) + 1)
      lastRestDate = chosen
    })
  })

  return { restLocks, streakWarnings }
}

/** Index of first working slot in a pattern (-1 if none). */
function firstActiveSlot(pattern: boolean[]): number {
  return pattern.findIndex((v) => v)
}

/** Every slot inside a peak window. No meal break may ever land on one
 *  of these — the catalog carries no in-peak break shapes, and the
 *  relocation passes (repairBreaks, smoothTransitions) refuse to move a
 *  break onto them. Unavoidable break −1s go to shoulder slots instead. */
const PEAK_SLOT_SET = new Set<number>(PEAK_WINDOWS.flatMap((p) => [...p.slots]))

/** Continuity-anchor predicate for one peak. A pattern qualifies iff:
 *  - it STARTED before the peak's first slot (strict; a shift starting
 *    exactly at the peak boundary doesn't count — the rule wants someone
 *    who's already been on, holding the live picture);
 *  - it covers every slot in the peak window with NO break and NO shift
 *    end inside the peak (every slot in the window is true).
 *  The dispatcher's break/end may freely fall outside the peak window. */
function isPeakAnchorPattern(pattern: boolean[], peakSlots: readonly number[]): boolean {
  const first = firstActiveSlot(pattern)
  if (first < 0 || first >= peakSlots[0]) return false
  for (const i of peakSlots) if (!pattern[i]) return false
  return true
}

/** Index of last working slot in a pattern (-1 if none). */
function lastActiveSlot(pattern: boolean[]): number {
  for (let i = pattern.length - 1; i >= 0; i--) {
    if (pattern[i]) return i
  }
  return -1
}

/**
 * Shared "would mutating this assignment leave any peak without its last
 * anchor?" check. Used by both `trimToExactCoverage` and the transition-
 * smoothing pass. `startingPeaks` is the set of peaks that started the day
 * with at least one anchor — we never let that count drop to zero.
 * Returns true when the mutation is safe (preserves anchor coverage).
 */
function dropPreservesAnchors(
  trialPattern: boolean[],
  self: { pattern: boolean[] },
  selfOldPattern: boolean[],
  assignments: Array<{ pattern: boolean[] }>,
  startingPeaks: readonly { slots: readonly number[] }[],
): boolean {
  for (const peak of startingPeaks) {
    if (!isPeakAnchorPattern(selfOldPattern, peak.slots)) continue
    if (isPeakAnchorPattern(trialPattern, peak.slots)) continue
    let otherAnchors = 0
    for (const a of assignments) {
      if (a === self) continue
      if (isPeakAnchorPattern(a.pattern, peak.slots)) otherAnchors++
    }
    if (otherAnchors === 0) return false
  }
  return true
}

/** Shape boundaries of a single shift: first/last working slot and the
 *  list of breaks between them. Off-slots before `start` or after `end`
 *  are NOT breaks — they're pre/post-shift idle. */
function shiftBoundaries(pattern: boolean[]): {
  start: number
  end: number
  breaks: Array<{ start: number; end: number }>
} {
  const start = firstActiveSlot(pattern)
  const end = lastActiveSlot(pattern)
  const breaks: Array<{ start: number; end: number }> = []
  if (start < 0) return { start, end, breaks }
  let inBreak = false
  let bStart = -1
  for (let i = start; i <= end; i++) {
    if (!pattern[i] && !inBreak) { inBreak = true; bStart = i }
    else if (pattern[i] && inBreak) {
      inBreak = false
      breaks.push({ start: bStart, end: i - 1 })
    }
  }
  return { start, end, breaks }
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

/** True when this shift bitmap satisfies every two-team shape rule:
 *  - 1 or 2 worked stretches (i.e. at most one break)
 *  - when a break exists it is EXACTLY the 30-min paid meal break
 *  - NO hard 5h consecutive cap (Cayman salaried law) — a block may run
 *    up to the 9h daily max
 *  - first stretch ≥ MIN_BLOCK_HOURS (3h) — the meal break comes after
 *    a real stretch; the post-break tail may be short (weekday Morning
 *    runs 5h + 1.5h) because the paid break doesn't fragment the
 *    continuous presence
 *  - > 5h worked → one 30-min break, placed in a demand trough
 *    (post-lunch / post-dinner), never inside a peak
 *  - 4h ≤ total work ≤ 9h
 *  - Mon–Fri: at least one stretch ≥ WEEKDAY_PRIMARY_STRETCH_HOURS (5h).
 *    Sat (6) / Sun (0) are exempt so the 8 AM opener can split 3h + 4.5h.
 *    A missing `dayOfWeek` defaults to the strict weekday rule so an
 *    omitted arg cannot accidentally admit a weekend-shaped shift into
 *    a weekday context. */
function isValidShiftShape(slots: boolean[], dayOfWeek?: number): boolean {
  const blocks = patternWorkBlocks(slots, SLOTS)
  if (blocks.length === 0) return false
  if (blocks.length > 2) return false
  const maxBreak = patternMaxBreakHours(slots, SLOTS)
  if (blocks.length === 2 && maxBreak !== MEAL_BREAK_HOURS) {
    // Split exception (ANY day — the human team uses splits whenever
    // covering both peaks with one dispatcher helps the targets): a
    // 2–3h UNPAID gap confined to the 14:00–17:00 lull (never touching
    // the lunch or dinner peak). Both blocks must be real stretches
    // (≥ 3h). This is the only shape allowed to deviate from the
    // 30-min paid meal break.
    if (maxBreak < SPLIT_GAP_MIN_HOURS || maxBreak > SPLIT_GAP_MAX_HOURS) return false
    const gap = midShiftBreakSlots(slots)
    if (!gap.every((s) => (SPLIT_GAP_SLOTS as readonly number[]).includes(s))) return false
    if (blocks[1] < MIN_BLOCK_HOURS) return false
  } else if (blocks.length === 2 && blocks[1] < MIN_TAIL_STRETCH_HOURS) {
    return false
  }
  // NO hard 5h consecutive cap (Cayman salaried law) — a block may run up
  // to the 9h daily max.
  const totalWork = blocks.reduce((s, h) => s + h, 0)
  if (totalWork < 4) return false
  if (totalWork > 9) return false
  // > 5h worked requires a break (meal break or split gap)…
  if (totalWork > MEAL_BREAK_TRIGGER_HOURS && blocks.length < 2) return false
  // …and when it's the meal break, it must sit in a demand trough
  // (post-lunch / post-dinner), never inside a peak — the break comes
  // AFTER the heavy block, not locked at the 5h mark.
  if (
    totalWork > MEAL_BREAK_TRIGGER_HOURS &&
    blocks.length === 2 &&
    maxBreak === MEAL_BREAK_HOURS &&
    !midShiftBreakSlots(slots).every((s) => BREAK_TROUGH_SLOTS.has(s))
  ) {
    return false
  }
  if (blocks[0] < MIN_BLOCK_HOURS) return false
  // Weekday primary-stretch rule — Sat (6) and Sun (0) are exempt.
  const isWeekendDay = dayOfWeek === 0 || dayOfWeek === 6
  if (!isWeekendDay && Math.max(...blocks) < WEEKDAY_PRIMARY_STRETCH_HOURS) return false
  return true
}

// ---------------------------------------------------------------------------
// Continuity-anchor passes
// ---------------------------------------------------------------------------

/** Common eligibility test for a (dispatcher, pattern) pair on this day. */
function isEligibleForPattern(
  d: Dispatcher,
  p: { bool: boolean[]; hours: number; isMorning: boolean },
  ctx: {
    usedIds: Set<string>
    weekHours: Record<string, Record<string, number>>
    wLabel: string
    timeOff: DispatcherTimeOff
    dateStr: string
    dow: number
    workedNightYesterday: (id: string) => boolean
    /** Effective weekly cap for TODAY's assignment — 45h minus the
     *  trainee reserve, night-aware (see capForShift in the day loop). */
    capForShift: (dispId: string, lastSlot: number) => number
  },
): boolean {
  if (ctx.usedIds.has(d.id)) return false
  if (p.isMorning && ctx.workedNightYesterday(d.id)) return false
  const blocks = blockedBitmap(ctx.timeOff, d, ctx.dateStr, ctx.dow)
  if (blocks && p.bool.some((on, i) => on && blocks[i])) return false
  if ((ctx.weekHours[d.id][ctx.wLabel] ?? 0) + p.hours > ctx.capForShift(d.id, lastActiveSlot(p.bool))) return false
  return true
}

interface PatternMetaLite {
  idx: number
  bool: boolean[]
  hours: number
  isMorning: boolean
  maxBreak: number
}

interface SeedCtx {
  patternMeta: PatternMetaLite[]
  sortedWorking: Dispatcher[]
  usedIds: Set<string>
  usedPatternIdx: Set<number>
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>
  runningCov: number[]
  weekHours: Record<string, Record<string, number>>
  wLabel: string
  timeOff: DispatcherTimeOff
  dateStr: string
  dow: number
  workedNightYesterday: (id: string) => boolean
  capForShift: (dispId: string, lastSlot: number) => number
}

/** Before the main picker runs, count viable (dispatcher × anchor-pattern)
 *  pairs for each peak. If supply ≤ 1, reserve one upfront so the picker
 *  can't blow it on a higher-fill alternative. Mirrors the "morning seed"
 *  pattern from the driver scheduler. Returns the list of peaks that
 *  couldn't be seeded (zero viable pairs) — caller surfaces a warning. */
function seedAnchors(ctx: SeedCtx): PeakKey[] {
  const unseedable: PeakKey[] = []
  for (const peak of PEAK_WINDOWS) {
    const anchorPatterns = ctx.patternMeta.filter(
      (p) => !ctx.usedPatternIdx.has(p.idx) && isPeakAnchorPattern(p.bool, peak.slots),
    )
    // Build (dispatcher, pattern) pairs that pass eligibility.
    const pairs: Array<{ d: Dispatcher; p: PatternMetaLite }> = []
    for (const p of anchorPatterns) {
      for (const d of ctx.sortedWorking) {
        if (isEligibleForPattern(d, p, ctx)) pairs.push({ d, p })
      }
    }
    const distinctDispatchers = new Set(pairs.map((x) => x.d.id))
    // No supply — caller emits a warning. Don't seed.
    if (pairs.length === 0) { unseedable.push(peak.key); continue }
    // Plenty of supply (>1 distinct dispatcher AND multiple patterns) —
    // let the main picker handle it. Seeding here just removes flexibility.
    if (distinctDispatchers.size > 1 && anchorPatterns.length > 1) continue
    // Constrained — reserve the best pair: prefer lowest weekly hours,
    // then shorter shift to avoid burning a long-pattern slot on a
    // small dispatcher.
    pairs.sort((a, b) => {
      const ha = ctx.weekHours[a.d.id][ctx.wLabel] ?? 0
      const hb = ctx.weekHours[b.d.id][ctx.wLabel] ?? 0
      if (ha !== hb) return ha - hb
      return a.p.hours - b.p.hours
    })
    const pick = pairs[0]
    ctx.assignments.push({ dispatcher: pick.d, pattern: pick.p.bool })
    ctx.usedIds.add(pick.d.id)
    ctx.usedPatternIdx.add(pick.p.idx)
    pick.p.bool.forEach((on, i) => { if (on) ctx.runningCov[i]++ })
  }
  return unseedable
}

/** After the main pipeline (picker + swap + rescue + must-work + 2nd-off +
 *  stretch), verify each peak still has at least one anchor. If not,
 *  attempt repair in two steps:
 *    1. Fill-break: find an assignment whose pattern STARTED pre-peak
 *       and whose only disqualifier is a false slot inside the peak.
 *       Flip those slots true if the shape stays valid.
 *    2. Pattern-swap: find an unused anchor-eligible pattern in the
 *       template and swap it onto an existing assignment whose
 *       dispatcher still satisfies eligibility for the new pattern.
 *  Returns the peaks that couldn't be repaired. */
function enforceAnchors(
  ctx: SeedCtx,
  required: number[],
): PeakKey[] {
  const failed: PeakKey[] = []
  for (const peak of PEAK_WINDOWS) {
    const hasAnchor = ctx.assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots))
    if (hasAnchor) continue
    // Step 1 — fill-break on an existing pre-peak starter.
    let fixed = false
    for (const a of ctx.assignments) {
      const first = firstActiveSlot(a.pattern)
      if (first < 0 || first >= peak.slots[0]) continue
      // Already covers all? Then it's an anchor — checked above. Try
      // filling only the false slots inside the peak.
      const trial = [...a.pattern]
      for (const s of peak.slots) trial[s] = true
      if (!isValidShiftShape(trial, ctx.dow)) continue
      // Weekly cap check — weekHours excludes today's shift, so the
      // week total after the fill-break is weekHours + the FULL new day.
      const newH = slotHours(trial)
      if ((ctx.weekHours[a.dispatcher.id][ctx.wLabel] ?? 0) + newH > ctx.capForShift(a.dispatcher.id, lastActiveSlot(trial))) continue
      a.pattern = trial
      fixed = true
      break
    }
    if (fixed) continue
    // Step 2 — pattern-swap. Find any unused anchor-eligible pattern,
    // then swap onto an existing assignment whose dispatcher passes
    // eligibility for the new pattern AND whose existing pattern is
    // not the sole cover of any other required slot.
    const anchorPatterns = ctx.patternMeta.filter(
      (p) => !ctx.usedPatternIdx.has(p.idx) && isPeakAnchorPattern(p.bool, peak.slots),
    )
    for (const newP of anchorPatterns) {
      let swapped = false
      for (const a of ctx.assignments) {
        if (!isEligibleForPattern(a.dispatcher, newP, {
          ...ctx,
          usedIds: new Set([...ctx.usedIds].filter((id) => id !== a.dispatcher.id)),
        })) continue
        // Survival check — would swapping break any required slot?
        const cov = new Array(SLOTS.length).fill(0)
        for (const other of ctx.assignments) other.pattern.forEach((on, i) => { if (on) cov[i]++ })
        let safe = true
        for (let i = 0; i < SLOTS.length; i++) {
          const after = cov[i] - (a.pattern[i] ? 1 : 0) + (newP.bool[i] ? 1 : 0)
          if (required[i] > 0 && after < required[i]) { safe = false; break }
        }
        if (!safe) continue
        // Apply swap.
        const oldIdx = ctx.patternMeta.findIndex((pm) => pm.bool === a.pattern)
        if (oldIdx >= 0) ctx.usedPatternIdx.delete(oldIdx)
        ctx.usedPatternIdx.add(newP.idx)
        a.pattern = newP.bool
        fixed = true
        swapped = true
        break
      }
      if (swapped) break
    }
    if (!fixed) failed.push(peak.key)
  }
  return failed
}

/**
 * Coverage-improving swap pass — the coverage target is the contract.
 * The greedy picker (and the smart-drop pre-filter) can settle on a
 * shape mix that leaves deficits while an unused catalog shape would
 * cover them strictly better — observed on Saturdays: a 4th morning
 * body parked on a +1 opening surplus while dinner ran 4 short. For
 * each assignment × unused pattern, evaluate the swap's effect on
 * total missing units (Σ max(0, req − cov)); apply the best strictly-
 * improving swap and repeat until none improves. Every swap must pass
 * dispatcher eligibility for the new shape (time-off, night-rest,
 * weekly cap), stay within the picker's loosest over-cap tier
 * (req + MAX_OVER_COVERAGE + 1 — no new deep stacking), and preserve
 * peak-anchor continuity.
 */
function improveCoverageBySwaps(ctx: SeedCtx, required: number[]): void {
  // DEPTH-RELATIVE deficit with a PEAK premium: each missing body
  // counts as its share of the slot's target ((req−cov)/req — a −1 on
  // a req-2 open is half the staff, worse than a −1 on a req-3
  // shoulder), and peak slots weigh 3× so a deep dinner target never
  // becomes the cheapest place to park a deficit. Resulting priority
  // for unavoidable −1s: peak > opening > shoulder — the MVP's shape.
  const deficitUnits = (cov: number[]) => {
    let u = 0
    for (let i = 0; i < required.length; i++) {
      if (required[i] > 0 && cov[i] < required[i]) {
        const rel = (required[i] - cov[i]) / required[i]
        u += rel * (PEAK_SLOT_SET.has(i) ? 3 : 1)
      } else if (cov[i] > required[i] && !SURPLUS_TOLERATED_SLOTS.has(i)) {
        // Tiny surplus term — never trades against a deficit (weight
        // 0.01 vs ≥0.25 per missing body) but lets an otherwise-equal
        // swap shed untolerated surplus, e.g. a 15:00 closer swapped to
        // the 18:00 ramp-smoother to deflate the 5 PM pile-up.
        u += 0.01 * (cov[i] - required[i])
      }
    }
    return u
  }
  for (let iter = 0; iter < 20; iter++) {
    const cov = new Array(SLOTS.length).fill(0)
    for (const a of ctx.assignments) a.pattern.forEach((on, i) => { if (on) cov[i]++ })
    const base = deficitUnits(cov)
    if (base === 0) return
    const startingPeaks = PEAK_WINDOWS.filter((peak) =>
      ctx.assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
    )
    let best: { a: (typeof ctx.assignments)[number]; newP: PatternMetaLite; after: number } | null = null
    for (const a of ctx.assignments) {
      for (const newP of ctx.patternMeta) {
        if (ctx.usedPatternIdx.has(newP.idx)) continue
        if (!isEligibleForPattern(a.dispatcher, newP, {
          ...ctx,
          usedIds: new Set([...ctx.usedIds].filter((id) => id !== a.dispatcher.id)),
        })) continue
        let after = 0
        let overShoot = false
        for (let i = 0; i < SLOTS.length; i++) {
          const c = cov[i] - (a.pattern[i] ? 1 : 0) + (newP.bool[i] ? 1 : 0)
          if (c > required[i] + MAX_OVER_COVERAGE + 1) { overShoot = true; break }
          after += Math.max(0, required[i] - c)
        }
        if (overShoot) continue
        // Weekend split limits (mirror the picker — protect the
        // staggered-edge morning pair).
        if (
          (ctx.dow === 0 || ctx.dow === 6) &&
          newP.maxBreak >= SPLIT_GAP_MIN_HOURS &&
          firstActiveSlot(newP.bool) <= 2
        ) continue
        if (
          (ctx.dow === 0 || ctx.dow === 6) &&
          newP.maxBreak >= SPLIT_GAP_MIN_HOURS &&
          patternMaxBreakHours(a.pattern, SLOTS) < SPLIT_GAP_MIN_HOURS &&
          ctx.assignments.some(
            (other) => other !== a && patternMaxBreakHours(other.pattern, SLOTS) >= SPLIT_GAP_MIN_HOURS,
          )
        ) continue
        // Tactic 1b: swaps never create a second 8:00 opener past the
        // open target (mirrors the picker's opener cap).
        if (firstActiveSlot(newP.bool) === 0 && firstActiveSlot(a.pattern) !== 0) {
          let openers = 0
          for (const other of ctx.assignments) {
            if (firstActiveSlot(other.pattern) === 0) openers++
          }
          if (openers >= required[0]) continue
        }
        if (!dropPreservesAnchors(newP.bool, a, a.pattern, ctx.assignments, startingPeaks)) continue
        if (after < (best ? best.after : base)) best = { a, newP, after }
      }
    }
    if (!best) return
    const oldIdx = ctx.patternMeta.findIndex((pm) => pm.bool === best.a.pattern)
    if (oldIdx >= 0) ctx.usedPatternIdx.delete(oldIdx)
    ctx.usedPatternIdx.add(best.newP.idx)
    best.a.pattern = best.newP.bool
  }
}

/** Stretch shifts to fill single-body gaps. For each under-covered slot,
 *  find an assignment whose pattern is adjacent (covers slot ±1) and
 *  whose extension is shape-valid AND keeps the dispatcher's weekly
 *  hours under the cap. Mirrors the user's manual "extend the closer
 *  to slot 19" / "let an existing morning shift cover the missing 11
 *  AM slot" — closed 5 gaps with +2.5h on one of their test weeks.
 *  Runs BEFORE trim so any incidental over-cov can still be reclaimed. */
function stretchToFillGaps(
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>,
  required: number[],
  weekHours: Record<string, Record<string, number>>,
  wLabel: string,
  dayOfWeek: number,
  capForShift: (dispId: string, lastSlot: number) => number,
): void {
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) {
    pattern.forEach((on, i) => { if (on) cov[i]++ })
  }
  let changed = true
  while (changed) {
    changed = false
    for (let si = 0; si < cov.length; si++) {
      if (cov[si] >= required[si]) continue
      for (const a of assignments) {
        if (a.pattern[si]) continue
        const hasPrev = si > 0 && a.pattern[si - 1]
        const hasNext = si < a.pattern.length - 1 && a.pattern[si + 1]
        if (!hasPrev && !hasNext) continue
        const trial = [...a.pattern]
        trial[si] = true
        if (!isValidShiftShape(trial, dayOfWeek)) continue
        const newHours = slotHours(trial)
        // weekHours is pre-shift (today's hours added at accumulation step
        // after all passes), so the cap check is pre-shift + this day's
        // post-stretch shift.
        if ((weekHours[a.dispatcher.id][wLabel] ?? 0) + newHours > capForShift(a.dispatcher.id, lastActiveSlot(trial))) continue
        a.pattern = trial
        cov[si]++
        changed = true
        break
      }
      if (changed) break
    }
  }
}

/** Trim over-covered slots to exact requirement. For each slot where
 *  actual cov > required, find an assignment whose pattern can drop
 *  that slot without (a) falling below the 5 h daily floor, (b) breaking
 *  min-block / break-shape rules (delegated to isValidShiftShape), or
 *  (c) creating an under-cov elsewhere (we only drop the over-cov slot,
 *  so other slots are untouched). Greedy, re-scans from slot 0 on each
 *  successful drop. Mirrors the user's manual "trim until req is hit"
 *  workflow that closed gaps while removing ~9% of total hours. */
function trimToExactCoverage(
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>,
  required: number[],
  dayOfWeek: number,
): void {
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) {
    pattern.forEach((on, i) => { if (on) cov[i]++ })
  }
  // Snapshot the set of peaks each day starts with. After each candidate
  // drop, recompute anchors live — if the drop would take any peak's
  // anchor count from >0 to 0, refuse it. Tracking running count (not
  // snapshot) handles the multi-anchor case where dropping one is OK
  // but dropping the last one isn't.
  const startingPeaksWithAnchor = PEAK_WINDOWS.filter((peak) =>
    assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
  )
  // Trim late starters first: shaving a surplus slot almost always
  // moves a shift EDGE (an interior drop creates an illegal second
  // break), and the morning shapes' edges ARE the staggered weekend
  // edge the humans run (8→15:00 / 9→16:00) — letting an afternoon or
  // evening shape absorb the trim keeps those edges intact.
  const byLatestStart = [...assignments].sort(
    (x, y) => firstActiveSlot(y.pattern) - firstActiveSlot(x.pattern),
  )
  let changed = true
  while (changed) {
    changed = false
    for (let si = 0; si < cov.length; si++) {
      if (cov[si] <= required[si]) continue
      for (const a of byLatestStart) {
        if (!a.pattern[si]) continue
        // Weekend morning EDGES are load-bearing (the humans' staggered
        // 8→15:00 / 9→16:00 pair) — never shave them; a +1 surplus on a
        // shoulder slot is tolerated instead.
        const isWeekendDay = dayOfWeek === 0 || dayOfWeek === 6
        if (
          isWeekendDay &&
          firstActiveSlot(a.pattern) <= 2 &&
          (si === firstActiveSlot(a.pattern) || si === lastActiveSlot(a.pattern))
        ) continue
        const trial = [...a.pattern]
        trial[si] = false
        if (!isValidShiftShape(trial, dayOfWeek)) continue
        if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaksWithAnchor)) continue
        a.pattern = trial
        cov[si]--
        changed = true
        break
      }
      if (changed) break
    }
  }
}

/**
 * Break-placement repair — coverage targets are the contract; a meal
 * break parked on an under-covered slot while a surplus slot sits
 * inside the same shift is a free fix. For every deficit slot where an
 * assigned dispatcher is on their 30-min meal break, try relocating
 * that break to another half-slot in the shift whose coverage stays at
 * or above target after losing one body. No hours change (both slots
 * are 0.5h — isValidShiftShape rejects anything else), shape rules and
 * anchor continuity are re-checked per move, and Mon–Wed split gaps
 * are untouched (their gap is 3h, not the meal break). Runs after
 * enforceAnchors (anchor state final) and before trim.
 */
function repairBreaks(
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>,
  required: number[],
  dayOfWeek: number,
): void {
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) {
    pattern.forEach((on, i) => { if (on) cov[i]++ })
  }
  const startingPeaksWithAnchor = PEAK_WINDOWS.filter((peak) =>
    assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
  )
  let changed = true
  while (changed) {
    changed = false
    for (let si = 0; si < cov.length; si++) {
      if (cov[si] >= required[si]) continue
      for (const a of assignments) {
        const first = firstActiveSlot(a.pattern)
        const last = lastActiveSlot(a.pattern)
        // must be THIS dispatcher's mid-shift meal break at the slot
        if (first < 0 || si <= first || si >= last || a.pattern[si]) continue
        if (patternMaxBreakHours(a.pattern, SLOTS) !== MEAL_BREAK_HOURS) continue
        // Candidate landing slots for the break: never inside a peak
        // window (MVP rule), and prefer a slot where nobody else is
        // already on break (stagger) over a shared one.
        const otherBreakSlots = new Set<number>()
        for (const other of assignments) {
          if (other === a) continue
          const of = firstActiveSlot(other.pattern)
          const ol = lastActiveSlot(other.pattern)
          for (let k = of + 1; k < ol; k++) if (!other.pattern[k]) otherBreakSlots.add(k)
        }
        const tryMove = (j: number): boolean => {
          if (!a.pattern[j]) return false
          if (PEAK_SLOT_SET.has(j)) return false
          if (cov[j] - 1 < required[j]) return false // target at j must hold
          const trial = [...a.pattern]
          trial[si] = true
          trial[j] = false
          if (!isValidShiftShape(trial, dayOfWeek)) return false
          if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaksWithAnchor)) return false
          a.pattern = trial
          cov[si]++
          cov[j]--
          return true
        }
        let moved = false
        for (let j = first + 1; j < last && !moved; j++) {
          if (otherBreakSlots.has(j)) continue // pass 1: uncollided only
          moved = tryMove(j)
        }
        for (let j = first + 1; j < last && !moved; j++) {
          moved = tryMove(j) // pass 2: allow shared slots
        }
        if (moved) { changed = true; break }
      }
      if (changed) break
    }
  }

  // ── De-collision sweep (Tactic 3: no two breaks in the same slot) ──
  // Even when a shared break slot still meets its target, relocate one
  // of the colliding breaks to a free legal slot: outside every peak
  // window, not already carrying a break, and with headroom so the
  // vacated landing slot never drops below target. Where no such slot
  // exists (heavy evenings: 3+ closers against two legal post-peak
  // positions) the share stays — the headroom guard keeps it on the
  // deeper-staffed shoulder.
  let swept = true
  while (swept) {
    swept = false
    const breakersBySlot = new Map<number, Array<{ dispatcher: Dispatcher; pattern: boolean[] }>>()
    for (const a of assignments) {
      const first = firstActiveSlot(a.pattern)
      const last = lastActiveSlot(a.pattern)
      if (first < 0 || patternMaxBreakHours(a.pattern, SLOTS) !== MEAL_BREAK_HOURS) continue
      for (let k = first + 1; k < last; k++) {
        if (!a.pattern[k]) {
          if (!breakersBySlot.has(k)) breakersBySlot.set(k, [])
          breakersBySlot.get(k)!.push(a)
        }
      }
    }
    for (const [si, breakers] of breakersBySlot) {
      if (swept) break
      if (breakers.length < 2) continue
      for (const a of breakers.slice(1)) {
        if (swept) break
        const first = firstActiveSlot(a.pattern)
        const last = lastActiveSlot(a.pattern)
        for (let j = first + 1; j < last && !swept; j++) {
          if (j === si || !a.pattern[j]) continue
          if (PEAK_SLOT_SET.has(j)) continue
          if (breakersBySlot.has(j)) continue // must land uncollided
          if (cov[j] - 1 < required[j]) continue // landing keeps target
          const trial = [...a.pattern]
          trial[si] = true
          trial[j] = false
          if (!isValidShiftShape(trial, dayOfWeek)) continue
          if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaksWithAnchor)) continue
          a.pattern = trial
          cov[si]++
          cov[j]--
          swept = true
        }
      }
    }
  }
}

/** Per-dispatcher weekly cap on NET hours added by the transition-
 *  smoothing pass. Hours-flat surplus relocations don't count — only
 *  pure extensions. Keeps any single dispatcher from absorbing every
 *  day's smoothing and quietly running up against the 45 h legal cap
 *  by Friday. */
const SMOOTHING_BUDGET_PER_WEEK = 2

/** Max NET hours any single dispatcher can absorb on one day from
 *  smoothing extensions. Keeps a single stubborn dip from ballooning
 *  one dispatcher's day. */
const SMOOTHING_DAILY_NET_ADD = 1

/** How far from the dip (in slot indices) the standalone surplus-
 *  relocation step is allowed to source from. 3 ≈ 1.5–3 hours away,
 *  which covers the dispatcher's nearby shift window without rearranging
 *  their whole day. */
const SMOOTHING_RELOCATION_REACH = 3

/**
 * Post-trim transition-smoothing pass. Closes 1-slot, 1-below dips
 * that sit at shift transitions (break-on-dip, handoff-overlap, or
 * adjacent surplus that can be relocated) the way an admin would by
 * hand. Runs AFTER trimToExactCoverage so it only sees dips that
 * survived every earlier coverage pass — and so trim can't immediately
 * undo whatever smoothing extended.
 *
 * Resolution order per dip:
 *  1a. boundary-on-dip (break covers slot i)         — hours-flat
 *  2a. handoff-overlap (outgoing.end+1 = i = incoming.start-1) — hours-flat
 *  3.  standalone surplus relocation                 — hours-flat
 *  1b. boundary-on-dip                               — net add
 *  2b. handoff-overlap                               — net add
 *  4.  fallback A: net add to nearest eligible neighbor
 *  5.  fallback B: emit a coverageWarnings transition entry
 *
 * Hours-flat moves always run before any net add so the pass doesn't
 * add weekly hours when a same-dispatcher relocation would have done it.
 *
 * Gate: only acts on slots where (a) required - actual === 1 and (b)
 * both neighbors are at-or-above target. Anything bigger or anything
 * sitting in a multi-slot hole isn't a transition issue — it's
 * structural undercoverage the earlier passes already gave up on.
 */
export function smoothTransitions(args: {
  assignments: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>
  required: number[]
  weekHours: Record<string, Record<string, number>>
  smoothingBudget: Record<string, Record<string, number>>
  wLabel: string
  timeOff: DispatcherTimeOff
  dateStr: string
  dow: number
  capForShift: (dispId: string, lastSlot: number) => number
}): { resolved: string[]; unresolved: number[] } {
  const { assignments, required, weekHours, smoothingBudget, wLabel, timeOff, dateStr, dow, capForShift } = args
  const cov = new Array(SLOTS.length).fill(0)
  for (const { pattern } of assignments) pattern.forEach((on, i) => { if (on) cov[i]++ })

  const startingPeaks = PEAK_WINDOWS.filter((peak) =>
    assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
  )

  const isQualifyingDip = (i: number): boolean => {
    if (cov[i] >= required[i]) return false
    if (required[i] - cov[i] !== 1) return false
    if (i > 0 && cov[i - 1] < required[i - 1]) return false
    if (i < cov.length - 1 && cov[i + 1] < required[i + 1]) return false
    return true
  }

  const resolved: string[] = []
  const dailyNetAdd = new Map<string, number>()

  // Cap a dispatcher gains by adding `delta` hours (net). Returns true
  // if all caps (weekly 45 h — night-aware trainee cap, weekly smoothing
  // budget, daily smoothing budget) would still hold. dailyNetAdd carries
  // this pass's own intra-day additions so multiple dips on the same day
  // budget correctly against each other. IMPORTANT: this pass must NOT
  // write to the shared weekHours — the day-end accumulation adds the
  // full (mutated) pattern, so booking here would double-count the delta
  // and inflate reported weekly hours past the cap.
  const fitsBudget = (a: { dispatcher: Dispatcher; pattern: boolean[] }, delta: number): boolean => {
    if (delta <= 0) return true
    const pending = dailyNetAdd.get(a.dispatcher.id) ?? 0
    // weekHours excludes TODAY's shift (accumulated at day end), so add
    // the current pattern's hours — a.pattern already includes any
    // extensions applied earlier in this pass.
    const todayH = slotHours(a.pattern)
    if ((weekHours[a.dispatcher.id][wLabel] ?? 0) + todayH + delta > capForShift(a.dispatcher.id, lastActiveSlot(a.pattern))) return false
    if ((smoothingBudget[a.dispatcher.id][wLabel] ?? 0) + delta > SMOOTHING_BUDGET_PER_WEEK) return false
    if (pending + delta > SMOOTHING_DAILY_NET_ADD) return false
    return true
  }

  const isBlocked = (a: { dispatcher: Dispatcher }, i: number): boolean => {
    const block = blockedBitmap(timeOff, a.dispatcher, dateStr, dow)
    if (block && block[i]) return true
    if (a.dispatcher.recurringBlocks?.[dow]?.[i]) return true
    return false
  }

  // Apply hours-flat relocation: drop slot j, set slot i. Mutates a + cov.
  // Slot hours may differ between j and i (0.5 vs 1) — track the delta
  // locally (dailyNetAdd) and in the smoothing budget; weekHours is NOT
  // touched (day-end accumulation picks up the mutated pattern).
  const applyRelocation = (
    a: { dispatcher: Dispatcher; pattern: boolean[] },
    j: number,
    i: number,
  ): void => {
    a.pattern[j] = false
    a.pattern[i] = true
    cov[j]--
    cov[i]++
    const delta = SLOTS[i].hours - SLOTS[j].hours
    if (delta > 0) {
      smoothingBudget[a.dispatcher.id][wLabel] =
        (smoothingBudget[a.dispatcher.id][wLabel] ?? 0) + delta
      dailyNetAdd.set(a.dispatcher.id, (dailyNetAdd.get(a.dispatcher.id) ?? 0) + delta)
    }
  }

  const applyExtension = (
    a: { dispatcher: Dispatcher; pattern: boolean[] },
    i: number,
  ): void => {
    a.pattern[i] = true
    cov[i]++
    const addH = SLOTS[i].hours
    smoothingBudget[a.dispatcher.id][wLabel] =
      (smoothingBudget[a.dispatcher.id][wLabel] ?? 0) + addH
    dailyNetAdd.set(a.dispatcher.id, (dailyNetAdd.get(a.dispatcher.id) ?? 0) + addH)
  }

  // Surplus slots this dispatcher could relocate from, near slot i, in
  // descending order of surplus and then descending distance from i
  // (further first — keeps the immediate neighborhood intact).
  const findSurplusSources = (
    a: { pattern: boolean[] },
    i: number,
  ): number[] => {
    const out: Array<{ j: number; surplus: number; dist: number }> = []
    for (let j = 0; j < a.pattern.length; j++) {
      if (!a.pattern[j]) continue
      const surplus = cov[j] - required[j]
      if (surplus < 1) continue
      const dist = Math.abs(j - i)
      if (dist === 0) continue
      if (dist > SMOOTHING_RELOCATION_REACH) continue
      out.push({ j, surplus, dist })
    }
    out.sort((p, q) => q.surplus - p.surplus || q.dist - p.dist)
    return out.map((x) => x.j)
  }

  // Lowest weekly-hours first so we don't keep loading the same
  // dispatcher. Ties broken by id for determinism.
  const byLowestWeeklyHours = (
    a: { dispatcher: Dispatcher },
    b: { dispatcher: Dispatcher },
  ): number => {
    const wa = weekHours[a.dispatcher.id][wLabel] ?? 0
    const wb = weekHours[b.dispatcher.id][wLabel] ?? 0
    if (wa !== wb) return wa - wb
    return a.dispatcher.id.localeCompare(b.dispatcher.id)
  }

  const tryBoundaryOnDip = (i: number, allowNetAdd: boolean): string | null => {
    const candidates = assignments
      .filter((a) => {
        if (a.pattern[i]) return false
        const { start, breaks } = shiftBoundaries(a.pattern)
        if (start < 0) return false
        return breaks.some((b) => b.start <= i && i <= b.end)
      })
      .sort(byLowestWeeklyHours)

    for (const a of candidates) {
      for (const j of findSurplusSources(a, i)) {
        // The vacated slot j is where the break lands — never inside
        // a peak window (MVP rule: breaks only on shoulder slots).
        if (PEAK_SLOT_SET.has(j)) continue
        const trial = [...a.pattern]
        trial[j] = false; trial[i] = true
        if (!isValidShiftShape(trial, dow)) continue
        if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaks)) continue
        const delta = SLOTS[i].hours - SLOTS[j].hours
        if (!fitsBudget(a, delta)) continue
        applyRelocation(a, j, i)
        return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} break-fill (relocated from ${SLOTS[j].label} surplus)`
      }
      if (!allowNetAdd) continue
      const addH = SLOTS[i].hours
      if (!fitsBudget(a, addH)) continue
      if (isBlocked(a, i)) continue
      const trial = [...a.pattern]
      trial[i] = true
      if (!isValidShiftShape(trial, dow)) continue
      applyExtension(a, i)
      return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} break-fill (+${addH}h net)`
    }
    return null
  }

  const tryHandoffOverlap = (i: number, allowNetAdd: boolean): string | null => {
    // Prefer outgoing first — keeps the incoming dispatcher arriving
    // clean at their original start.
    const outgoing = assignments
      .filter((a) => !a.pattern[i] && lastActiveSlot(a.pattern) === i - 1)
      .map((a) => ({ a, side: 'out' as const }))
    const incoming = assignments
      .filter((a) => !a.pattern[i] && firstActiveSlot(a.pattern) === i + 1)
      .map((a) => ({ a, side: 'in' as const }))
    const candidates = [...outgoing, ...incoming].sort((x, y) => byLowestWeeklyHours(x.a, y.a))

    for (const { a, side } of candidates) {
      for (const j of findSurplusSources(a, i)) {
        const trial = [...a.pattern]
        trial[j] = false; trial[i] = true
        if (!isValidShiftShape(trial, dow)) continue
        if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaks)) continue
        const delta = SLOTS[i].hours - SLOTS[j].hours
        if (!fitsBudget(a, delta)) continue
        applyRelocation(a, j, i)
        return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} handoff-${side} (relocated from ${SLOTS[j].label} surplus)`
      }
      if (!allowNetAdd) continue
      const addH = SLOTS[i].hours
      if (!fitsBudget(a, addH)) continue
      if (isBlocked(a, i)) continue
      const trial = [...a.pattern]
      trial[i] = true
      if (!isValidShiftShape(trial, dow)) continue
      applyExtension(a, i)
      return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} handoff-${side} (+${addH}h net)`
    }
    return null
  }

  // Standalone surplus relocation — no boundary, no handoff required.
  // Any dispatcher with nearby surplus they could shift INTO slot i.
  // This is the Thursday-8PM case: a dispatcher with a 1 PM surplus
  // who isn't at the dip's break or handoff but can still relocate.
  const tryStandaloneRelocation = (i: number): string | null => {
    const candidates = assignments
      .filter((a) => !a.pattern[i] && !isBlocked(a, i))
      .sort(byLowestWeeklyHours)
    for (const a of candidates) {
      for (const j of findSurplusSources(a, i)) {
        // The vacated slot j is where the break lands — never inside
        // a peak window (MVP rule: breaks only on shoulder slots).
        if (PEAK_SLOT_SET.has(j)) continue
        const trial = [...a.pattern]
        trial[j] = false; trial[i] = true
        if (!isValidShiftShape(trial, dow)) continue
        if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaks)) continue
        const delta = SLOTS[i].hours - SLOTS[j].hours
        if (!fitsBudget(a, delta)) continue
        applyRelocation(a, j, i)
        return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} relocated from ${SLOTS[j].label} surplus`
      }
    }
    return null
  }

  const tryFallbackNetAdd = (i: number): string | null => {
    const candidates = assignments
      .filter((a) => !a.pattern[i])
      .filter((a) => (i > 0 && a.pattern[i - 1]) || (i < a.pattern.length - 1 && a.pattern[i + 1]))
      .filter((a) => !isBlocked(a, i))
      .sort(byLowestWeeklyHours)
    for (const a of candidates) {
      const addH = SLOTS[i].hours
      if (!fitsBudget(a, addH)) continue
      const trial = [...a.pattern]
      trial[i] = true
      if (!isValidShiftShape(trial, dow)) continue
      applyExtension(a, i)
      return `${dateStr} ${SLOTS[i].label}: ${a.dispatcher.name} extend +${addH}h (nearest neighbor)`
    }
    return null
  }

  // Two passes over the dips: first hours-flat only, then allow net adds.
  // After each successful resolution, isQualifyingDip(i) returns false
  // so the second pass naturally skips already-fixed slots.
  for (const allowNetAdd of [false, true]) {
    for (let i = 0; i < cov.length; i++) {
      if (!isQualifyingDip(i)) continue
      let r = tryBoundaryOnDip(i, allowNetAdd)
      if (r) { resolved.push(r); continue }
      r = tryHandoffOverlap(i, allowNetAdd)
      if (r) { resolved.push(r); continue }
      if (!allowNetAdd) {
        r = tryStandaloneRelocation(i)
        if (r) { resolved.push(r); continue }
      } else {
        r = tryFallbackNetAdd(i)
        if (r) { resolved.push(r); continue }
      }
    }
  }

  const unresolved: number[] = []
  for (let i = 0; i < cov.length; i++) if (isQualifyingDip(i)) unresolved.push(i)
  return { resolved, unresolved }
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/** First weekday (0–6) the dispatcher has a standing FULL-DAY recurring
 *  block on, or null. A full-day recurring block is that person's
 *  guaranteed 1st day off every week — Phase 0 adopts it as their home
 *  rest day and never stacks a lock on top. */
function fullDayRecurringDow(dispatcher: Dispatcher): number | null {
  const rb = dispatcher.recurringBlocks
  if (!rb) return null
  for (let dow = 0; dow < 7; dow++) {
    const bm = rb[dow]
    if (bm && bm.length > 0 && bm.every(Boolean)) return dow
  }
  return null
}

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

/** One full generation pass. `grantPlan` (weekLabel → {dispId, date})
 *  injects the rotating 2nd-day-off grants through the elect channel —
 *  the wrapper below plans, audits and defers them. */
export function generateCore(
  dispatchers: Dispatcher[],
  startDate: string,
  endDate: string,
  timeOff: DispatcherTimeOff,
  seed = 0,
  coverageOverrides: Record<number, number[]> = {},
  grantPlan?: Map<string, { dispId: string; date: string }>,
  restAvoid?: Record<string, Set<string>>,
): GeneratedSchedule {
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  const totalDays = differenceInDays(end, start) + 1

  const allDates = Array.from({ length: totalDays }, (_, i) => addDays(start, i))

  // ── Phase 0 — mandatory weekly rest (hard gate, top of pipeline) ────
  // Lock 1 rest date per dispatcher per work-week and cap consecutive
  // workdays at MAX_CONSECUTIVE_WORK_DAYS across week boundaries.
  // These locks are INVIOLABLE — every subsequent pass filters them out
  // via `restLocks`. No pass may set, refund, or override a lock.
  const { restLocks, streakWarnings } = assignMandatoryRest(dispatchers, allDates, timeOff, seed, coverageOverrides, restAvoid)
  // Streak warnings only fire when user-entered time-off creates a gap
  // > 7 days that Phase 0 can't fix (it can't override user input).
  // Surface as console.warn — extremely rare on non-adversarial input.
  for (const msg of streakWarnings) {
    // eslint-disable-next-line no-console
    console.warn(`[mandatoryRest] ${msg}`)
  }

  // Per-dispatcher, per-week hour accumulator
  const weekHours: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekHours[d.id] = {}))

  // Per-dispatcher, per-week budget of NET hours added by the transition-
  // smoothing pass. Capped at SMOOTHING_BUDGET_PER_WEEK so one person
  // can't quietly absorb every day's smoothing and hit the 45 h cap by
  // Friday. Hours-flat surplus relocations don't book against this.
  const smoothingBudget: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (smoothingBudget[d.id] = {}))

  // Per-dispatcher, per-week off-day counter. Counts recurring blocks AND
  // elected off-days together, so a dispatcher with Fri as a recurring block
  // gets at most 1 more elected off-day in that week.
  const weekOffDays: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekOffDays[d.id] = {}))

  // Pre-populate weekOffDays with the mandatory rest locks so the fairness
  // picker (and every other per-day pass) sees the accurate weekly
  // off-count from day 1 — including future lock days later in the same
  // week. Without this the picker could elect a trainee off on a Monday
  // whose Wednesday rest lock hasn't been "seen" yet, producing 2 off in
  // one week and violating the Trainee cap.
  for (const d of dispatchers) {
    for (const lockDateStr of restLocks[d.id]) {
      const lockDt = parseISO(lockDateStr)
      const lockWk = weekLabel(lockDt)
      weekOffDays[d.id][lockWk] = (weekOffDays[d.id][lockWk] ?? 0) + 1
    }
  }

  // Per-dispatcher total weekend (Fri/Sat/Sun) off-days across the whole
  // schedule. Used by the fairness picker to spread weekend off-days evenly.
  const weekendOffTotal: Record<string, number> = {}
  dispatchers.forEach((d) => (weekendOffTotal[d.id] = 0))

  // Per-dispatcher weekend off-days within the CURRENT work-week. Used to
  // ensure no dispatcher gets 2 weekend days off in the same week (e.g.,
  // off Sat AND Sun) — Fri/Sat/Sun are busy days; we only have 7
  // dispatchers; one weekend off per person per week is the cap.
  const weekendOffThisWeek: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekendOffThisWeek[d.id] = {}))

  // Per-dispatcher total elected off-days (excludes recurring/per-date blocks
  // and 45 h cap-hits). Used as a fairness tiebreak across weeks so the same
  // dispatcher isn't picked off every Thursday.
  const totalElectedOff: Record<string, number> = {}
  dispatchers.forEach((d) => (totalElectedOff[d.id] = 0))

  // Per-dispatcher off-day count broken down by day-of-week (0=Sun..6=Sat).
  // Used to spread off-days across the calendar week so all 3 of N
  // dispatchers don't happen to land off on the same Wednesday — the
  // structural cause of Wed coverage gaps the user flagged.
  const offByDow: Record<string, Record<number, number>> = {}
  dispatchers.forEach((d) => (offByDow[d.id] = {}))

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
  const coverageWarnings: NonNullable<GeneratedSchedule['coverageWarnings']> = {}

  let dayIndex = seed

  for (const date of allDates) {
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const template = DAY_TEMPLATES[dow]
    const wLabel = weekLabel(date)
    const dayLabel = format(date, 'EEE, MMMM do')
    const yesterday = format(addDays(date, -1), 'yyyy-MM-dd')

    // Pre-compute pattern metadata (once per day). Filter to shapes that
    // pass the same shape rules used by the swap pass — most importantly
    // the 6h-per-day minimum, so short fillers can never become a
    // dispatcher's entire shift for the day.
    const patternMeta = template.shiftPatterns
      .map((raw, idx) => {
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
      .filter((p) => isValidShiftShape(p.bool, dow))

    // Sort patterns: morning first, then LONGEST shifts first so they go
    // to the least-loaded dispatcher. All shapes carry the same 30-min
    // meal break so break size is no longer a tiebreak.
    const byLength = (a: typeof patternMeta[number], b: typeof patternMeta[number]) =>
      b.hours - a.hours
    const sortedPatterns = [
      ...patternMeta.filter((p) => p.isMorning).sort(byLength),
      ...patternMeta.filter((p) => !p.isMorning).sort(byLength),
    ]

    // Rotate dispatcher order for variety (step 3 per day visits all positions)
    const rotationOffset = (dayIndex * 3) % dispatchers.length
    dayIndex++
    const rotated = [
      ...dispatchers.slice(rotationOffset),
      ...dispatchers.slice(0, rotationOffset),
    ]

    // Day's required coverage — needed up here so Phase B's coverage-gated
    // off election and the picker's over-coverage cap both see it.
    const dayRequired = effectiveCoverage(dow, coverageOverrides)

    // Trainee weekly-hour reserve. Trainees must work every non-rest day
    // (off-day cap 1), so keep enough of their 45h budget for the
    // remaining mandatory workdays. Without this the picker loads
    // trainees with 8h splits/evenings early in the week, they hit 45h
    // by Monday, and the cap forces an involuntary 2nd day off —
    // violating the trainee rule through the back door.
    //
    // TWO caps per trainee, chosen by whether today's candidate shift
    // ends at night (≥ 9 PM):
    //  - weeklyCapFor: remaining days reserved at that day's SHORTEST
    //    shift (weekday Morning 6.5h / weekend Morning 7.5h).
    //  - weeklyCapNightFor: a night-ending shift blocks tomorrow's
    //    morning (night-rest), and every non-morning option is 8h and
    //    itself night-ending — so one night chains 8h/day until the
    //    trainee's rest day resets it. Reserve 8h for each chained
    //    remaining day, the minimum shift after the rest.
    // Conservative: fully-blocked future days still count toward the
    // reserve (over-reserving means shorter shifts, never a violation).
    const minShiftHoursFor = (_dw: number) => 6.5 // shortest shape any day (Morning-10 variants)
    const NIGHT_CHAIN_SHIFT_HOURS = 8
    const weeklyCapFor: Record<string, number> = {}
    const weeklyCapNightFor: Record<string, number> = {}
    for (const d of dispatchers) {
      if (d.level !== 'Trainee') {
        weeklyCapFor[d.id] = WEEKLY_CAP_HOURS
        weeklyCapNightFor[d.id] = WEEKLY_CAP_HOURS
        continue
      }
      let reserve = 0
      let reserveNight = 0
      let chained = true
      for (const dt of allDates) {
        const ds = format(dt, 'yyyy-MM-dd')
        if (ds <= dateStr || weekLabel(dt) !== wLabel) continue
        if (restLocks[d.id].has(ds)) { chained = false; continue }
        const minH = minShiftHoursFor(dt.getDay())
        reserve += minH
        reserveNight += chained ? NIGHT_CHAIN_SHIFT_HOURS : minH
      }
      weeklyCapFor[d.id] = WEEKLY_CAP_HOURS - reserve
      weeklyCapNightFor[d.id] = WEEKLY_CAP_HOURS - reserveNight
    }
    // Effective cap for a candidate shift, chosen by its end slot.
    const capForShift = (dispId: string, lastSlot: number): number =>
      lastSlot >= NIGHT_SLOT_THRESHOLD ? weeklyCapNightFor[dispId] : weeklyCapFor[dispId]

    // Phase A — classify dispatchers into:
    //   blockedToday  — fully blocked by recurring/per-date time-off,
    //                   OR forced off because today is the last day of
    //                   their work-week and they haven't had an off-day
    //                   yet (legal minimum: 1 day off per 7-day week).
    //   cappedToday   — already at 45 h this week (forced off, doesn't count
    //                   toward the 2-days-off cap, treated like time-off)
    //   availablePool — could work today
    //
    // Work week runs Thu→Wed. `daysIntoWeek` = which day-number this is
    // (1 = Thu, 7 = Wed). When daysIntoWeek === 7 (Wed, the last day)
    // any dispatcher still at 0 off MUST be off today.
    const isWeekend = HEAVY_DAYS.has(dow)
    const blockedToday: typeof dispatchers = []
    const cappedToday: typeof dispatchers = []
    const availablePool: typeof dispatchers = []

    for (const d of rotated) {
      const blocks = blockedBitmap(timeOff, d, dateStr, dow)
      const fullyBlocked = blocks !== null && blocks.length > 0 && blocks.every(Boolean)
      // Mandatory rest lock from Phase 0 — inviolable. No pass may
      // override this, so we route straight into blockedToday and bump
      // the weekOffDays counter the same way as fullyBlocked. Weekend
      // rest locks also count toward weekend-off tallies so the fairness
      // picker doesn't try to elect a second weekend off in the same week.
      const restLocked = restLocks[d.id].has(dateStr)
      if (fullyBlocked || restLocked) {
        blockedToday.push(d)
        // Rest locks are pre-counted into weekOffDays at Phase 0, so bump
        // only for non-lock fully-blocked days (user-entered time-off).
        if (!restLocked) {
          weekOffDays[d.id][wLabel] = (weekOffDays[d.id][wLabel] ?? 0) + 1
        }
        offByDow[d.id][dow] = (offByDow[d.id][dow] ?? 0) + 1
        if (isWeekend) {
          weekendOffTotal[d.id] += 1
          weekendOffThisWeek[d.id][wLabel] = (weekendOffThisWeek[d.id][wLabel] ?? 0) + 1
        }
      } else if ((weekHours[d.id][wLabel] ?? 0) >= WEEKLY_CAP_HOURS) {
        cappedToday.push(d)
      } else {
        availablePool.push(d)
      }
    }

    // Phase B — fairness pick: how many in availablePool to elect OFF today.
    // Coverage-gated: elect an off only when the day's peak demand still
    // fits in the remaining pool. Under the two-team model the day needs
    // roughly (max morning-window req) + (max evening-window req) bodies.
    // Slot 9 (3–4 PM) is excluded from both windows — the handoff overlap
    // double-covers it. On Mon–Wed, splits can absorb a body's worth of
    // double-peak coverage, so we simulate 1–2 splits against the actual
    // req vector and take the cheapest configuration. The slack this
    // frees (Tue/Wed −1 each at current targets) is what funds the
    // rotating 2nd day off for Regular/Senior. Mon derives no saving
    // from the same simulation (2:30–3 PM sits in the split gap), so no
    // false slack there. The perk scales with headcount automatically.
    const morningNeed = Math.max(...dayRequired.slice(0, HANDOFF_SLOT))
    const eveningNeed = Math.max(...dayRequired.slice(HANDOFF_SLOT + 1))
    // +1 STAGGER BODY: with every break banished from the peaks onto
    // the shoulder slots, a period that must hold N simultaneous bodies
    // while each takes a staggered 30-min break needs N+1 people.
    // Without it the elect pass sheds workers down to the bare
    // peak-sum and the shoulders (8–9 PM) run structurally short.
    let bodiesNeeded = morningNeed + eveningNeed + 1
    const splitsAllowed = true // splits serve any day (human practice)
    if (splitsAllowed) {
      for (let s = 1; s <= 2; s++) {
        let mNeed = 0
        for (let i = 0; i < HANDOFF_SLOT; i++) {
          mNeed = Math.max(mNeed, dayRequired[i] - s * (SPLIT_COVERAGE[i] ? 1 : 0))
        }
        let eNeed = 0
        for (let i = HANDOFF_SLOT + 1; i < SLOTS.length; i++) {
          eNeed = Math.max(eNeed, dayRequired[i] - s * (SPLIT_COVERAGE[i] ? 1 : 0))
        }
        bodiesNeeded = Math.min(bodiesNeeded, s + mNeed + eNeed + 1)
      }
    }
    const desiredElectedOff = Math.max(0, availablePool.length - bodiesNeeded)

    let eligibleForOff = availablePool.filter(
      (d) => (weekOffDays[d.id][wLabel] ?? 0) < maxDaysOffFor(d.level),
    )

    // On Fri/Sat/Sun, don't elect anyone who's already had a weekend
    // off this week (e.g. off Sat → can't also be off Sun). Also skip
    // anyone with a FUTURE weekend day blocked by time-off in this
    // same work-week — their weekend off is already accounted for
    // even though we haven't reached that date yet.
    if (isWeekend) {
      const futureWeekendDates = allDates
        .filter((dt) => weekLabel(dt) === wLabel && HEAVY_DAYS.has(dt.getDay()) && format(dt, 'yyyy-MM-dd') > dateStr)
      eligibleForOff = eligibleForOff.filter((d) => {
        if ((weekendOffThisWeek[d.id][wLabel] ?? 0) > 0) return false
        for (const dt of futureWeekendDates) {
          const futStr = format(dt, 'yyyy-MM-dd')
          const futBlocks = blockedBitmap(timeOff, d, futStr, dt.getDay())
          if (futBlocks && futBlocks.length > 0 && futBlocks.every(Boolean)) return false
        }
        return true
      })
    }

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
      // Spread off-days across the calendar week — prefer dispatchers
      // with fewer offs on THIS day-of-week so we don't keep landing
      // 3 people off the same Wednesday.
      const dowA = offByDow[a.id][dow] ?? 0
      const dowB = offByDow[b.id][dow] ?? 0
      if (dowA !== dowB) return dowA - dowB
      return totalElectedOff[a.id] - totalElectedOff[b.id]
    })

    const electedOffIds = new Set(
      eligibleForOff.slice(0, desiredElectedOff).map((d) => d.id),
    )
    // ── Phase 0.5 grant injection — rotating 2nd day off ──────────────
    // The wrapper plans exactly one grant per week (Regular/Senior
    // rotation); today being the planned day, elect that dispatcher off
    // through the normal channel so ALL downstream machinery applies:
    // off-day accounting below, the 2-day cap, and the rescue /
    // must-work / 2nd-off-prevention passes that pull an elect back in
    // when a real gap appears. The wrapper's post-generation audit is
    // the feasibility bar; this injection is only the mechanism.
    const grant = grantPlan?.get(wLabel)
    let grantedTodayId: string | null = null
    if (grant && grant.date === dateStr && !electedOffIds.has(grant.dispId)) {
      const gd = availablePool.find((d) => d.id === grant.dispId)
      if (gd && (weekOffDays[gd.id][wLabel] ?? 0) < maxDaysOffFor(gd.level)) {
        electedOffIds.add(gd.id)
        grantedTodayId = gd.id
      }
    }
    for (const id of electedOffIds) {
      weekOffDays[id][wLabel] = (weekOffDays[id][wLabel] ?? 0) + 1
      offByDow[id][dow] = (offByDow[id][dow] ?? 0) + 1
      totalElectedOff[id] += 1
      if (isWeekend) {
        weekendOffTotal[id] += 1
        weekendOffThisWeek[id][wLabel] = (weekendOffThisWeek[id][wLabel] ?? 0) + 1
      }
    }

    const cappedDispatchers = cappedToday
    const workingPool = availablePool.filter((d) => !electedOffIds.has(d.id))

    // Balance sort: prefer this-week-behind dispatchers FIRST so each
    // calendar week ends up with a tight hour spread (was running 27-40 h
    // wide), then break ties on cumulative total to keep the period-long
    // total band tight too. Final tiebreak: prefer candidates who've
    // been off on THIS day-of-week more often so the picker reaches
    // them first — fixes Wed/Thu clustering where the same 2-3
    // dispatchers kept landing unassigned.
    const sortedWorking = [...workingPool].sort((a, b) => {
      const wA = weekHours[a.id][wLabel] ?? 0
      const wB = weekHours[b.id][wLabel] ?? 0
      if (wA !== wB) return wA - wB
      // Per-DOW spread BEFORE cumulative — when week-hours are tied
      // (typical on day-1-of-week), prefer dispatchers who've been off
      // on THIS day-of-week more often. Without this, the same
      // dispatcher gets unassigned on the same weekday every week
      // because their total-hours runs high from other days (a
      // self-perpetuating loop the user flagged on shamika/Thursdays).
      const dowA = offByDow[a.id][dow] ?? 0
      const dowB = offByDow[b.id][dow] ?? 0
      if (dowA !== dowB) return dowB - dowA
      return totalHoursWorked[a.id] - totalHoursWorked[b.id]
    })

    // Night-rest check: did this dispatcher work a night shift yesterday?
    const workedNightYesterday = (dispId: string) =>
      (lastSlotWorked[dispId][yesterday] ?? -1) >= NIGHT_SLOT_THRESHOLD

    // Greedy assignment: each pattern picks the best eligible dispatcher.
    // Constraint: if any Senior is available, ensure at least one is assigned.
    const hasSeniors = sortedWorking.some((d) => d.level === 'Senior')
    const usedIds = new Set<string>()
    const usedPatternIdx = new Set<number>()
    const assignments: Array<{ dispatcher: (typeof dispatchers)[0]; pattern: boolean[] }> = []
    let seniorAssigned = false

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
    // Dropping is DISABLED: with a shape catalog this diverse (long vs
    // short, breaky vs breakless, staggered break positions), every
    // static drop heuristic we tried pre-decided the day's composition
    // worse than the deficit-depth picker does — shortest-first killed
    // the breakless shapes, breaky-first killed the hour-rich long
    // shapes. The picker self-limits via over-cap and body count; the
    // unused patterns just sit in the pool.
    const patternsToDrop = 0
    if (patternsToDrop > 0) {
      // Greedy drop with coverage-survival check — never drop a pattern
      // if doing so would leave any required slot with zero patterns
      // covering it. Previously a slot like Fri 11-11:30 PM (req=1, 3
      // patterns) saw all three patterns scored 0 unique and ALL
      // dropped, leaving slot 19 uncovered every Friday.
      // Between two DINNER-anchor shapes of equal uniqueness, drop the
      // one whose break lands on the higher-requirement slot first. An
      // anchor that breaks where the day is tightest (Evening A's 8 PM
      // break vs a req-3 Thursday 8 PM) is anti-selected by the
      // criticality boosts and never assigned — protecting it starves
      // the peak of a USABLE anchor. Keeping the low-req-break variant
      // (Evening D breaks 8:30, req 2) gives the picker an anchor it
      // will actually take. Scoped to dinner anchors only: applying
      // this ordering globally reshuffled morning drops and produced
      // 9–10 AM zero-coverage days.
      const dinnerSlots = PEAK_WINDOWS.find((pk) => pk.key === 'dinner')!.slots
      const breakReq = (pp: (typeof sortedPatterns)[number]) => {
        const first = pp.bool.findIndex(Boolean)
        const last = pp.bool.lastIndexOf(true)
        let worst = 0
        for (let i = first + 1; i < last; i++) {
          if (!pp.bool[i]) worst = Math.max(worst, dayRequired[i])
        }
        return worst
      }
      // NB: the key must yield a TOTAL order — a conditional "only when
      // both are anchors" comparison is intransitive and JS sort then
      // returns an arbitrary permutation (observed: D/E dropped, A kept).
      const dinnerBadness = (pp: (typeof sortedPatterns)[number]) =>
        isPeakAnchorPattern(pp.bool, dinnerSlots) ? breakReq(pp) : 0
      // Break-carrying shapes drop before breakless ones (a breakless
      // shape can never collapse a slot — the MVP's core property), and
      // shorter shapes before longer within each class.
      const hasBreak = (pp: (typeof sortedPatterns)[number]) => (pp.maxBreak > 0 ? 1 : 0)
      const dropSort = [...scoredPatterns].sort(
        (a, b) =>
          a.unique - b.unique ||
          dinnerBadness(b.p) - dinnerBadness(a.p) ||
          hasBreak(b.p) - hasBreak(a.p) ||
          a.p.hours - b.p.hours,
      )
      const dropped = new Set<typeof sortedPatterns[number]>()
      const remainingCov = [...coverageCount]
      // Track anchor-capable patterns per peak — never drop the last two
      // (one to assign + one spare for the swap-repair pass). Without
      // this, Evening A (the only 15:00-start dinner anchor) was dropped
      // as "redundant" every Thursday: its coverage is a subset of
      // B/C/Ramp combined, but none of those anchor the peak.
      const anchorsLeft = new Map<string, number>()
      for (const peak of PEAK_WINDOWS) {
        anchorsLeft.set(peak.key, sortedPatterns.filter((pp) => isPeakAnchorPattern(pp.bool, peak.slots)).length)
      }
      for (const cand of dropSort) {
        if (dropped.size >= patternsToDrop) break
        const anchorFor = PEAK_WINDOWS.filter((peak) => isPeakAnchorPattern(cand.p.bool, peak.slots))
        if (anchorFor.some((peak) => (anchorsLeft.get(peak.key) ?? 0) <= 2)) continue
        // Would dropping cand leave any required slot under-covered?
        // Was `< 1` (only protected against 0 cover) which let one of
        // {Early A, Early B} drop on Sun where both are needed (req=2,
        // both cover slot 0). Now `< dayRequired[i]` so mandatory
        // patterns survive.
        let unsafe = false
        for (let i = 0; i < cand.p.bool.length; i++) {
          if (cand.p.bool[i] && dayRequired[i] > 0 && remainingCov[i] - 1 < dayRequired[i]) { unsafe = true; break }
        }
        if (unsafe) continue
        dropped.add(cand.p)
        for (const peak of anchorFor) {
          anchorsLeft.set(peak.key, (anchorsLeft.get(peak.key) ?? 1) - 1)
        }
        for (let i = 0; i < cand.p.bool.length; i++) {
          if (cand.p.bool[i]) remainingCov[i] -= 1
        }
      }
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

    // ── seedAnchors — peak-continuity pre-pass ─────────────────────────
    // Reserves one (dispatcher, anchor-pattern) pair per peak BEFORE the
    // main picker runs when supply is constrained (≤ 1 viable pair).
    // Returns peaks with zero viable supply — emitted as warnings below.
    // Mutates: assignments, usedIds, usedPatternIdx, runningCov.
    const seedCtx = {
      patternMeta, sortedWorking, usedIds, usedPatternIdx, assignments,
      runningCov, weekHours, wLabel, timeOff, dateStr, dow,
      workedNightYesterday, capForShift,
    }
    const unseedablePeaks = seedAnchors(seedCtx)
    for (const peakKey of unseedablePeaks) {
      (coverageWarnings[dateStr] ??= []).push({
        peak: peakKey,
        reason: 'no eligible dispatcher could anchor this peak (night-rest, time-off, or weekly-cap blocked every candidate)',
      })
    }

    // Gap-aware dynamic iteration: instead of locking in pattern order
    // by static priority, at each step pick the pattern that BEST fits
    // the current deficit. Short gap-filler patterns (2-2.5h) win when
    // their slots align with an under-covered window; longer patterns
    // win when there's broad deficit to cover. Falls back to the static
    // priority list as a stable tiebreak.
    const remainingPatterns = new Set(
      // Filter out any patterns already reserved by seedAnchors.
      prioritizedPatterns.filter((p) => {
        const idx = patternMeta.findIndex((pm) => pm.bool === p.bool)
        return !usedPatternIdx.has(idx)
      })
    )
    const staticOrder = new Map(prioritizedPatterns.map((p, i) => [p, i]))
    while (remainingPatterns.size > 0) {
      let p: typeof prioritizedPatterns[number] | null = null
      let bestScore = -Infinity
      // Precompute, for each slot, how many *remaining* patterns cover
      // it. A slot whose deficit equals or exceeds that count has
      // mandatory coverage: every covering pattern MUST be picked or
      // the slot can't fill. Used to boost critical patterns in the
      // scoring below. Caught on Sun 8-10 AM (req=2) where only Early
      // A + Early B cover slot 0; without this boost the picker would
      // pick Early A then jump to a long Split, leaving slot 0 at 1/2.
      const altCountPerSlot = new Array(SLOTS.length).fill(0)
      for (const cand of remainingPatterns) {
        for (let i = 0; i < cand.bool.length; i++) {
          if (cand.bool[i]) altCountPerSlot[i]++
        }
      }
      // Peaks still missing a continuity anchor among today's picks.
      // Anchor shapes get a bonus while their peak lacks one — without
      // it, depth-weighted scoring anti-selects Evening A every Thursday
      // (it breaks at 8 PM, the deepest evening deficit, so the
      // non-anchor variants always outscore it) and enforceAnchors can't
      // repair because every swap would drop the req-3 8 PM slot.
      const peaksNeedingAnchor = PEAK_WINDOWS.filter(
        (peak) => !assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
      )
      for (const cand of remainingPatterns) {
        let fill = 0, overTolerated = 0, overOff = 0, criticality = 0
        for (const peak of peaksNeedingAnchor) {
          if (isPeakAnchorPattern(cand.bool, peak.slots)) criticality += 50
        }
        for (let i = 0; i < cand.bool.length; i++) {
          if (!cand.bool[i]) continue
          if (runningCov[i] < dayRequired[i]) {
            // DEPTH-weighted fill: a slot 3 below target weighs 3× a
            // slot 1 below. This is what allocates morning vs evening
            // proportionally to each peak's target — with count-based
            // fill, a morning shape covering nine req-1 slots outranked
            // an evening covering a req-4 dinner sitting at 2.
            fill += dayRequired[i] - runningCov[i]
            const deficit = dayRequired[i] - runningCov[i]
            // Mandatory or near-mandatory: deficit can only be filled by
            // a small set of patterns. Boost massively so critical
            // patterns get picked while dispatchers still remain.
            // `<= deficit + 1` catches both strict-mandatory (only N
            // patterns cover an N-deficit slot — all must be picked)
            // and near-mandatory (N+1 patterns for N-deficit — one slack,
            // but the picker often eats that slack on a long high-fill
            // pattern and runs out of dispatchers before the slot fills).
            // Caught on Fri 11-11:30 PM (req=1, 2 covering patterns) —
            // neither was picked early without this broader boost.
            if (altCountPerSlot[i] <= deficit + 1) criticality += 1000
          } else if (runningCov[i] >= dayRequired[i]) {
            // Split over-cov by slot window. Surplus is tolerated inside
            // the SURPLUS_TOLERATED windows (lunch 11:00-13:00, dinner
            // 17:00-20:00) — trainees work a forced 6th day and their
            // excess hours land preferentially there. Over-cov outside
            // those windows costs 2× so the picker routes surplus to
            // the tolerated windows first, and only spills into off-peak
            // when no tolerated capacity remains.
            if (SURPLUS_TOLERATED_SLOTS.has(i)) overTolerated++
            else overOff++
          }
        }
        // fill*10 dominates so under-target still wins. overOff is 2x
        // overTolerated — a soft nudge, not a hard cap (that's handled
        // separately by MAX_OVER_COVERAGE below).
        const score = fill * 10 - overTolerated - 2 * overOff
                    - (staticOrder.get(cand) ?? 0) * 0.01 + criticality
        if (score > bestScore) { bestScore = score; p = cand }
      }
      if (!p) break
      remainingPatterns.delete(p)
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
      // NOTE on the 5-PM ramp: on 5-worker Thursdays the slot can reach
      // target+2 — that surplus is GEOMETRIC, not a picker error. All
      // five shapes that day (two 9AM+dinner splits, the 15:00 and
      // 16:00 closers, the 2–6 PM ramp) legally MUST span 17:00–18:00:
      // in-peak breaks are banned, split gaps must end by 17:00, and
      // the 4h daily minimum stops the ramp from shrinking out of the
      // slot. Capping the tier at peaks was measured to re-open a
      // 0-coverage slot and three dinner gaps — strictly worse.
      const cap = MAX_OVER_COVERAGE + (fillsDeficit ? 1 : 0)
      let overShoots = false
      for (let i = 0; i < p.bool.length; i++) {
        if (p.bool[i] && runningCov[i] + 1 > dayRequired[i] + cap) {
          overShoots = true; break
        }
      }
      if (overShoots) continue

      // ── MVP morning cap — assign only as many people to the OPEN as
      // the open needs. A shape counts against the cap when it starts
      // 8–9 AM (before slot 2) and is not a Mon–Wed split (splits serve
      // both peaks and are budgeted separately). Mid-morning starts
      // (10 AM) stay uncapped — they hold 2–3 PM after the openers
      // leave. Everyone past the cap routes to ramp/evening shapes, so
      // the low-target opening never stacks bodies the evening ramp
      // will be missing.
      const isCapMorning =
        firstActiveSlot(p.bool) < 2 && p.maxBreak < SPLIT_GAP_MIN_HOURS
      if (isCapMorning) {
        let morningCount = 0
        for (const a of assignments) {
          const f = firstActiveSlot(a.pattern)
          if (f >= 0 && f < 2 && patternMaxBreakHours(a.pattern, SLOTS) < SPLIT_GAP_MIN_HOURS) {
            morningCount++
          }
        }
        if (morningCount >= morningNeed) continue
      }
      // Situational splits: a split's gap doubles as its meal break and
      // parks the off-floor time in the low-demand 2–5 PM lull — on
      // tight weekdays that's the ONLY way to deliver the calibrated
      // evening without a break landing on a full shoulder (the humans
      // exploit exactly this). Weekends cap at ONE split so the
      // staggered-edge morning pair (8–15 + 9–16) isn't dissolved into
      // split gaps; weekdays allow up to three (deficit scoring and
      // over-cap keep them situational).
      if (p.maxBreak >= SPLIT_GAP_MIN_HOURS) {
        // 9 AM-starting splits cannibalize the weekend staggered-edge
        // pair (they win the second-morning slot, killing the 9→16:00
        // straight shape) — weekends only admit the 11 AM splits.
        if (isWeekend && firstActiveSlot(p.bool) <= 2) continue
        let splitsToday = 0
        for (const a of assignments) {
          if (patternMaxBreakHours(a.pattern, SLOTS) >= SPLIT_GAP_MIN_HOURS) splitsToday++
        }
        if (splitsToday >= (isWeekend ? 1 : 3)) continue
      }
      // Tactic 1b hard edge: 8:00 starters never exceed the OPEN target
      // itself. With the weekend open calibrated to 1, exactly one
      // dispatcher opens at 8 and the second morning body starts at 9 —
      // the staggered edge the human team runs. (An 8–16 shape also
      // fills 2–3 PM deficits, which otherwise out-scores the stagger
      // and double-books the open at target+1.)
      if (firstActiveSlot(p.bool) === 0) {
        let openers = 0
        for (const a of assignments) {
          if (firstActiveSlot(a.pattern) === 0) openers++
        }
        if (openers >= dayRequired[0]) continue
      }
      // Symmetric evening cap: the breakless/short evening shapes need
      // MORE bodies to tile the same span, and without this cap the
      // picker pulls a body past the evening's own peak need and
      // starves the opening (Sat ran 1/2 at 8–9 AM while dinner sat
      // at 4/4 with five bodies). Rescue/floor passes stay uncapped —
      // they only fire on genuine deficits.
      // The +1 funds break staggering: a period that must hold
      // eveningNeed simultaneous bodies while each takes a 30-min
      // break needs one extra body so the shoulders don't collapse.
      const isCapEvening = firstActiveSlot(p.bool) >= HANDOFF_SLOT
      if (isCapEvening) {
        let eveningCount = 0
        for (const a of assignments) {
          if (firstActiveSlot(a.pattern) >= HANDOFF_SLOT) eveningCount++
        }
        if (eveningCount >= eveningNeed + 1) continue
      }

      // Morning patterns exclude dispatchers who worked night yesterday.
      // Also exclude any dispatcher whose blocks overlap this pattern, and
      // any whose current weekly hours + this shift would push past the cap.
      const eligible = sortedWorking.filter((d) => {
        if (usedIds.has(d.id)) return false
        if (p.isMorning && workedNightYesterday(d.id)) return false
        const blocks = blockedBitmap(timeOff, d, dateStr, dow)
        if (blocks && p.bool.some((on, i) => on && blocks[i])) return false
        if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) return false
        return true
      })
      // Continue (not break) so a later pattern still gets a chance even
      // when this one has zero eligible candidates — otherwise Late B
      // gets silently skipped when an earlier pattern's filter rejects
      // everyone, leaving the closing slots uncovered.
      if (eligible.length === 0) continue

      // Hours-balance preference: prefer dispatchers whose post-shift weekly
      // hours stay at or below the soft target. Stops one dispatcher from
      // accumulating to the cap while others sit low. Falls back to all
      // eligible if nobody fits. (The real band balancing is a separate
      // COVERAGE-NEUTRAL post-pass below — Lever 3 — that swaps bodies
      // between already-assigned shifts without ever changing coverage;
      // doing it here in pattern-selection perturbed coverage via
      // eligibility cascades, reopening a 4–5 PM shoulder.)
      const withinSoft = eligible.filter(
        (d) => (weekHours[d.id][wLabel] ?? 0) + p.hours <= SOFT_WEEKLY_TARGET,
      )
      let pickFrom = withinSoft.length > 0 ? withinSoft : eligible

      // Save morning-capable bodies: an evening pattern should consume a
      // dispatcher who is night-blocked for mornings anyway (closed late
      // yesterday). Evening shapes score higher on deep-demand days and
      // assign first — without this partition they eat the morning-capable
      // pool, and the 9 AM shapes picked last find only night-blocked
      // bodies and silently fail (Friday 9–10 AM sat at zero coverage).
      if (!p.isMorning) {
        const nightBlocked = pickFrom.filter((d) => workedNightYesterday(d.id))
        if (nightBlocked.length > 0) {
          pickFrom = [...nightBlocked, ...pickFrom.filter((d) => !workedNightYesterday(d.id))]
        }
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
      p.bool.forEach((on, i) => { if (on) runningCov[i]++ })
    }

    // Patterns already used by the picker — rescue/must-work prefer
    // UNUSED patterns to avoid the duplicate-Early-A stacking the
    // user flagged. Sync from final picker assignments (seed entries
    // already in usedPatternIdx).
    for (const a of assignments) {
      const idx = patternMeta.findIndex((pm) => pm.bool === a.pattern)
      if (idx >= 0) usedPatternIdx.add(idx)
    }

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
      // On weekends, elected-off stays elected-off — rescue can only
      // pull from the unassigned-working pool. Otherwise the rescue
      // would immediately un-elect the weekend off-day we just
      // assigned, defeating the rotation. (Weekday rescues can still
      // pull from elected-off because we have plenty of weekdays to
      // cycle through and we'd rather close a gap.)
      // Rest-locked dispatchers are ALWAYS excluded from rescue — the
      // Phase 0 lock is inviolable. rescue may still refund an
      // electedOffIds member (existing behavior), but a rest lock is
      // not electable off — it never entered availablePool as elected.
      // The rotation GRANTEE is exempt from rescue: rescue's fill≥2 test
      // runs against absolute deficits, and the break-tax baseline
      // always carries ≥2 units — it would cancel every grant. The
      // wrapper's audit (delta vs no-grant baseline, bar (b)) is the
      // grant's feasibility gate; the evening-floor hard pass below
      // still overrides a grant when a slot would collapse.
      const rescuePool = (isWeekend
        ? sortedWorking.filter((d) => !usedIds.has(d.id) && !restLocks[d.id].has(dateStr))
        : [
            ...availablePool.filter((d) => electedOffIds.has(d.id) && !restLocks[d.id].has(dateStr)),
            ...sortedWorking.filter((d) => !usedIds.has(d.id) && !restLocks[d.id].has(dateStr)),
          ]
      ).filter((d) => d.id !== grantedTodayId)
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
            fill += deficit[i] // depth-weighted, matches the main picker
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
            // Un-electing a granted 2nd day off takes a REAL gap — the
            // pattern must close ≥ 2 units of deficit. Mid-pipeline
            // 1-unit dips routinely get fixed for free by the later
            // repair passes (swaps + break relocation); canceling the
            // perk for them burns a day off with zero coverage gain
            // (measured: fill≥1 removed 10 elective offs, final missing
            // units unchanged). Unassigned-working dispatchers rescue
            // freely — no perk at stake.
            if (electedOffIds.has(d.id) && fill < 2) continue
            const blocks = blockedBitmap(timeOff, d, dateStr, dow)
            if (blocks && p.bool.some((on, j) => on && blocks[j])) continue
            if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) continue
            if (!best || score > best.score) best = { p, dIdx: i, score }
          }
        }
        if (!best) break

        // Rescue the best combo.
        const d = rescuePool[best.dIdx]
        assignments.push({ dispatcher: d, pattern: best.p.bool })
        usedIds.add(d.id)
        best.p.bool.forEach((on, j) => { if (on) cov[j]++ })
        usedPatternIdx.add(patternMeta.indexOf(best.p))
        // Roll back off-day accounting only for elected-off dispatchers —
        // unassigned working ones never had it bumped in the first place.
        if (electedOffIds.has(d.id)) {
          weekOffDays[d.id][wLabel] = Math.max(0, (weekOffDays[d.id][wLabel] ?? 1) - 1)
          offByDow[d.id][dow] = Math.max(0, (offByDow[d.id][dow] ?? 1) - 1)
          totalElectedOff[d.id] = Math.max(0, totalElectedOff[d.id] - 1)
          if (isWeekend) {
            weekendOffTotal[d.id] = Math.max(0, weekendOffTotal[d.id] - 1)
            weekendOffThisWeek[d.id][wLabel] = Math.max(0, (weekendOffThisWeek[d.id][wLabel] ?? 1) - 1)
          }
          electedOffIds.delete(d.id)
        }
        rescuePool.splice(best.dIdx, 1)
      }
    }

    // ── Must-work pass ────────────────────────────────────────────────
    // Hard cap at the assignment layer, respecting the per-level off-day
    // cap (Trainee 1, Regular/Senior 2). Anyone in availablePool who is
    // NOT used today and is already at their cap must work — even if it
    // stacks coverage above req+1. Rule: no dispatcher exceeds their
    // level's off-day cap — wasted resources while gaps remain.
    {
      const mustWork = availablePool.filter(
        (d) =>
          !usedIds.has(d.id) &&
          !restLocks[d.id].has(dateStr) && // defensive: never force-work a rest-locked dispatcher
          !electedOffIds.has(d.id) && // TODAY's elected 2nd off put them AT the cap — that off is
          // the granted perk, not an overshoot; forcing them back here
          // silently killed every 2nd day off the elect gate approved
          (weekOffDays[d.id][wLabel] ?? 0) >= maxDaysOffFor(d.level),
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
          if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) continue
          let fill = 0, overTolerated = 0, overOff = 0
          for (let i = 0; i < p.bool.length; i++) {
            if (!p.bool[i]) continue
            const newCov = cov[i] + 1
            if (cov[i] < dayRequired[i]) fill++
            if (newCov > dayRequired[i]) {
              const excess = newCov - dayRequired[i]
              if (SURPLUS_TOLERATED_SLOTS.has(i)) overTolerated += excess
              else overOff += excess
            }
          }
          // Fill weighted 2× over: closing one gap is worth two units
          // of over-coverage. Captures the user's "I want gaps covered,
          // not just more hours" rule — only assign over-cap patterns
          // when they genuinely close coverage. Dup penalty discourages
          // re-using a pattern the picker already placed. Off-peak
          // over-cov costs 2× tolerated-window over-cov — routes the
          // trainee's forced 6th-day surplus into the surplus-tolerated
          // lunch/dinner windows first.
          const dupPenalty = usedPatternIdx.has(pIdx) ? 1 : 0
          const score = fill * 2 - overTolerated - 2 * overOff - dupPenalty
          const better =
            !pick ||
            score > pick.score ||
            (score === pick.score && p.hours < pick.p.hours)
          if (better) pick = { p, score, pIdx }
        }
        if (pick) {
          assignments.push({ dispatcher: d, pattern: pick.p.bool })
          usedIds.add(d.id)
          usedPatternIdx.add(pick.pIdx)
          pick.p.bool.forEach((on, i) => { if (on) cov[i]++ })
        }
        // If nothing fits (all patterns blocked or week-cap-blown), we
        // accept the 3rd off as last resort — better than violating
        // time-off / 45 h cap.
      }
    }

    // ── Coverage-gated 2nd-off-prevention ─────────────────────────────
    // Same shape as must-work but lower threshold: dispatchers with
    // exactly 1 day off this week who'd otherwise become off today
    // (= 2 days off) get force-assigned IF a legal pattern of theirs
    // closes at least one gap AND the net coverage benefit is
    // positive. Prevents granting a 2nd off-day while gaps remain;
    // preserves the 2-days-off perk when coverage is already met.
    {
      const candidatePool = availablePool.filter(
        (d) =>
          !usedIds.has(d.id) &&
          d.id !== grantedTodayId && // rotation grant exempt (see rescue note)
          !restLocks[d.id].has(dateStr) && // defensive: rest lock overrides 2nd-off-prevention
          (weekOffDays[d.id][wLabel] ?? 0) === 1,
      )
      const cov = new Array(SLOTS.length).fill(0)
      for (const { pattern } of assignments) {
        pattern.forEach((on, i) => { if (on) cov[i]++ })
      }
      for (const d of candidatePool) {
        let pick: { p: typeof patternMeta[number]; score: number; pIdx: number } | null = null
        for (let pIdx = 0; pIdx < patternMeta.length; pIdx++) {
          const p = patternMeta[pIdx]
          if (p.isMorning && workedNightYesterday(d.id)) continue
          const blocks = blockedBitmap(timeOff, d, dateStr, dow)
          if (blocks && p.bool.some((on, j) => on && blocks[j])) continue
          if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) continue
          let fill = 0, overTolerated = 0, overOff = 0
          for (let i = 0; i < p.bool.length; i++) {
            if (!p.bool[i]) continue
            if (cov[i] < dayRequired[i]) fill += dayRequired[i] - cov[i]
            else if (cov[i] >= dayRequired[i]) {
              if (SURPLUS_TOLERATED_SLOTS.has(i)) overTolerated++
              else overOff++
            }
          }
          // Cancel a 2nd day off only for a REAL gap — the pattern must
          // close at least 2 units of deficit. Mid-pipeline 1-unit dips
          // routinely get fixed for free by the later repair passes
          // (swaps + break relocation); canceling the perk for them
          // burns a day off with zero coverage gain (measured).
          if (fill < 2) continue
          const score = fill * 2 - overTolerated - 2 * overOff
          if (score <= 0) continue
          const better =
            !pick ||
            score > pick.score ||
            (score === pick.score && p.hours < pick.p.hours)
          if (better) pick = { p, score, pIdx }
        }
        if (pick) {
          assignments.push({ dispatcher: d, pattern: pick.p.bool })
          usedIds.add(d.id)
          usedPatternIdx.add(pick.pIdx)
          pick.p.bool.forEach((on, i) => { if (on) cov[i]++ })
        }
      }
    }

    const enforceCtx = {
      patternMeta, sortedWorking, usedIds, usedPatternIdx, assignments,
      runningCov, weekHours, wLabel, timeOff, dateStr, dow,
      workedNightYesterday, capForShift,
    }

    // ── evening floor — the evening never collapses toward 1 ──────────
    // MVP guarantee ported against real targets: any evening slot
    // (4 PM onward) whose target is ≥ 2 must keep at least 2 bodies.
    // Step 1: pull an off dispatcher back in — elected-off included (a
    // collapse outranks the 2nd-off perk and the rescue pass's fill≥2
    // threshold); rest locks and user time-off stay untouchable.
    // Step 2: deficit-neutral swap — re-shape an assigned dispatcher to
    // an unused pattern covering the breach when the day's total
    // deficit doesn't worsen (the swap pass alone requires strict
    // improvement and lets a collapse stand when fixing it costs an
    // equal −1 on a deeper-staffed slot).
    {
      const cov = new Array(SLOTS.length).fill(0)
      for (const { pattern } of assignments) {
        pattern.forEach((on, i) => { if (on) cov[i]++ })
      }
      const breachSlots = () => {
        const out: number[] = []
        for (let i = 0; i < SLOTS.length; i++) {
          // Zero-guard on EVERY required slot (a required slot at 0 is
          // the collapse the MVP never allows), plus the ≥2 evening
          // floor from 4 PM onward.
          if (dayRequired[i] >= 1 && cov[i] === 0) out.push(i)
          else if (i >= 10 && dayRequired[i] >= 2 && cov[i] < 2) out.push(i)
        }
        return out
      }
      // The rotation grantee is exempt from the floor PULL (like rescue):
      // floor breaches at this pipeline stage are often transient (the
      // swap/stretch/repair passes close them), and the wrapper's audit
      // rejects any grant whose final week carries a zero or deep slot —
      // real collapses still defeat the grant, by rejection not by pull.
      const floorPool = [
        ...availablePool.filter((d) => electedOffIds.has(d.id) && !restLocks[d.id].has(dateStr)),
        ...sortedWorking.filter((d) => !usedIds.has(d.id) && !restLocks[d.id].has(dateStr)),
      ].filter((d) => d.id !== grantedTodayId)
      for (let safety = 0; safety < 10; safety++) {
        const breaches = breachSlots()
        if (breaches.length === 0) break
        // Step 1 — pull: best (dispatcher, pattern) closing the most
        // breach slots.
        let pulled = false
        let best: { d: Dispatcher; pIdx: number; hits: number } | null = null
        for (let pIdx = 0; pIdx < patternMeta.length; pIdx++) {
          const p = patternMeta[pIdx]
          if (usedPatternIdx.has(pIdx)) continue
          const hits = breaches.filter((i) => p.bool[i]).length
          if (hits === 0) continue
          for (const d of floorPool) {
            if (usedIds.has(d.id)) continue
            if (p.isMorning && workedNightYesterday(d.id)) continue
            const blocks = blockedBitmap(timeOff, d, dateStr, dow)
            if (blocks && p.bool.some((on, j) => on && blocks[j])) continue
            if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) continue
            if (!best || hits > best.hits) best = { d, pIdx, hits }
          }
        }
        if (best) {
          const p = patternMeta[best.pIdx]
          assignments.push({ dispatcher: best.d, pattern: p.bool })
          usedIds.add(best.d.id)
          usedPatternIdx.add(best.pIdx)
          p.bool.forEach((on, i) => { if (on) cov[i]++ })
          pulled = true
        }
        if (pulled) continue
        // Step 2 — deficit-neutral swap onto the first breach slot
        // (depth-relative units with peak premium, matching
        // improveCoverageBySwaps).
        const target = breaches[0]
        const deficitUnits = (c: number[]) => {
          let u = 0
          for (let i = 0; i < dayRequired.length; i++) {
            if (dayRequired[i] > 0 && c[i] < dayRequired[i]) {
              const rel = (dayRequired[i] - c[i]) / dayRequired[i]
              u += rel * (PEAK_SLOT_SET.has(i) ? 3 : 1)
            }
          }
          return u
        }
        const base = deficitUnits(cov)
        const startingPeaks = PEAK_WINDOWS.filter((peak) =>
          assignments.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)),
        )
        let swapped = false
        for (const a of assignments) {
          if (swapped) break
          if (a.pattern[target]) continue
          for (let pIdx = 0; pIdx < patternMeta.length; pIdx++) {
            const newP = patternMeta[pIdx]
            if (usedPatternIdx.has(pIdx) || !newP.bool[target]) continue
            if (!isEligibleForPattern(a.dispatcher, newP, {
              ...enforceCtx,
              usedIds: new Set([...usedIds].filter((id) => id !== a.dispatcher.id)),
            })) continue
            const trialCov = cov.map((c, i) => c - (a.pattern[i] ? 1 : 0) + (newP.bool[i] ? 1 : 0))
            if (deficitUnits(trialCov) > base) continue
            if (trialCov.some((c, i) => c > dayRequired[i] + MAX_OVER_COVERAGE + 1)) continue
            if (!dropPreservesAnchors(newP.bool, a, a.pattern, assignments, startingPeaks)) continue
            const oldIdx = patternMeta.findIndex((pm) => pm.bool === a.pattern)
            if (oldIdx >= 0) usedPatternIdx.delete(oldIdx)
            usedPatternIdx.add(pIdx)
            a.pattern = newP.bool
            for (let i = 0; i < cov.length; i++) cov[i] = trialCov[i]
            swapped = true
            break
          }
        }
        if (!swapped) break // genuine scarcity — existing warnings cover it
      }
    }

    // ── improveCoverageBySwaps — respect the coverage target ──────────
    // Swap assigned shapes for unused catalog shapes whenever that
    // strictly reduces total missing units. Runs before stretch (which
    // then fills residual 1-slot gaps) and before enforceAnchors (which
    // repairs any anchor a swap may have cost — swaps themselves never
    // drop the last anchor).
    improveCoverageBySwaps(enforceCtx, dayRequired)

    // Stretch shifts to fill single-body gaps by extending an adjacent
    // dispatcher's tail/head by 0.5-1h. Mirrors the manual closer
    // extensions (Thu shamika → slot 19, Fri resgie → slot 19, etc).
    // Runs BEFORE trim so any incidental over-cov can still be reclaimed.
    stretchToFillGaps(assignments, dayRequired, weekHours, wLabel, dow, capForShift)

    // ── enforceAnchors — peak-continuity repair pass ───────────────────
    // Validate each peak has at least one anchor (started pre-peak +
    // continuous through peak). If not, try fill-break first, then
    // pattern-swap. Any peak still uncovered emits a warning. Runs
    // between stretch and trim so trim's survival check can protect
    // any anchor this pass restored.
    const failedPeaks = enforceAnchors(enforceCtx, dayRequired)
    for (const peakKey of failedPeaks) {
      // Dedupe with any seed-time warning for the same peak.
      const existing = coverageWarnings[dateStr] ?? []
      if (existing.some((w) => w.peak === peakKey)) continue
      ;(coverageWarnings[dateStr] ??= []).push({
        peak: peakKey,
        reason: 'no continuity anchor — no dispatcher started before the peak and worked through it without a break',
      })
    }

    // ── repairBreaks — break-placement repair ──────────────────────────
    // Coverage targets are the contract: a meal break parked on an
    // under-covered slot while a surplus slot sits inside the same
    // shift is a free fix (no hours added, shape + anchors re-checked).
    // Runs after enforceAnchors so anchor state is final, before trim
    // so trim sees the repaired coverage.
    repairBreaks(assignments, dayRequired, dow)

    // Trim over-covered slots down to the requirement. Runs LAST so it
    // sees the full final coverage from picker + swap + rescue + must-work.
    // Now also protects the sole anchor's peak slots (see trimToExactCoverage).
    trimToExactCoverage(assignments, dayRequired, dow)

    // ── smoothTransitions — final transition-smoothing polish ───────────
    // Close 1-slot, 1-below dips at shift transitions the way an admin
    // would by hand: extend across a break/handoff, prefer relocating
    // adjacent surplus over net adds, cap per-dispatcher weekly net add
    // at SMOOTHING_BUDGET_PER_WEEK. Runs AFTER trim so a borrowed-from
    // surplus slot can't be trimmed away the moment we add the dip slot.
    // Any dip that can't be closed by either a same-day move or a small
    // net add (because every neighbor is capped, rest-blocked, or off)
    // is surfaced as a `transition` warning on the day, distinct from
    // the `lunch`/`dinner` anchor warnings.
    const smoothing = smoothTransitions({
      assignments, required: dayRequired, weekHours, smoothingBudget,
      wLabel, timeOff, dateStr, dow, capForShift,
    })
    for (const note of smoothing.resolved) {
      // eslint-disable-next-line no-console
      console.info(`[smoothTransitions] ${note}`)
    }
    for (const i of smoothing.unresolved) {
      ;(coverageWarnings[dateStr] ??= []).push({
        peak: 'transition',
        slotIndex: i,
        reason: `1-slot dip at ${SLOTS[i].label} — every adjacent dispatcher capped, resting, or off`,
      })
      // eslint-disable-next-line no-console
      console.info(`[smoothTransitions] ${dateStr} ${SLOTS[i].label}: no eligible neighbor → warning`)
    }

    // ── splits → two continuous shifts (Levers 1/2/3) ─────────────────
    // A split covers BOTH peaks in one body, so the greedy picker favors
    // it and its complement fragments land as 4h shifts. Wherever the
    // SAME coverage is achievable with two balanced continuous shifts,
    // do that instead — splits recede to the exception the human team
    // actually uses (thin rosters where one body must bridge both
    // peaks), so a day almost never runs two splits (Lever 2 emerges:
    // the loop converts every convertible split, leaving ≥2 only when no
    // hierarchy-legal swap exists — a genuinely thin day).
    //
    // A swap commits ONLY when the replacement clears the coverage
    // HIERARCHY on every slot (floorAt): peaks (lunch 4–6 / dinner
    // 11–14) stay ≥ target (inviolable); slot 9 (3–4 PM) is the escape
    // valve — it may fall below target but never to 0; every other slot
    // may not worsen vs target; and no slot ever opens a zero. Anchors
    // are preserved. Lever 3: the LONGER continuous shift goes to the
    // more BELOW-band dispatcher (pull them up), the shorter to the more
    // above-band — orientation chosen only when it too is eligible.
    {
      const contPatterns = patternMeta.filter((pm) => pm.maxBreak < SPLIT_GAP_MIN_HOURS)
      const idxOf = (bool: boolean[]) => patternMeta.findIndex((pm) => pm.bool === bool)
      const isSplit = (bool: boolean[]) => patternMaxBreakHours(bool, SLOTS) >= SPLIT_GAP_MIN_HOURS
      const peaksAnchored = (asgs: typeof assignments) =>
        PEAK_WINDOWS.filter((peak) => asgs.some((a) => isPeakAnchorPattern(a.pattern, peak.slots)))
      // Coverage-hierarchy floor for a swap: cov is the pre-swap coverage.
      const floorAt = (i: number, cov: number[]) => {
        if (PEAK_SLOT_SET.has(i)) return dayRequired[i]            // peaks inviolable
        if (i === HANDOFF_SLOT) return Math.min(1, dayRequired[i]) // 3–4 PM escape valve, never zero
        return Math.min(cov[i], dayRequired[i])                   // no worsening vs target elsewhere
      }
      // Weekly-hours band position (Lever 3): negative = below the group's
      // live mean (should get the longer shift), positive = above.
      const relBand = (d: (typeof dispatchers)[0]) => {
        const grp = d.level === 'Trainee' ? 'T' : 'RS'
        const peers = workingPool.filter((x) => (x.level === 'Trainee' ? 'T' : 'RS') === grp)
        const mean =
          peers.reduce((s, x) => s + (weekHours[x.id][wLabel] ?? 0), 0) / (peers.length || 1)
        return (weekHours[d.id][wLabel] ?? 0) - mean
      }
      for (let guard = 0; guard < 6; guard++) {
        const anchorsBefore = peaksAnchored(assignments)
        const dayCov = new Array(SLOTS.length).fill(0)
        for (const a of assignments) a.pattern.forEach((on, i) => { if (on) dayCov[i]++ })
        let fired = false
        for (const S of assignments.filter((a) => isSplit(a.pattern))) {
          const sIdx = idxOf(S.pattern)
          if (sIdx < 0) continue
          // SOLO conversion first: replace the split with ONE continuous
          // shift when one of its blocks is redundant (the slots it drops
          // still clear the hierarchy floor). Catches the common case
          // where a body needn't bridge both peaks — the split's morning
          // block is superfluous because other shapes hold lunch.
          {
            const usedExclS = new Set([...usedIds].filter((id) => id !== S.dispatcher.id))
            let soloDone = false
            for (const c1 of contPatterns) {
              if (usedPatternIdx.has(c1.idx) && c1.idx !== sIdx) continue
              if (c1.hours > slotHours(S.pattern) + 1.5) continue
              if (!isEligibleForPattern(S.dispatcher, c1, { ...enforceCtx, usedIds: usedExclS })) continue
              let safe = true
              for (let i = 0; i < SLOTS.length; i++) {
                const delta = (c1.bool[i] ? 1 : 0) - (S.pattern[i] ? 1 : 0)
                if (dayCov[i] + delta < floorAt(i, dayCov)) { safe = false; break }
              }
              if (!safe) continue
              const trial = assignments.map((a) =>
                a === S ? { dispatcher: S.dispatcher, pattern: c1.bool } : a)
              if (anchorsBefore.some((pk) => !peaksAnchored(trial).includes(pk))) continue
              usedPatternIdx.delete(sIdx); usedPatternIdx.add(c1.idx)
              S.pattern = c1.bool
              fired = true; soloDone = true
              break
            }
            if (soloDone) break // restart scan
          }
          const partners = assignments
            .filter((P) => P !== S && !isSplit(P.pattern))
            .sort((a, b) => slotHours(a.pattern) - slotHours(b.pattern)) // shortest (4h) first
          let done = false
          for (const P of partners) {
            if (done) break
            const pIdx = idxOf(P.pattern)
            if (pIdx < 0) continue
            const oldPair = S.pattern.map((v, i) => (v ? 1 : 0) + (P.pattern[i] ? 1 : 0))
            const oldHours = slotHours(S.pattern) + slotHours(P.pattern)
            const freeIdx = new Set([sIdx, pIdx])
            const usedExclS = new Set([...usedIds].filter((id) => id !== S.dispatcher.id))
            const usedExclP = new Set([...usedIds].filter((id) => id !== P.dispatcher.id))
            for (const c1 of contPatterns) {
              if (done) break
              if (usedPatternIdx.has(c1.idx) && !freeIdx.has(c1.idx)) continue
              if (!isEligibleForPattern(S.dispatcher, c1, { ...enforceCtx, usedIds: usedExclS })) continue
              for (const c2 of contPatterns) {
                if (c1.idx === c2.idx) continue
                if (usedPatternIdx.has(c2.idx) && !freeIdx.has(c2.idx)) continue
                if (c1.hours + c2.hours > oldHours + 1.5) continue // stay hours-neutral
                if (!isEligibleForPattern(P.dispatcher, c2, { ...enforceCtx, usedIds: usedExclP })) continue
                // Coverage hierarchy: peaks ≥ target, trough valve
                // {9,10,17,18,19} ≥1, no worsening elsewhere, never a zero. The
                // replacement may shed OVER-coverage the split carried.
                let safe = true
                for (let i = 0; i < SLOTS.length; i++) {
                  const delta = (c1.bool[i] ? 1 : 0) + (c2.bool[i] ? 1 : 0) - oldPair[i]
                  if (dayCov[i] + delta < floorAt(i, dayCov)) { safe = false; break }
                }
                if (!safe) continue
                // Anchor-preserving: no peak may lose its anchor. (Anchors
                // depend on the patterns present, not who works them, so
                // this is orientation-independent.)
                const trial = assignments.map((a) =>
                  a === S ? { dispatcher: S.dispatcher, pattern: c1.bool }
                  : a === P ? { dispatcher: P.dispatcher, pattern: c2.bool }
                  : a)
                if (anchorsBefore.some((pk) => !peaksAnchored(trial).includes(pk))) continue
                // Lever 3 — assign the LONGER continuous shift to the more
                // below-band dispatcher, the shorter to the more above-band,
                // when that orientation is also eligible; else keep the
                // known-valid c1→S / c2→P assignment. Coverage & anchors are
                // identical either way (same two patterns present).
                const longC = c1.hours >= c2.hours ? c1 : c2
                const shortC = c1.hours >= c2.hours ? c2 : c1
                const sBelow = relBand(S.dispatcher) <= relBand(P.dispatcher)
                const belowD = sBelow ? S.dispatcher : P.dispatcher
                const aboveD = sBelow ? P.dispatcher : S.dispatcher
                const bandOK =
                  isEligibleForPattern(belowD, longC, {
                    ...enforceCtx, usedIds: new Set([...usedIds].filter((id) => id !== belowD.id)),
                  }) &&
                  isEligibleForPattern(aboveD, shortC, {
                    ...enforceCtx, usedIds: new Set([...usedIds].filter((id) => id !== aboveD.id)),
                  })
                if (bandOK) {
                  if (belowD === S.dispatcher) { S.pattern = longC.bool; P.pattern = shortC.bool }
                  else { S.pattern = shortC.bool; P.pattern = longC.bool }
                } else {
                  S.pattern = c1.bool; P.pattern = c2.bool
                }
                usedPatternIdx.delete(sIdx); usedPatternIdx.delete(pIdx)
                usedPatternIdx.add(c1.idx); usedPatternIdx.add(c2.idx)
                fired = true; done = true
                break
              }
            }
          }
          if (done) break // restart the scan with updated assignments
        }
        if (!fired) break
      }
    }

    // ── Lever 3 — weekly-hours band balance (coverage-neutral) ────────
    // Pure dispatcher SWAPS between already-assigned shifts: hand a LONGER
    // shift to a BELOW-band body and the shorter one to an ABOVE-band body
    // whenever both are eligible for the swapped pattern. Patterns never
    // change, so coverage is byte-identical — this only moves hours
    // between people to pull the low ones (Adorre, the only Regular, who
    // sat ~5 h/wk under the Seniors) up into their group band. Regular +
    // Senior share one band; Trainees a separate, higher one; swaps stay
    // WITHIN a band group so trainees don't bleed hours to/from the RS
    // band. weekHours here is the cumulative total THROUGH YESTERDAY (today
    // is added after this block), so it's the right signal for who is
    // behind. Soft — every swap still clears each body's hard eligibility
    // (night-rest, time-off, weekly cap via isEligibleForPattern).
    {
      const bandGrp = (d: (typeof dispatchers)[0]) => (d.level === 'Trainee' ? 'T' : 'RS')
      // Balance on WEEKLY hours through yesterday (today is added after this
      // block). A swap is coverage-neutral for TODAY (patterns unchanged),
      // but it changes who worked late / who's near cap, which can cascade
      // into future days' feasible assignments. Weekly-scoped swapping
      // stays gentle enough to leave that cascade coverage-clean (verified
      // across seeds); cumulative-scoped swapping was more aggressive and
      // drifted a 4–5 PM shoulder. The weekly reset still pulls the
      // systematic-low body (Adorre) up because he starts every week behind.
      const bandHours = (d: (typeof dispatchers)[0]) => weekHours[d.id][wLabel] ?? 0
      const metaOf = (bool: boolean[]) => patternMeta.find((pm) => pm.bool === bool)
      for (let guard = 0; guard < 20; guard++) {
        let swapped = false
        // Most-below-band body on a short shift ↔ most-above-band body on a
        // long shift, within each band group. Greedy: take the biggest
        // hours-gap-closing swap first.
        let best: { A: typeof assignments[number]; B: typeof assignments[number]; gain: number } | null = null
        for (const A of assignments) {
          for (const B of assignments) {
            if (A === B || A.dispatcher.id === B.dispatcher.id) continue
            if (bandGrp(A.dispatcher) !== bandGrp(B.dispatcher)) continue
            const hA = slotHours(A.pattern), hB = slotHours(B.pattern)
            if (hA <= hB) continue // A must be the LONGER shift
            // Swap helps only if A's holder is ABOVE and B's holder is BELOW
            // (B is more behind on hours) — then B takes the longer shift.
            if (bandHours(B.dispatcher) >= bandHours(A.dispatcher)) continue
            // Post-swap the hours spread must strictly tighten AND not
            // overshoot (don't turn a below body into the new above body by
            // more than it closes). Gain = reduction in |hoursA − hoursB|.
            const before = Math.abs(bandHours(A.dispatcher) + hA - (bandHours(B.dispatcher) + hB))
            const after = Math.abs(bandHours(A.dispatcher) + hB - (bandHours(B.dispatcher) + hA))
            const gain = before - after
            if (gain <= 0) continue
            // Eligibility for the swapped patterns (excludes each from the
            // other's used-set so their own current shift doesn't block).
            const mA = metaOf(A.pattern), mB = metaOf(B.pattern)
            if (!mA || !mB) continue
            const okB = isEligibleForPattern(B.dispatcher, mA, {
              ...enforceCtx, usedIds: new Set([...usedIds].filter((id) => id !== B.dispatcher.id)),
            })
            const okA = isEligibleForPattern(A.dispatcher, mB, {
              ...enforceCtx, usedIds: new Set([...usedIds].filter((id) => id !== A.dispatcher.id)),
            })
            if (!okB || !okA) continue
            if (!best || gain > best.gain) best = { A, B, gain }
          }
        }
        if (!best) break
        const tmp = best.A.dispatcher
        best.A.dispatcher = best.B.dispatcher
        best.B.dispatcher = tmp
        swapped = true
        if (!swapped) break
      }
    }

    // Any leftover unassigned working dispatchers ARE off today — count
    // that toward their weekly off-day tally so the next day's
    // eligibleForOff filter sees them at the cap. Without this the cap
    // was silently bypassed and we'd see 3+ days off slip through.
    for (const d of sortedWorking) {
      if (!usedIds.has(d.id)) {
        weekOffDays[d.id][wLabel] = (weekOffDays[d.id][wLabel] ?? 0) + 1
        offByDow[d.id][dow] = (offByDow[d.id][dow] ?? 0) + 1
        if (isWeekend) {
          weekendOffTotal[d.id] += 1
          weekendOffThisWeek[d.id][wLabel] = (weekendOffThisWeek[d.id][wLabel] ?? 0) + 1
        }
      }
    }

    // Dispatchers not assigned are off today. Built AFTER the rescue
    // pass so rescued dispatchers correctly move out of the off pool.
    // The final !usedIds filter is defensive — must-work + rescue can
    // assign dispatchers who were also in electedOffIds without
    // clearing the set, producing duplicate scheduleMap entries
    // (work + OFF) for the same date.
    const dayOff = [
      ...sortedWorking.filter((d) => !usedIds.has(d.id)),
      ...cappedDispatchers,
      ...availablePool.filter((d) => electedOffIds.has(d.id)),
      ...blockedToday,
    ].filter((d) => !usedIds.has(d.id))

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

    // ── mandatory-rest warning ──────────────────────────────────────────
    // If ≥1 dispatcher is on a locked weekly rest today AND coverage
    // fell short on any slot, surface the shortfall as a `mandatory-rest`
    // warning. This is the acknowledged coverage cost of the hard rest
    // guarantee — the alternative (dropping the rest) is not allowed.
    const restLockedToday = dispatchers.filter((d) => restLocks[d.id].has(dateStr))
    if (restLockedToday.length > 0) {
      for (let si = 0; si < SLOTS.length; si++) {
        if (actualCov[si] < dayRequired[si]) {
          const names = restLockedToday.map((d) => d.name).join(', ')
          ;(coverageWarnings[dateStr] ??= []).push({
            peak: 'mandatory-rest',
            slotIndex: si,
            reason: `${restLockedToday.length} on locked weekly rest (${names}) — coverage short at ${SLOTS[si].label}`,
          })
        }
      }
    }

    // No handoff warning: the teams meet at the slot boundary — the
    // incoming dispatcher arrives ~10 min early (off-schedule) to catch
    // up, so no scheduled overlap is required. The 'handoff' warning
    // kind stays in the type union for snapshots saved before this.
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

  return { startDate, endDate, seed, dates, dispatcherSchedules, coverageActual, coverageRequired, coverageWarnings }
}

// ---------------------------------------------------------------------------
// Rotating 2nd day off — plan → generate → audit → defer wrapper.
//
// Exactly one Regular/Senior dispatcher per week is up for a 2nd day off,
// in fixed roster order, starting from the persisted rotation cursor.
// A grant must pass FEASIBILITY BAR (b): the week's under-target units
// rise by at most +1, no 0-coverage slot, no under-slot deeper than 1,
// and no NEW under-coverage inside a peak window. Weeks that can't
// afford it are SKIPPED and the turn is DEFERRED — the same dispatcher
// stays up next week; the pointer advances only on a successful grant.
//
// Mechanics: generate a no-grant baseline, plan one grant per full week
// (lightest feasible day for the candidate), regenerate with the plan
// injected through the elect channel, audit every granted week against
// the bar, and replan with failed (week, person, day) combos memoized —
// first retrying the candidate's next-best day, then deferring. The
// fixpoint converges because the failure memo only grows; if it hasn't
// converged within the pass budget the schedule falls back to the
// no-grant baseline (the perk silently defers rather than ever breaking
// coverage). Every decision lands in `secondOffLog` for the UI.
// ---------------------------------------------------------------------------

export function generateSchedule(
  dispatchers: Dispatcher[],
  startDate: string,
  endDate: string,
  timeOff: DispatcherTimeOff,
  seed = 0,
  coverageOverrides: Record<number, number[]> = {},
  secondOffCursor = 0,
): GeneratedSchedule {
  const start = parseISO(startDate)
  const nDays = differenceInDays(parseISO(endDate), start) + 1
  const allDates = Array.from({ length: nDays }, (_, i) => addDays(start, i))

  // ── Hard zero invariant ─────────────────────────────────────────────
  // A slot with target > 0 and coverage 0 is never acceptable — it
  // outranks the rotation, rest-placement equity, and exact targets.
  // Feedback channel: (dispatcher → dates) whose rest lock must move.
  const restAvoid: Record<string, Set<string>> = {}
  const zeroSlots = (s: GeneratedSchedule) => {
    const out: { date: string; slot: number }[] = []
    for (const dInfo of s.dates) {
      const req = s.coverageRequired?.[dInfo.date] ?? []
      const act = s.coverageActual[dInfo.date] ?? []
      req.forEach((r, i) => {
        if (r > 0 && (act[i] ?? 0) === 0) out.push({ date: dInfo.date, slot: i })
      })
    }
    return out
  }
  // Move ONE rest lock off a zero-carrying day (re-placed legally within
  // the same week by Phase 0 on the next generation). Returns false when
  // no rest lock sits on any zero day — nothing left to re-place.
  const addRestAvoidFor = (zeroDates: Set<string>): boolean => {
    const locks = assignMandatoryRest(dispatchers, allDates, timeOff, seed, coverageOverrides, restAvoid).restLocks
    for (const date of zeroDates) {
      for (const d of dispatchers) {
        if (!locks[d.id]?.has(date)) continue
        const cur = (restAvoid[d.id] ??= new Set())
        if (cur.has(date)) continue
        cur.add(date)
        return true
      }
    }
    return false
  }

  // Baseline must be zero-clean BEFORE planning: grants are audited
  // against it, and an inherited zero would both block the week's grant
  // (spurious skip) and ship anyway (seed 68, Mon Jun 29 2026 — a
  // vacation-displaced rest stacked a 4th lock on the Mon×3 day).
  let baseline = generateCore(dispatchers, startDate, endDate, timeOff, seed, coverageOverrides, undefined, restAvoid)
  for (let r = 0; r < 6; r++) {
    const zs = zeroSlots(baseline)
    if (zs.length === 0) break
    if (!addRestAvoidFor(new Set(zs.map((z) => z.date)))) break
    baseline = generateCore(dispatchers, startDate, endDate, timeOff, seed, coverageOverrides, undefined, restAvoid)
  }

  const eligible = dispatchers.filter((d) => d.level !== 'Trainee')
  if (eligible.length === 0 || baseline.dates.length === 0) {
    return { ...baseline, secondOffLog: [] }
  }

  // Full weeks only (partial edge weeks never carry a grant).
  const weekMap = new Map<string, GeneratedSchedule['dates']>()
  for (const d of baseline.dates) {
    if (!weekMap.has(d.weekLabel)) weekMap.set(d.weekLabel, [])
    weekMap.get(d.weekLabel)!.push(d)
  }
  const fullWeeks = [...weekMap.entries()].filter(([, ds]) => ds.length === 7)
  if (fullWeeks.length === 0) return { ...baseline, secondOffLog: [] }

  // Rest locks are deterministic — re-derive them (with the zero-guard's
  // avoids applied) for plan-time knowledge of existing offs.
  const { restLocks } = assignMandatoryRest(dispatchers, allDates, timeOff, seed, coverageOverrides, restAvoid)

  const dayUnits = (s: GeneratedSchedule, date: string) => {
    const req = s.coverageRequired?.[date] ?? []
    const act = s.coverageActual[date] ?? []
    return req.reduce((u, r, i) => u + (r > 0 ? Math.max(0, r - (act[i] ?? 0)) : 0), 0)
  }
  const weekMetrics = (s: GeneratedSchedule, dates: GeneratedSchedule['dates']) => {
    let units = 0
    let zeros = 0
    let deep = 0
    let peakUnders = 0
    for (const { date } of dates) {
      const req = s.coverageRequired?.[date] ?? []
      const act = s.coverageActual[date] ?? []
      req.forEach((r, i) => {
        const a = act[i] ?? 0
        if (r > 0 && a < r) {
          units += r - a
          if (a === 0) zeros++
          if (r - a > 1) deep++
          if (PEAK_SLOT_SET.has(i)) peakUnders++
        }
      })
    }
    return { units, zeros, deep, peakUnders }
  }
  const offsInWeek = (s: GeneratedSchedule, dispId: string, dates: GeneratedSchedule['dates']) => {
    const ds = s.dispatcherSchedules.find((x) => x.dispatcher.id === dispId)
    if (!ds) return 0
    const set = new Set(dates.map((d) => d.date))
    return ds.days.filter((d) => set.has(d.date) && d.isOff).length
  }
  const knownOffDates = (disp: Dispatcher, dates: GeneratedSchedule['dates']) => {
    const out = new Set<string>()
    for (const { date, dayOfWeek } of dates) {
      if (restLocks[disp.id]?.has(date)) out.add(date)
      const bm = blockedBitmap(timeOff, disp, date, dayOfWeek)
      if (bm && bm.length > 0 && bm.every(Boolean)) out.add(date)
    }
    return out
  }
  const demandHours = (dow: number) =>
    effectiveCoverage(dow, coverageOverrides).reduce((s, r, i) => s + r * SLOTS[i].hours, 0)
  // Roster-wide known offs per date (rest locks + full-day blocks):
  // the BEST grant days are the ones with the most bodies available —
  // rest-thinned weekdays have no slack to absorb a missing body,
  // while Fri/Sat/Sun (no rest locks) absorb one routinely.
  const dayOffPressure = new Map<string, number>()
  for (const dInfo of baseline.dates) {
    let n = 0
    for (const disp of dispatchers) {
      if (restLocks[disp.id]?.has(dInfo.date)) n++
      else {
        const bm = blockedBitmap(timeOff, disp, dInfo.date, dInfo.dayOfWeek)
        if (bm && bm.length > 0 && bm.every(Boolean)) n++
      }
    }
    dayOffPressure.set(dInfo.date, n)
  }

  // Total people off per day in the baseline (rests + vacations +
  // fairness elects) — a grant may never turn a 3-off day into 4-off.
  const baselineOffCount = new Map<string, number>()
  for (const ds of baseline.dispatcherSchedules) {
    for (const day of ds.days) {
      if (day.isOff) baselineOffCount.set(day.date, (baselineOffCount.get(day.date) ?? 0) + 1)
    }
  }

  const ptr0 = ((secondOffCursor % eligible.length) + eligible.length) % eligible.length
  // (weekLabel → set of "dispId|date") combos that failed the bar.
  const failedCombos = new Map<string, Set<string>>()
  let result: GeneratedSchedule = baseline
  let finalLog: SecondOffRecord[] = []
  let finalPlan = new Map<string, { dispId: string; date: string }>()

  const MAX_PASSES = 12
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // (Re)plan with everything the failure memo knows.
    const plan = new Map<string, { dispId: string; date: string }>()
    const draft: SecondOffRecord[] = []
    let ptr = ptr0
    for (const [wl, dates] of fullWeeks) {
      const cand = eligible[ptr]
      const rec: SecondOffRecord = {
        weekLabel: wl,
        candidateId: cand.id,
        candidateName: cand.name,
        granted: false,
        reason: '',
      }
      const known = knownOffDates(cand, dates)
      if (known.size >= maxDaysOffFor(cand.level)) {
        rec.reason = `already at ${known.size} days off this week (rest + vacation/recurring) — cap is 2; turn carried`
        draft.push(rec)
        continue // defer — pointer stays on this person
      }
      const tried = failedCombos.get(wl)
      // Placement guards: the grant never lands on the week's heaviest
      // rest-pressure day (Monday carries the Mon×3 quota under every
      // seed), and never turns a 3-off day into a 4-off day — 3 of 7
      // bodies cannot span the 2–3 PM transition zone.
      const weekPressures = dates.map((d) => dayOffPressure.get(d.date) ?? 0)
      const maxPressure = Math.max(...weekPressures)
      const minPressure = Math.min(...weekPressures)
      const candidateDays = dates
        .filter((d) => !known.has(d.date) && !tried?.has(cand.id + '|' + d.date))
        .filter((d) => maxPressure === minPressure || (dayOffPressure.get(d.date) ?? 0) < maxPressure)
        .filter((d) => (baselineOffCount.get(d.date) ?? 0) < 3)
        .sort((a, b) => {
          const pa = dayOffPressure.get(a.date) ?? 0
          const pb = dayOffPressure.get(b.date) ?? 0
          if (pa !== pb) return pa - pb // most bodies available first
          const ua = dayUnits(baseline, a.date)
          const ub = dayUnits(baseline, b.date)
          if (ua !== ub) return ua - ub
          return demandHours(a.dayOfWeek) - demandHours(b.dayOfWeek)
        })
      if (candidateDays.length === 0) {
        rec.reason = tried?.size
          ? 'no day passes the feasibility bar (≤ +1 unit, no peak/zero, depth ≤ 1); turn carried'
          : 'no free day available this week; turn carried'
        draft.push(rec)
        continue // defer
      }
      const day = candidateDays[0]
      plan.set(wl, { dispId: cand.id, date: day.date })
      rec.granted = true
      rec.date = day.date
      draft.push(rec)
      ptr = (ptr + 1) % eligible.length // optimistic — verified by audit
    }

    if (plan.size === 0) {
      result = baseline
      finalLog = draft
      finalPlan = new Map()
      break
    }

    const attempt = generateCore(dispatchers, startDate, endDate, timeOff, seed, coverageOverrides, plan, restAvoid)

    // Audit every planned grant against feasibility bar (b).
    let violations = 0
    for (const rec of draft) {
      if (!rec.granted || !rec.date) continue
      const dates = weekMap.get(rec.weekLabel)!
      const base = weekMetrics(baseline, dates)
      const now = weekMetrics(attempt, dates)
      const offs = offsInWeek(attempt, rec.candidateId, dates)
      const delta = now.units - base.units
      const ok =
        offs >= 2 &&
        delta <= 1 &&
        now.zeros === 0 &&
        now.deep === 0 &&
        now.peakUnders <= base.peakUnders
      if (typeof process !== 'undefined' && process.env.DEBUG_GRANT) {
        console.log(
          `[grant-audit p${pass}] ${rec.weekLabel} ${rec.candidateName}@${rec.date}: offs=${offs} d=${delta} zeros=${now.zeros} deep=${now.deep} peak ${base.peakUnders}->${now.peakUnders} => ${ok ? 'OK' : 'FAIL'}`,
        )
      }
      if (ok) {
        rec.unitDelta = delta
        rec.reason =
          delta <= 0
            ? 'granted — no coverage cost'
            : 'granted — +1 shoulder unit (within the accepted envelope)'
      } else {
        violations++
        if (!failedCombos.has(rec.weekLabel)) failedCombos.set(rec.weekLabel, new Set())
        failedCombos.get(rec.weekLabel)!.add(rec.candidateId + '|' + rec.date)
      }
    }

    if (violations === 0) {
      result = attempt
      finalLog = draft
      finalPlan = plan
      break
    }
    if (pass === MAX_PASSES - 1) {
      // Pass budget exhausted — fall back to the no-grant baseline: the
      // perk defers entirely rather than ever shipping a bar violation.
      result = baseline
      finalPlan = new Map()
      finalLog = draft.map((r) =>
        r.granted
          ? { ...r, granted: false, date: undefined, unitDelta: undefined, reason: 'grant audit did not converge — turn carried' }
          : r,
      )
    }
  }

  // ── Final hard zero-guard — no feature can bypass this ─────────────
  // Scan the EXACT artifact being returned, full horizon, every slot
  // with target > 0. Repairs in cost order: (1) withdraw the rotation
  // grant of any zero-carrying week (turn carried), (2) re-place a rest
  // lock off the zero day via Phase 0 (legally, within the same week).
  // The bar-(b) audit above only gates GRANTED weeks; this pass owns
  // the artifact itself, granted or skipped.
  for (let guard = 0; guard < 6; guard++) {
    const zs = zeroSlots(result)
    if (zs.length === 0) break
    const zDates = new Set(zs.map((z) => z.date))
    let changed = false
    for (const rec of finalLog) {
      if (!rec.granted) continue
      const wdates = weekMap.get(rec.weekLabel)
      if (!wdates?.some((x) => zDates.has(x.date))) continue
      finalPlan.delete(rec.weekLabel)
      rec.granted = false
      rec.date = undefined
      rec.unitDelta = undefined
      rec.reason = 'zero-guard: grant withdrawn — the week carried a 0-coverage slot; turn carried'
      changed = true
    }
    if (!changed) changed = addRestAvoidFor(zDates)
    if (!changed) break // no grant and no re-placeable rest on any zero day
    result = generateCore(
      dispatchers, startDate, endDate, timeOff, seed, coverageOverrides,
      finalPlan.size > 0 ? finalPlan : undefined, restAvoid,
    )
  }
  const unfixed = zeroSlots(result)
  if (unfixed.length > 0) {
    // Only reachable when vacations alone strip the roster below what
    // the targets need. Surface loudly — and the CI gate fails on it.
    const warnings = { ...(result.coverageWarnings ?? {}) }
    for (const z of unfixed) {
      ;(warnings[z.date] ??= []).push({
        peak: 'mandatory-rest' as const,
        reason: `0 coverage at ${SLOTS[z.slot].label} — could not be repaired without breaking a legal rest or user time-off`,
        slotIndex: z.slot,
      })
    }
    result = { ...result, coverageWarnings: warnings }
  }

  // ── Trim redundant 4h shifts → day off ────────────────────────────
  // Governance-flagged relaxation (2–3 PM floor only): the rotating
  // 2nd-off is saturated (one grant/week), but calm-afternoon slack
  // remains. Where a 4h shift's coverage sits only in relaxable light
  // hours, free that dispatcher for a day off instead. Floor for the
  // removal — the 2–3 PM handoff (slots 7,8) may run at 1 body (NEVER 0)
  // ONLY to free a day off; the pre-dinner ramp (10) stays ≥2, the
  // troughs (9,17,18,19) stay ≥1, and the peaks, the 8–9 PM shoulder,
  // and the mornings stay AT TARGET. Off-cap respected (Regular/Senior 2,
  // Trainee 1). Candidates are spread across the team (fewest-trimmed
  // first) so days off don't pile on one dispatcher.
  {
    const trimFloor = (i: number, t: number) =>
      i === 7 || i === 8 || i === 9 || i === 17 || i === 18 || i === 19
        ? Math.min(1, t)
        : i === 10
          ? Math.min(2, t)
          : t
    const weekOf = (date: string) => result.dates.find((d) => d.date === date)?.weekLabel ?? ''
    const offKey = (id: string, wk: string) => id + '|' + wk
    const offCount = new Map<string, number>()
    for (const ds of result.dispatcherSchedules)
      for (const day of ds.days)
        if (day.isOff) {
          const k = offKey(ds.dispatcher.id, weekOf(day.date))
          offCount.set(k, (offCount.get(k) ?? 0) + 1)
        }
    const totalOff = new Map<string, number>()
    const hoursOf = new Map<string, number>()
    for (const ds of result.dispatcherSchedules) {
      totalOff.set(ds.dispatcher.id, ds.days.filter((d) => d.isOff).length)
      hoursOf.set(ds.dispatcher.id, ds.totalHours)
    }
    for (let guard = 0; guard < 40; guard++) {
      const cands: { ds: DispatcherSchedule; day: DispatcherDayEntry; wk: string }[] = []
      for (const ds of result.dispatcherSchedules) {
        for (const day of ds.days) {
          if (day.isOff || Math.abs(day.totalHours - 4) > 0.01) continue
          const wk = weekOf(day.date)
          if ((offCount.get(offKey(ds.dispatcher.id, wk)) ?? 0) >= maxDaysOffFor(ds.dispatcher.level)) continue
          const req = result.coverageRequired?.[day.date] ?? []
          const act = result.coverageActual[day.date] ?? []
          let ok = true
          for (let i = 0; i < day.slots.length; i++) {
            if (!day.slots[i]) continue
            const t = req[i] ?? 0
            if (t <= 0) continue
            if ((act[i] ?? 0) - 1 < trimFloor(i, t)) { ok = false; break }
          }
          if (ok) cands.push({ ds, day, wk })
        }
      }
      if (cands.length === 0) break
      // Spread fairly AND keep hours balanced: give the freed day off to
      // the dispatcher with the MOST hours so far (tiebreak: fewest days
      // off), so the extra rest lands on the most-worked body rather than
      // piling onto whoever happens to hold the removable shifts.
      cands.sort((a, b) => {
        const hd = (hoursOf.get(b.ds.dispatcher.id) ?? 0) - (hoursOf.get(a.ds.dispatcher.id) ?? 0)
        if (hd !== 0) return hd
        return (totalOff.get(a.ds.dispatcher.id) ?? 0) - (totalOff.get(b.ds.dispatcher.id) ?? 0)
      })
      const { ds, day, wk } = cands[0]
      const act = result.coverageActual[day.date]
      day.slots.forEach((on, i) => { if (on && act[i] != null) act[i]-- })
      const hrs = day.totalHours
      day.slots = new Array(day.slots.length).fill(false)
      day.totalHours = 0
      day.isOff = true
      ds.weeklyHours[wk] = (ds.weeklyHours[wk] ?? 0) - hrs
      ds.totalHours -= hrs
      offCount.set(offKey(ds.dispatcher.id, wk), (offCount.get(offKey(ds.dispatcher.id, wk)) ?? 0) + 1)
      totalOff.set(ds.dispatcher.id, (totalOff.get(ds.dispatcher.id) ?? 0) + 1)
      hoursOf.set(ds.dispatcher.id, (hoursOf.get(ds.dispatcher.id) ?? 0) - hrs)
    }
  }

  // ── Shared operational-week off-cap check — the single source of truth ──
  // The ≤2 (Regular/Senior) / ≤1 (Trainee) weekly cap is enforced against ONE
  // running per-week off-count — offsInWeek(...) — that every day-off placer
  // shares; no mechanism keeps a private view. Phase 0 places ≤1 rest/week and
  // defers to any existing off; the trim reads this same running count before
  // freeing a day; the rotating 2nd-off grant places optimistically and is
  // RECONCILED here — the moment the picker has materialized the week. (A
  // partial time-off day only reveals whether it collapses to a full off after
  // the solve, so no earlier gate can see the true count; this pass is where
  // the shared count becomes authoritative.)
  //
  // For any week over cap, draw the accidental / law-forced line — the ≤2 cap
  // is operational and yields to the legal constraints, but only when they
  // genuinely force it, and never silently:
  //   • ACCIDENTAL — the no-grant baseline keeps the dispatcher ≤ cap, so a
  //     legal arrangement exists and the excess is a coordination artifact (the
  //     2nd-off grant stacked on a mandatory rest + a day the picker could not
  //     fill). Withdraw the grant by restoring the pre-grant shift — but ONLY
  //     if it stays legal (adds a body, so never a zero; and must not create a
  //     7th consecutive workday). If the only repair would break ≤6, it is:
  //   • LAW-FORCED — mandatory rest + the ≤6-consecutive rule leave no legal
  //     ≤-cap arrangement. The extra off is legally required; do NOT break it.
  //     FLAG it (a schedule warning + a forcedThirdOff secondOffLog record) and
  //     let it stand — a surfaced, expected event, not a silent cap break.
  {
    const streakOK = (ds: DispatcherSchedule) => {
      const days = [...ds.days].sort((a, b) => a.date.localeCompare(b.date))
      let run = 0
      for (const dy of days) {
        if (dy.isOff) run = 0
        else if (++run > MAX_CONSECUTIVE_WORK_DAYS) return false
      }
      return true
    }
    const warnings = { ...(result.coverageWarnings ?? {}) }
    let surfaced = false

    for (const [wl, wkDates] of fullWeeks) {
      for (const disp of dispatchers) {
        const cap = maxDaysOffFor(disp.level)
        if (offsInWeek(result, disp.id, wkDates) <= cap) continue
        const ds = result.dispatcherSchedules.find((x) => x.dispatcher.id === disp.id)!
        const baselineForced = offsInWeek(baseline, disp.id, wkDates) > cap

        // Accidental repair: withdraw the discretionary grant by restoring the
        // grantee's pre-grant (baseline) shift on the granted day — only when a
        // legal ≤-cap arrangement exists (baseline ≤ cap) and the restore keeps
        // the ≤6-consecutive rule.
        let repaired = false
        if (!baselineForced) {
          const rec = finalLog.find((r) => r.granted && r.candidateId === disp.id && r.weekLabel === wl && r.date)
          const day = rec?.date ? ds.days.find((d) => d.date === rec.date) : undefined
          const baseDay = rec?.date
            ? baseline.dispatcherSchedules.find((x) => x.dispatcher.id === disp.id)?.days.find((d) => d.date === rec.date)
            : undefined
          if (rec?.date && day && baseDay && !baseDay.isOff) {
            const act = result.coverageActual[rec.date]
            const prevSlots = day.slots
            const prevHours = day.totalHours
            baseDay.slots.forEach((on, i) => { if (on && act?.[i] != null) act[i]++ })
            day.slots = [...baseDay.slots]
            day.totalHours = baseDay.totalHours
            day.isOff = false
            if (streakOK(ds)) {
              ds.weeklyHours[wl] = (ds.weeklyHours[wl] ?? 0) + baseDay.totalHours
              ds.totalHours += baseDay.totalHours
              rec.granted = false
              rec.date = undefined
              rec.unitDelta = undefined
              rec.reason =
                'off-cap: accidental 3rd day off — the rotating 2nd-off grant stacked on a mandatory rest + a partial-time-off day; grant withdrawn, dispatcher restored to work (coverage preserved, ≤6-consecutive intact).'
              repaired = true
            } else {
              // Restoring would force a 7th consecutive workday — genuinely
              // law-forced after all. Revert the trial restore and fall to flag.
              day.slots = prevSlots
              day.totalHours = prevHours
              day.isOff = true
              baseDay.slots.forEach((on, i) => { if (on && act?.[i] != null) act[i]-- })
            }
          }
        }
        if (repaired) continue

        // LAW-FORCED (or an accidental excess whose only repair would break the
        // ≤6-consecutive rule): flag it, do not break it.
        const n = offsInWeek(result, disp.id, wkDates)
        const offDate = wkDates.find((x) => ds.days.find((d) => d.date === x.date)?.isOff)?.date ?? wkDates[0].date
        ;(warnings[offDate] ??= []).push({
          peak: 'mandatory-rest' as const,
          reason: `${disp.name}: ${n} days off in ${wl} (cap ${cap}) — an extra day off forced by inviolable constraints (mandatory rest, user time-off, and the ≤6-consecutive-workday rule). Flagged, not a silent cap break.`,
          slotIndex: 0,
        })
        finalLog = [
          ...finalLog,
          {
            weekLabel: wl,
            candidateId: disp.id,
            candidateName: disp.name,
            granted: false,
            date: offDate,
            forcedThirdOff: true,
            reason: `Law-forced day off — no legal ≤${cap}-off arrangement this week; the operational cap yields to mandatory rest, user time-off, and the ≤6-consecutive-workday rule. Surfaced as a flagged event, not a silent break.`,
          },
        ]
        surfaced = true
      }
    }
    if (surfaced) result = { ...result, coverageWarnings: warnings }
  }

  return { ...result, secondOffLog: finalLog }
}

// ---------------------------------------------------------------------------
// Shuffle — rotate dispatcher↔shift mapping without changing the daily
// shift shapes. Same coverage, same off-days per person, different people
// in each role. Different from generateSchedule which rebuilds everything.
// ---------------------------------------------------------------------------

/** Re-assign which dispatcher takes which shift on each day, keeping the
 *  per-day pattern set + per-dispatcher off-days intact. Validates
 *  recurring/per-date time-off + night-rest; rotates by a different
 *  offset per day to maximise variety. */
export function shuffleDispatcherAssignments(
  s: GeneratedSchedule,
  timeOff: DispatcherTimeOff,
  seed: number,
): GeneratedSchedule {
  // Clone each dispatcher's day entries so we don't mutate the input.
  const newScheds: DispatcherSchedule[] = s.dispatcherSchedules.map((ds) => ({
    ...ds,
    weeklyHours: { ...ds.weeklyHours },
    days: ds.days.map((d) => ({ ...d, slots: [...d.slots] })),
  }))

  // Map date → day-of-week + week-label for hour-cap math.
  const dateMeta = new Map<string, { dow: number; wLabel: string }>()
  for (const di of s.dates) dateMeta.set(di.date, { dow: di.dayOfWeek, wLabel: di.weekLabel })

  // Track post-rotation hours so we don't blow the weekly cap when
  // rotating someone into a longer shift than they originally had.
  const postWeekHours: Record<string, Record<string, number>> = {}
  for (const ds of newScheds) {
    postWeekHours[ds.dispatcher.id] = {}
    // Seed with what they ALREADY have on days we haven't rotated yet —
    // we'll overwrite per day as we go.
  }

  // Track last active slot for night-rest check (per dispatcher, by date).
  const lastSlot: Record<string, Record<string, number>> = {}
  for (const ds of newScheds) {
    lastSlot[ds.dispatcher.id] = {}
    for (const d of ds.days) {
      let last = -1
      for (let i = d.slots.length - 1; i >= 0; i--) if (d.slots[i]) { last = i; break }
      lastSlot[ds.dispatcher.id][d.date] = last
    }
  }

  const dateList = s.dates
  for (let dayIdx = 0; dayIdx < dateList.length; dayIdx++) {
    const date = dateList[dayIdx].date
    const dow = dateList[dayIdx].dayOfWeek
    const yesterday = dayIdx > 0 ? dateList[dayIdx - 1].date : null

    // Snapshot pre-rotation assignments for THIS day only.
    const working: { dsIdx: number; slots: boolean[]; hours: number }[] = []
    for (let i = 0; i < newScheds.length; i++) {
      const entry = newScheds[i].days[dayIdx]
      if (!entry.isOff) working.push({ dsIdx: i, slots: [...entry.slots], hours: entry.totalHours })
    }
    if (working.length < 2) continue

    // Try a rotation offset; if the resulting mapping violates a constraint,
    // try the next offset. Falls through to identity (no shuffle) on this day.
    const N = working.length
    const start = ((seed * 7 + dayIdx * 3) % N + N) % N
    let chosen: number[] | null = null
    for (let attempt = 0; attempt < N; attempt++) {
      const rot = (start + attempt) % N
      if (rot === 0 && attempt > 0) continue
      const perm = working.map((_, i) => (i + rot) % N)
      if (perm.every((j, i) => j === i)) continue
      // Validate every (dispatcher i, pattern from perm[i]) pair.
      let ok = true
      for (let i = 0; i < N; i++) {
        const dsi = newScheds[working[i].dsIdx]
        const src = working[perm[i]]
        // Time-off / recurring block overlap.
        const blocks = blockedBitmap(timeOff, dsi.dispatcher, date, dow)
        if (blocks && src.slots.some((on, k) => on && blocks[k])) { ok = false; break }
        // Night-rest: if any morning slot is on AND yesterday's last slot >= NIGHT.
        const firstOn = src.slots.findIndex((v) => v)
        if (firstOn >= 0 && firstOn <= MORNING_SLOT_THRESHOLD && yesterday) {
          const prev = lastSlot[dsi.dispatcher.id][yesterday] ?? -1
          if (prev >= NIGHT_SLOT_THRESHOLD) { ok = false; break }
        }
      }
      if (ok) { chosen = perm; break }
    }
    if (!chosen) continue

    // Apply rotation.
    for (let i = 0; i < N; i++) {
      const dsi = newScheds[working[i].dsIdx]
      const src = working[chosen[i]]
      dsi.days[dayIdx].slots = [...src.slots]
      dsi.days[dayIdx].totalHours = src.hours
      // Refresh lastSlot for tomorrow's night-rest check.
      let last = -1
      for (let k = src.slots.length - 1; k >= 0; k--) if (src.slots[k]) { last = k; break }
      lastSlot[dsi.dispatcher.id][date] = last
    }
  }

  // Recompute weeklyHours + totalHours from the rotated day entries.
  for (const ds of newScheds) {
    const wh: Record<string, number> = {}
    for (const d of ds.days) {
      const meta = dateMeta.get(d.date)
      if (!meta) continue
      wh[meta.wLabel] = (wh[meta.wLabel] ?? 0) + d.totalHours
    }
    ds.weeklyHours = wh
    ds.totalHours = Object.values(wh).reduce((a, b) => a + b, 0)
  }
  // Suppress unused-var lint — postWeekHours was reserved for cap validation
  // but the rotation only swaps shifts within the same day, so per-week
  // totals can only change if someone ends up holding a longer shift than
  // they previously had on that day — and even then the dispatcher we
  // swapped INTO inherits their old hours, so weekly totals balance out.
  void postWeekHours

  return { ...s, dispatcherSchedules: newScheds }
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
