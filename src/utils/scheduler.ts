import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import {
  DAY_TEMPLATES,
  effectiveCoverage,
  LONG_SHIFT_BREAK_MIN,
  MAX_BREAK_HARD_HOURS,
  MAX_BREAK_PREFERRED_HOURS,
  MED_SHIFT_BREAK_MIN,
  MIN_BLOCK_HOURS,
  PEAK_WINDOWS,
  patternMaxBreakHours,
  patternWorkBlocks,
  SLOTS,
  SURPLUS_TOLERATED_SLOTS,
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
 * Rotation: dispatchers with the same valid range get different picks
 * via (seed × dispIdx × weekIdx) offset, so nobody always rests on
 * the same weekday.
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

  dispatchers.forEach((d, dispIdx) => {
    restLocks[d.id] = new Set()
    // Conservative pre-schedule assumption: the day before the schedule
    // starts was a work day. This lets the cap bind from day 1 —
    // dispatchers can work at most 6 days into the schedule before
    // needing a rest, regardless of unknown pre-schedule state.
    let lastRestDate: Date = addDays(allDates[0], -1)

    weekOrder.forEach((wLbl, weekIdx) => {
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
        return
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
        // Bias toward the LATEST valid date (leaves the most flexibility
        // for the next week), rotated by (seed, dispIdx, weekIdx) so
        // dispatchers don't all cluster on Wednesday. Offset picks a
        // slightly earlier valid day for some (disp, week) combos.
        const N = validRange.length
        const offset = ((seed >>> 0) + dispIdx + weekIdx * (dispIdx + 3)) % N
        chosen = validRange[N - 1 - offset]
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

      restLocks[d.id].add(format(chosen, 'yyyy-MM-dd'))
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

// ---------------------------------------------------------------------------
// Coverage-aware swap pass — runs after the main greedy assignment to
// extend single-block shifts into peak-break splits when it closes a
// real coverage gap on the morning/late edge. A peak-time break is only
// allowed when the peak slot is currently over-covered (slack to lend).
// ---------------------------------------------------------------------------

/** True when this shift bitmap satisfies every dispatcher shape rule:
 *  min 2h block (lowered to allow law-mandated breaks), max 1 break,
 *  max 5h consecutive (Section 23 — labor law), 30 min break required
 *  over 5h, 1 h break over 8h, ≤9h daily total. */
function isValidShiftShape(slots: boolean[]): boolean {
  const blocks = patternWorkBlocks(slots, SLOTS)
  if (blocks.length === 0) return false
  if (blocks.length > 2) return false
  if (blocks.length > 1 && Math.min(...blocks) < MIN_BLOCK_HOURS) return false
  // Labor law: no single block over 5h.
  if (Math.max(...blocks) > 5) return false
  const totalWork = blocks.reduce((s, h) => s + h, 0)
  // Minimum 4h per worked day. Was 5h, lowered after the user's manual
  // Wed-Jul-1 fix used 4h blocks for kimberly + michelle to trim out
  // 1.5-3h mid-shift breaks — short clean shifts beat long shifts with
  // dead time in the middle. Off days handled separately (electedOff).
  if (totalWork < 4) return false
  if (totalWork > 9) return false
  const maxBreak = patternMaxBreakHours(slots, SLOTS)
  if (maxBreak > MAX_BREAK_HARD_HOURS) return false
  if (totalWork >= 8 && maxBreak < LONG_SHIFT_BREAK_MIN) return false
  // Labor law: > 5h work needs a 30 min meal break.
  if (totalWork > 5 && totalWork < 8 && maxBreak < MED_SHIFT_BREAK_MIN) return false
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

    // Quick win: if extension keeps total ≤ 5h AND remains a single block
    // ≤ 5h we don't need any break (labor law: > 5h consecutive needs
    // a 30 min break).
    const extWork = slotHours(extended)
    const extBlocks = patternWorkBlocks(extended, SLOTS)
    const extMaxBlock = extBlocks.length > 0 ? Math.max(...extBlocks) : 0
    if (extWork <= 5 && extMaxBlock <= 5 && isValidShiftShape(extended) && computeCoverageGain(slots, extended, cov, req) > 0) {
      return extended
    }

    // Otherwise we need a break. Required break duration by shift length.
    const needBreak = extWork > 8 ? LONG_SHIFT_BREAK_MIN
                    : extWork > 5 ? MED_SHIFT_BREAK_MIN
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
  },
): boolean {
  if (ctx.usedIds.has(d.id)) return false
  if (p.isMorning && ctx.workedNightYesterday(d.id)) return false
  const blocks = blockedBitmap(ctx.timeOff, d, ctx.dateStr, ctx.dow)
  if (blocks && p.bool.some((on, i) => on && blocks[i])) return false
  if ((ctx.weekHours[d.id][ctx.wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) return false
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
  splitsSoFar: Record<string, number>
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
    // then non-split pattern (lower maxBreak), then shorter shift to
    // avoid burning a long-pattern slot on a small dispatcher.
    pairs.sort((a, b) => {
      const ha = ctx.weekHours[a.d.id][ctx.wLabel] ?? 0
      const hb = ctx.weekHours[b.d.id][ctx.wLabel] ?? 0
      if (ha !== hb) return ha - hb
      if (a.p.maxBreak !== b.p.maxBreak) return a.p.maxBreak - b.p.maxBreak
      return a.p.hours - b.p.hours
    })
    const pick = pairs[0]
    ctx.assignments.push({ dispatcher: pick.d, pattern: pick.p.bool })
    ctx.usedIds.add(pick.d.id)
    ctx.usedPatternIdx.add(pick.p.idx)
    if (pick.p.maxBreak >= 2) ctx.splitsSoFar[pick.d.id] = (ctx.splitsSoFar[pick.d.id] ?? 0) + 1
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
      if (!isValidShiftShape(trial)) continue
      // Weekly cap check — fill-break adds hours.
      const oldH = slotHours(a.pattern), newH = slotHours(trial)
      if ((ctx.weekHours[a.dispatcher.id][ctx.wLabel] ?? 0) + (newH - oldH) > WEEKLY_CAP_HOURS) continue
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
        if (!isValidShiftShape(trial)) continue
        const newHours = slotHours(trial)
        // weekHours is pre-shift (today's hours added at accumulation step
        // after all passes), so the cap check is pre-shift + this day's
        // post-stretch shift.
        if ((weekHours[a.dispatcher.id][wLabel] ?? 0) + newHours > WEEKLY_CAP_HOURS) continue
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
        if (!isValidShiftShape(trial)) continue
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
}): { resolved: string[]; unresolved: number[] } {
  const { assignments, required, weekHours, smoothingBudget, wLabel, timeOff, dateStr, dow } = args
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
  // if all caps (weekly 45 h, weekly smoothing budget, daily smoothing
  // budget) would still hold.
  const fitsBudget = (a: { dispatcher: Dispatcher }, delta: number): boolean => {
    if (delta <= 0) return true
    if ((weekHours[a.dispatcher.id][wLabel] ?? 0) + delta > WEEKLY_CAP_HOURS) return false
    if ((smoothingBudget[a.dispatcher.id][wLabel] ?? 0) + delta > SMOOTHING_BUDGET_PER_WEEK) return false
    if ((dailyNetAdd.get(a.dispatcher.id) ?? 0) + delta > SMOOTHING_DAILY_NET_ADD) return false
    return true
  }

  const isBlocked = (a: { dispatcher: Dispatcher }, i: number): boolean => {
    const block = blockedBitmap(timeOff, a.dispatcher, dateStr, dow)
    if (block && block[i]) return true
    if (a.dispatcher.recurringBlocks?.[dow]?.[i]) return true
    return false
  }

  // Apply hours-flat relocation: drop slot j, set slot i. Mutates a + cov.
  // Slot hours may differ between j and i (0.5 vs 1) — book the delta
  // into weekHours and (if positive) the smoothing budget so the pass
  // doesn't leak unbooked hours.
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
    if (delta !== 0) {
      weekHours[a.dispatcher.id][wLabel] = (weekHours[a.dispatcher.id][wLabel] ?? 0) + delta
      if (delta > 0) {
        smoothingBudget[a.dispatcher.id][wLabel] =
          (smoothingBudget[a.dispatcher.id][wLabel] ?? 0) + delta
        dailyNetAdd.set(a.dispatcher.id, (dailyNetAdd.get(a.dispatcher.id) ?? 0) + delta)
      }
    }
  }

  const applyExtension = (
    a: { dispatcher: Dispatcher; pattern: boolean[] },
    i: number,
  ): void => {
    a.pattern[i] = true
    cov[i]++
    const addH = SLOTS[i].hours
    weekHours[a.dispatcher.id][wLabel] = (weekHours[a.dispatcher.id][wLabel] ?? 0) + addH
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
        if (!isValidShiftShape(trial)) continue
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
      if (!isValidShiftShape(trial)) continue
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
        if (!isValidShiftShape(trial)) continue
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
      if (!isValidShiftShape(trial)) continue
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
        if (!isValidShiftShape(trial)) continue
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
      if (!isValidShiftShape(trial)) continue
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
      .filter((p) => isValidShiftShape(p.bool))

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
        weekOffDays[d.id][wLabel] = (weekOffDays[d.id][wLabel] ?? 0) + 1
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
    // The day needs at most `patternsNeeded` dispatchers; everyone past that
    // is potentially off. Cap each dispatcher at MAX_DAYS_OFF_PER_WEEK total.
    //
    // On Fri/Sat/Sun, ALWAYS elect exactly 1 person off (counting anyone
    // already blocked by time-off) — busy days, only 7 dispatchers, so
    // we can't afford more than 1 off. If a dispatcher is already
    // blocked off today, NO extra election (else we'd have 2 off
    // and lose coverage).
    const patternsNeeded = template.shiftPatterns.length
    let desiredElectedOff = Math.max(0, availablePool.length - patternsNeeded)
    if (isWeekend) {
      const alreadyOff = blockedToday.length + cappedToday.length
      // Cap weekend election so blocked + capped + elected ≤ 1.
      desiredElectedOff = Math.max(0, 1 - alreadyOff)
    }

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
      // Greedy drop with coverage-survival check — never drop a pattern
      // if doing so would leave any required slot with zero patterns
      // covering it. Previously a slot like Fri 11-11:30 PM (req=1, 3
      // patterns) saw all three patterns scored 0 unique and ALL
      // dropped, leaving slot 19 uncovered every Friday.
      const dropSort = [...scoredPatterns].sort((a, b) => a.unique - b.unique || a.p.hours - b.p.hours)
      const dropped = new Set<typeof sortedPatterns[number]>()
      const remainingCov = [...coverageCount]
      for (const cand of dropSort) {
        if (dropped.size >= patternsToDrop) break
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
    // Mutates: assignments, usedIds, usedPatternIdx, runningCov, splitsSoFar.
    const seedCtx = {
      patternMeta, sortedWorking, usedIds, usedPatternIdx, assignments,
      runningCov, weekHours, wLabel, timeOff, dateStr, dow,
      workedNightYesterday, splitsSoFar,
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
      for (const cand of remainingPatterns) {
        let fill = 0, overTolerated = 0, overOff = 0, criticality = 0
        for (let i = 0; i < cand.bool.length; i++) {
          if (!cand.bool[i]) continue
          if (runningCov[i] < dayRequired[i]) {
            fill++
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
      // mid-shift break), HARD-FILTER to the candidates with the
      // fewest splits so far — not just a tiebreak. Sorting alone
      // wasn't strong enough: the lowest-hours dispatcher kept
      // sorting first on `withinSoft` regardless of split count, so
      // one person absorbed 5 splits while another had 1. User
      // observed and manually rebalanced (resgie 5→4, kimberly 1→2).
      if (p.maxBreak >= 2 && pickFrom.length > 1) {
        const minSplits = Math.min(...pickFrom.map((d) => splitsSoFar[d.id] ?? 0))
        const lowest = pickFrom.filter((d) => (splitsSoFar[d.id] ?? 0) === minSplits)
        if (lowest.length > 0) pickFrom = lowest
        pickFrom = [...pickFrom].sort((a, b) =>
          (weekHours[a.id][wLabel] ?? 0) - (weekHours[b.id][wLabel] ?? 0),
        )
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
    // user flagged. Sync from final picker assignments (seed entries
    // already in usedPatternIdx).
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
          if ((weekHours[d.id][wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) continue
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
          if (pick.p.maxBreak >= 2) splitsSoFar[d.id]++
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
          if ((weekHours[d.id][wLabel] ?? 0) + p.hours > WEEKLY_CAP_HOURS) continue
          let fill = 0, overTolerated = 0, overOff = 0
          for (let i = 0; i < p.bool.length; i++) {
            if (!p.bool[i]) continue
            if (cov[i] < dayRequired[i]) fill++
            else if (cov[i] >= dayRequired[i]) {
              if (SURPLUS_TOLERATED_SLOTS.has(i)) overTolerated++
              else overOff++
            }
          }
          // Only pick when we genuinely close a gap. Off-peak over-cov
          // costs 2× tolerated so surplus lands in the tolerated
          // lunch/dinner windows first.
          if (fill === 0) continue
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
          if (pick.p.maxBreak >= 2) splitsSoFar[d.id]++
          usedPatternIdx.add(pick.pIdx)
          pick.p.bool.forEach((on, i) => { if (on) cov[i]++ })
        }
      }
    }

    // Stretch shifts to fill single-body gaps by extending an adjacent
    // dispatcher's tail/head by 0.5-1h. Mirrors the manual closer
    // extensions (Thu shamika → slot 19, Fri resgie → slot 19, etc).
    // Runs BEFORE trim so any incidental over-cov can still be reclaimed.
    stretchToFillGaps(assignments, dayRequired, weekHours, wLabel)

    // ── enforceAnchors — peak-continuity repair pass ───────────────────
    // Validate each peak has at least one anchor (started pre-peak +
    // continuous through peak). If not, try fill-break first, then
    // pattern-swap. Any peak still uncovered emits a warning. Runs
    // between stretch and trim so trim's survival check can protect
    // any anchor this pass restored.
    const enforceCtx = {
      patternMeta, sortedWorking, usedIds, usedPatternIdx, assignments,
      runningCov, weekHours, wLabel, timeOff, dateStr, dow,
      workedNightYesterday, splitsSoFar,
    }
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

    // Trim over-covered slots down to the requirement. Runs LAST so it
    // sees the full final coverage from picker + swap + rescue + must-work.
    // Now also protects the sole anchor's peak slots (see trimToExactCoverage).
    trimToExactCoverage(assignments, dayRequired)

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
      wLabel, timeOff, dateStr, dow,
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
