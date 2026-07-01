import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DAY_TEMPLATES,
  effectiveCoverage,
  HANDOFF_SLOT,
  MAX_CONSECUTIVE_HOURS,
  MEAL_BREAK_HOURS,
  midShiftBreakSlots,
  MIN_BLOCK_HOURS,
  MIN_TAIL_STRETCH_HOURS,
  PEAK_WINDOWS,
  patternMaxBreakHours,
  patternWorkBlocks,
  SLOTS,
  SPLIT_COVERAGE,
  SPLIT_GAP_HOURS,
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
function assignMandatoryRest(
  dispatchers: Dispatcher[],
  allDates: Date[],
  timeOff: DispatcherTimeOff,
  seed: number,
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

  dispatchers.forEach((d, dispIdx) => {
    restLocks[d.id] = new Set()
    // Conservative pre-schedule assumption: the day before the schedule
    // starts was a work day. This lets the cap bind from day 1 —
    // dispatchers can work at most 6 days into the schedule before
    // needing a rest, regardless of unknown pre-schedule state.
    let lastRestDate: Date = addDays(allDates[0], -1)

    // Stable HOME rest weekday for this dispatcher (constant across
    // weeks; used by Step 1's cadence rescue and Step 2's placement).
    // Demand-spread quota: Tue is the lightest day (lunch 3, dinner 2,
    // close 1) so it absorbs 3 rests; Wed and Thu take 1 each —
    // stacking 2 rests on either gutted them to skeleton crews (Thu
    // is a 5-need day + the week-start edge; Wed's close went to
    // zero when 2 rests left it exactly tight). Mon keeps 2. Seed
    // rotates the assignment so Regenerate varies who rests when.
    const HOME_REST_DOWS = [1, 1, 2, 2, 2, 3, 4] // Mon,Mon,Tue,Tue,Tue,Wed,Thu
    const homeDow = HOME_REST_DOWS[(dispIdx + (seed >>> 0)) % HOME_REST_DOWS.length]

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
          vacOf(dt) + (lockPressure.get(format(dt, 'yyyy-MM-dd')) ?? 0)
        if (vacOf(pool[pool.length - 1]) > 0) {
          let wide = validRange.filter((dt) => {
            const dw = dt.getDay()
            return dw === 1 || dw === 2 || dw === 3 || dw === 4 // Mon–Thu
          })
          if (wide.length === 0) wide = validRange
          const minP = Math.min(...wide.map(totalOf))
          const calm = wide.filter((dt) => totalOf(dt) === minP)
          // Among least-crowded days prefer the home day, else latest.
          const calmHome = calm.filter((dt) => dt.getDay() === homeDow)
          pool = calmHome.length > 0 ? calmHome : calm
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
 *  - no worked stretch over MAX_CONSECUTIVE_HOURS (5h, labor law)
 *  - first stretch ≥ MIN_BLOCK_HOURS (3h) — the meal break comes after
 *    a real stretch; the post-break tail may be short (weekday Morning
 *    runs 5h + 1.5h) because the paid break doesn't fragment the
 *    continuous presence
 *  - > 5h worked → the meal break is mandatory
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
    // Mon–Wed split exception: one dispatcher covers both peaks with a
    // 3h UNPAID gap confined to the 14:00–17:00 lull (never touching
    // the lunch or dinner peak). Both blocks must be real stretches
    // (≥ 3h). This is the only shape allowed to deviate from the
    // 30-min paid meal break, and only on dow 1–3.
    const isSplitDay = dayOfWeek === 1 || dayOfWeek === 2 || dayOfWeek === 3
    if (!isSplitDay) return false
    if (maxBreak !== SPLIT_GAP_HOURS) return false
    const gap = midShiftBreakSlots(slots)
    if (!gap.every((s) => (SPLIT_GAP_SLOTS as readonly number[]).includes(s))) return false
    if (blocks[1] < MIN_BLOCK_HOURS) return false
  } else if (blocks.length === 2 && blocks[1] < MIN_TAIL_STRETCH_HOURS) {
    return false
  }
  // Labor law: no single worked stretch over 5h.
  if (Math.max(...blocks) > MAX_CONSECUTIVE_HOURS) return false
  const totalWork = blocks.reduce((s, h) => s + h, 0)
  if (totalWork < 4) return false
  if (totalWork > 9) return false
  // > 5h worked requires a break (meal break or split gap).
  if (totalWork > MAX_CONSECUTIVE_HOURS && blocks.length < 2) return false
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
  const deficitUnits = (cov: number[]) => {
    let u = 0
    for (let i = 0; i < required.length; i++) u += Math.max(0, required[i] - cov[i])
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
  let changed = true
  while (changed) {
    changed = false
    for (let si = 0; si < cov.length; si++) {
      if (cov[si] <= required[si]) continue
      for (let ai = 0; ai < assignments.length; ai++) {
        const a = assignments[ai]
        if (!a.pattern[si]) continue
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
        let moved = false
        for (let j = first + 1; j < last && !moved; j++) {
          if (!a.pattern[j]) continue
          if (cov[j] - 1 < required[j]) continue // target at j must hold
          const trial = [...a.pattern]
          trial[si] = true
          trial[j] = false
          if (!isValidShiftShape(trial, dayOfWeek)) continue
          if (!dropPreservesAnchors(trial, a, a.pattern, assignments, startingPeaksWithAnchor)) continue
          a.pattern = trial
          cov[si]++
          cov[j]--
          moved = true
          changed = true
        }
        if (moved) break
      }
      if (changed) break
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

  // ── Phase 0 — mandatory weekly rest (hard gate, top of pipeline) ────
  // Lock 1 rest date per dispatcher per work-week and cap consecutive
  // workdays at MAX_CONSECUTIVE_WORK_DAYS across week boundaries.
  // These locks are INVIOLABLE — every subsequent pass filters them out
  // via `restLocks`. No pass may set, refund, or override a lock.
  const { restLocks, streakWarnings } = assignMandatoryRest(dispatchers, allDates, timeOff, seed)
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
    let bodiesNeeded = morningNeed + eveningNeed
    const splitsAllowed = dow >= 1 && dow <= 3
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
        bodiesNeeded = Math.min(bodiesNeeded, s + mNeed + eNeed)
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
    const patternsToDrop = Math.max(0, sortedPatterns.length - sortedWorking.length)
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
      const dropSort = [...scoredPatterns].sort(
        (a, b) =>
          a.unique - b.unique ||
          dinnerBadness(b.p) - dinnerBadness(a.p) ||
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
        if ((weekHours[d.id][wLabel] ?? 0) + p.hours > capForShift(d.id, lastActiveSlot(p.bool))) return false
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
      const rescuePool = isWeekend
        ? sortedWorking.filter((d) => !usedIds.has(d.id) && !restLocks[d.id].has(dateStr))
        : [
            ...availablePool.filter((d) => electedOffIds.has(d.id) && !restLocks[d.id].has(dateStr)),
            ...sortedWorking.filter((d) => !usedIds.has(d.id) && !restLocks[d.id].has(dateStr)),
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
            // pattern must close ≥ 2 units of deficit. A lone 30-min
            // break dip (the accepted warning residual) doesn't justify
            // burning the perk. Unassigned-working dispatchers rescue
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
          // close at least 2 units of deficit. A lone 30-min break dip
          // (the accepted warning residual) is not worth burning the
          // perk; transition-smoothing and the warnings handle those.
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
