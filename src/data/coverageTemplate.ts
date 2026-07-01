/**
 * Coverage template — 20 time slots per day.
 *
 * Mon–Fri: 9 AM – 11:30 PM  (slot 0 = 8–9 AM, coverage = 0 → hidden in UI)
 * Sat–Sun: 8 AM – 11:30 PM  (slot 0 = 8–9 AM, coverage > 0)
 *
 * TWO-TEAM MODEL. Every day is staffed by exactly two teams — no split
 * shifts, no long midday gaps:
 *
 *   Morning  (weekday 9:00–16:00 / weekend 8:00–16:00)
 *   Evening  (15:00–23:30, to close)
 *
 * Each dispatcher works one continuous presence with exactly ONE 30-min
 * paid meal break (MEAL_BREAK_HOURS). The break is paid time but NOT
 * coverage — the dispatcher is off the floor for that slot. Break
 * placement is dictated by the labor-law 5h-consecutive cap and the
 * slot grid:
 *
 *   WD Morning  9:00–14:00 + brk 2:00–2:30 PM + 14:30–16:00  (6.5h worked)
 *   WE Morning  8:00–11:00 + brk 11:00–11:30 + 11:30–16:00   (7.5h worked)
 *   Evening A   15:00–20:00 + brk 8:00–8:30 PM + 20:30–23:30 (8h worked)
 *   Evening B   15:00–18:00 + brk 6:00–6:30 PM + 18:30–23:30 (8h worked)
 *
 * Evening A/B stagger the meal break so the floor never fully empties in
 * the evening; the whole Morning team shares the 2:00–2:30 PM break by
 * construction (no legal alternative position on the grid) — the 2–2:30
 * dip surfaces as a coverage warning, intentionally kept as a signal.
 *
 * The two teams overlap 15:00–16:00 for the daily handoff (driver
 * situation, open orders, restaurants). The scheduler validates the
 * overlap and warns if a day would leave the Evening team starting cold.
 *
 * Shape rules (enforced by the build-time assertion below AND at runtime
 * via isValidShiftShape):
 *   ≤ 1 break per day, exactly MEAL_BREAK_HOURS (30 min) when present
 *   No worked stretch over MAX_CONSECUTIVE_HOURS (5 h) — labor law
 *   First stretch ≥ MIN_BLOCK_HOURS (3 h); the post-break tail may be
 *     shorter (e.g. weekday Morning's 1.5h tail) because the paid meal
 *     break does not fragment the continuous presence
 *   > 5 h worked → the meal break is mandatory
 *   Mon–Fri: at least one stretch ≥ WEEKDAY_PRIMARY_STRETCH_HOURS (5 h)
 *   Max work per day = 9 h
 *
 * Slot index reference:
 *  0: 8–9 AM   1: 9–10 AM   2: 10–11 AM
 *  3: 11–11:30  4: 11:30–12  5: 12–1 PM
 *  6: 1–2 PM   7: 2–2:30    8: 2:30–3
 *  9: 3–4 PM  10: 4–5 PM   11: 5–6 PM
 * 12: 6–6:30  13: 6:30–7   14: 7–8 PM
 * 15: 8–8:30  16: 8:30–9   17: 9–10 PM
 * 18: 10–11 PM   19: 11–11:30 PM
 */
import type { DayTemplate } from '@/types/schedule'

export const SLOTS = [
  { label: '8–9 AM',        hours: 1   },  // 0
  { label: '9–10 AM',       hours: 1   },  // 1
  { label: '10–11 AM',      hours: 1   },  // 2
  { label: '11–11:30 AM',   hours: 0.5 },  // 3
  { label: '11:30–12 PM',   hours: 0.5 },  // 4
  { label: '12–1 PM',       hours: 1   },  // 5
  { label: '1–2 PM',        hours: 1   },  // 6
  { label: '2–2:30 PM',     hours: 0.5 },  // 7
  { label: '2:30–3 PM',     hours: 0.5 },  // 8
  { label: '3–4 PM',        hours: 1   },  // 9
  { label: '4–5 PM',        hours: 1   },  // 10
  { label: '5–6 PM',        hours: 1   },  // 11
  { label: '6–6:30 PM',     hours: 0.5 },  // 12
  { label: '6:30–7 PM',     hours: 0.5 },  // 13
  { label: '7–8 PM',        hours: 1   },  // 14
  { label: '8–8:30 PM',     hours: 0.5 },  // 15
  { label: '8:30–9 PM',     hours: 0.5 },  // 16
  { label: '9–10 PM',       hours: 1   },  // 17
  { label: '10–11 PM',      hours: 1   },  // 18
  { label: '11–11:30 PM',   hours: 0.5 },  // 19
]

// ───────────────────────────────────────────────────────────────────────────
// The two-team shift catalog. Duplicate copies of each shape give the
// picker per-day team capacity — each copy is assignable to one
// dispatcher (usedPatternIdx is per-copy). 4 Morning + 3 Evening A +
// 3 Evening B covers the largest team any day needs (4); the
// over-coverage cap self-limits how many copies actually get picked on
// low-requirement days.
// ───────────────────────────────────────────────────────────────────────────

// Weekday Morning (9:00–16:00, meal break 2:00–2:30 PM; stretches 5h + 1.5h,
// 6.5h worked). Lunch anchor: continuous through 11:30–2 PM, starts 9 AM.
const WD_MORNING  = [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Weekend Morning (8:00–16:00, meal break 11:00–11:30 AM; stretches 3h + 4.5h,
// 7.5h worked). Lunch anchor: break ends before the 11:30 peak start.
const WE_MORNING  = [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Evening A (15:00–23:30, meal break 8:00–8:30 PM; stretches 5h + 3h, 8h
// worked). Dinner anchor: continuous through 5–8 PM, starts 3 PM.
const EVENING_A   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1]
// Evening B (15:00–23:30, meal break 6:00–6:30 PM; stretches 3h + 5h, 8h
// worked). Not an anchor (break inside dinner peak) — covers 8–8:30 PM
// while Evening A is on its meal break.
const EVENING_B   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1]

const WEEKDAY_PATTERNS = [
  WD_MORNING, WD_MORNING, WD_MORNING, WD_MORNING,
  EVENING_A, EVENING_A, EVENING_A,
  EVENING_B, EVENING_B, EVENING_B,
]
const WEEKEND_PATTERNS = [
  WE_MORNING, WE_MORNING, WE_MORNING, WE_MORNING,
  EVENING_A, EVENING_A, EVENING_A,
  EVENING_B, EVENING_B, EVENING_B,
]

// Coverage targets are UNCHANGED from the pre-two-team template — where
// the fixed team model can't meet them (Sat needs 4+4 bodies, the shared
// Morning meal break at 2–2:30 PM, the staggered Evening breaks at
// 6–6:30 / 8–8:30 PM) the shortfall surfaces as daily warnings. That is
// deliberate: the warnings are the headcount signal.

// ─── THURSDAY (dayOfWeek=4) ─────────────────────────────────────────────────
const THU: DayTemplate = {
  dayOfWeek: 4, dayName: 'Thursday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 1, 2, 2, 2, 1, 2, 2, 3, 3, 2, 2, 3, 3, 2, 3, 1, 1],
  shiftPatterns: WEEKDAY_PATTERNS,
}

// ─── FRIDAY (dayOfWeek=5) ───────────────────────────────────────────────────
const FRI: DayTemplate = {
  dayOfWeek: 5, dayName: 'Friday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 2, 2, 2, 2, 3, 4, 3, 3, 4, 3, 2, 3, 3, 1],
  shiftPatterns: WEEKDAY_PATTERNS,
}

// ─── SATURDAY (dayOfWeek=6) ─────────────────────────────────────────────────
const SAT: DayTemplate = {
  dayOfWeek: 6, dayName: 'Saturday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    2, 2, 2, 2, 4, 4, 4, 2, 2, 1, 1, 4, 4, 4, 4, 3, 3, 2, 1, 1],
  shiftPatterns: WEEKEND_PATTERNS,
}

// ─── SUNDAY (dayOfWeek=0) ───────────────────────────────────────────────────
const SUN: DayTemplate = {
  dayOfWeek: 0, dayName: 'Sunday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    2, 2, 2, 2, 3, 3, 3, 2, 2, 1, 3, 4, 4, 4, 4, 3, 2, 3, 3, 1],
  shiftPatterns: WEEKEND_PATTERNS,
}

// ─── MONDAY (dayOfWeek=1) ───────────────────────────────────────────────────
const MON: DayTemplate = {
  dayOfWeek: 1, dayName: 'Monday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 1, 1, 2, 2, 2, 2, 1, 2, 1, 2, 2, 3, 3, 3, 3, 1, 2, 2, 1],
  shiftPatterns: WEEKDAY_PATTERNS,
}

// ─── TUESDAY (dayOfWeek=2) ──────────────────────────────────────────────────
const TUE: DayTemplate = {
  dayOfWeek: 2, dayName: 'Tuesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 3, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1],
  shiftPatterns: WEEKDAY_PATTERNS,
}

// ─── WEDNESDAY (dayOfWeek=3) ────────────────────────────────────────────────
const WED: DayTemplate = {
  dayOfWeek: 3, dayName: 'Wednesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 3, 3, 3, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 2, 1],
  shiftPatterns: WEEKDAY_PATTERNS,
}

/** Map from JS getDay() → DayTemplate */
export const DAY_TEMPLATES: Record<number, DayTemplate> = {
  0: SUN,
  1: MON,
  2: TUE,
  3: WED,
  4: THU,
  5: FRI,
  6: SAT,
}

/** Coverage targets for a given day-of-week, with per-day per-slot overrides
 *  applied on top of the day template's baseline. Missing entries fall
 *  through to the baseline. */
export function effectiveCoverage(
  dayOfWeek: number,
  coverageOverrides: Record<number, number[]> = {},
): number[] {
  const base = DAY_TEMPLATES[dayOfWeek]?.requiredCoverage ?? []
  const ov = coverageOverrides[dayOfWeek]
  if (!ov) return base
  return base.map((v, i) => (ov[i] !== undefined ? ov[i] : v))
}

// ───────────────────────────────────────────────────────────────────────────
// Shift-shape rules
// ───────────────────────────────────────────────────────────────────────────

/** The one break a dispatcher gets per day: 30 minutes, paid, off the
 *  floor (not coverage). It's the labor-law meal break, mandatory once
 *  the day exceeds 5h of work. Exactly one slot on the grid. */
export const MEAL_BREAK_HOURS = 0.5

/** Minimum length of the FIRST worked stretch — the meal break comes
 *  after a real stretch of work, never after a token hour. The
 *  post-break tail may be shorter (weekday Morning runs 5h + 1.5h)
 *  because the paid meal break doesn't fragment the continuous
 *  presence; the shift is one 9-to-4 block with a lunch pause, not a
 *  split shift. */
export const MIN_BLOCK_HOURS = 3

/** Minimum length of the post-break tail. Matches the weekday Morning's
 *  1.5h tail (14:30–16:00) — the shortest legal tail in the catalog.
 *  Stops the trim/smoothing passes from whittling a tail down to a
 *  useless 30-min stub. */
export const MIN_TAIL_STRETCH_HOURS = 1.5

/** The evening-ramp window (3–5 PM, slots 9–10). The whole Evening team
 *  is on the floor from 15:00 by design — first for the 15:00–16:00
 *  handoff overlap with the Morning team, then ramping toward dinner —
 *  even though the coverage requirement in this window is low (often 1).
 *  Over-coverage here is INTENTIONAL: the over-coverage caps skip these
 *  slots and the trim pass never shaves them, otherwise the optimizer
 *  dismantles the handoff to satisfy a 3 PM req of 1. */
export const EVENING_RAMP_SLOTS = new Set<number>([9, 10])

/** Weekday-only requirement: every Mon–Fri shift must contain at least
 *  one worked stretch of this length. Both weekday team shapes satisfy
 *  it (Morning 5h + 1.5h, Evening 5h + 3h / 3h + 5h). Weekends are
 *  exempt so the 8 AM opener can split 3h + 4.5h around a late-morning
 *  break. Enforced in isValidShiftShape via the caller-supplied
 *  `dayOfWeek` argument. */
export const WEEKDAY_PRIMARY_STRETCH_HOURS = 5

/** Labor-law max consecutive work hours. Any single worked stretch over
 *  this triggers the mandatory 30-min meal break WITHIN the stretch —
 *  i.e. a pattern can't have a stretch above this length, even if its
 *  total work hours are small. */
export const MAX_CONSECUTIVE_HOURS = 5

/** Slot indices that fall within peak hours — lunch (12–2 PM) and dinner
 *  (5–8 PM). Used by the build-time pattern assertion; the live
 *  scheduler governs peaks via the continuity-anchor rule below. */
export const PEAK_SLOT_INDICES = [5, 6, 11, 12, 13, 14]

/** Continuity-anchor peak windows. For each peak, at least one
 *  dispatcher on duty must have STARTED before the peak began AND
 *  remain continuously on duty through every slot in the window — no
 *  break and no shift end inside the peak. Under the two-team model
 *  each team owns its peak: Morning anchors lunch, Evening A anchors
 *  dinner. The validation stays in place as a safety net.
 *
 *  Lunch  = 11:30 AM – 2:00 PM → slots 4, 5, 6
 *  Dinner = 5:00 PM – 8:00 PM  → slots 11, 12, 13, 14
 */
export const LUNCH_PEAK_SLOTS = [4, 5, 6] as const
export const DINNER_PEAK_SLOTS = [11, 12, 13, 14] as const
export const PEAK_WINDOWS = [
  { key: 'lunch' as const, label: 'Lunch (11:30–2 PM)', slots: LUNCH_PEAK_SLOTS },
  { key: 'dinner' as const, label: 'Dinner (5–8 PM)',   slots: DINNER_PEAK_SLOTS },
]
export type PeakKey = (typeof PEAK_WINDOWS)[number]['key']

/** The daily handoff window — the Morning team must still be on the
 *  floor when the Evening team arrives so context (driver situation,
 *  open orders, restaurants) transfers warm. Evening starts 15:00
 *  (slot 9); Morning runs to 16:00, so the structural overlap is
 *  15:00–16:00. The scheduler warns when a day would leave the Evening
 *  team starting cold (no morning shift covering slot 9). */
export const HANDOFF_SLOT = 9

/** Windows where over-coverage is tolerated — surplus hours (e.g. from a
 *  trainee's forced 6th workday) can sit here without pushing the picker
 *  toward off-peak over-cov. Deliberately DIFFERENT from the anchor peak
 *  windows above:
 *    Lunch  anchor        = 11:30 AM – 2:00 PM  → slots 4, 5, 6
 *    Lunch  surplus-OK    = 11:00 AM – 1:00 PM  → slots 3, 4, 5
 *    Dinner anchor        = 5:00 PM  – 8:00 PM  → slots 11, 12, 13, 14
 *    Dinner surplus-OK    = 5:00 PM  – 8:00 PM  → slots 11, 12, 13, 14 (same as anchor)
 *
 *  Lunch windows do NOT coincide — surplus-tolerated lunch starts 30 min
 *  earlier and ends 1 h earlier than the anchor lunch. Do not merge or
 *  reuse the anchor sets for surplus-tolerance checks. Consumers pick
 *  the one whose semantic matches their pass (continuity check → anchor
 *  sets; over-cov scoring → surplus sets). */
export const SURPLUS_TOLERATED_LUNCH_SLOTS  = [3, 4, 5] as const
export const SURPLUS_TOLERATED_DINNER_SLOTS = [11, 12, 13, 14] as const
export const SURPLUS_TOLERATED_SLOTS = new Set<number>([
  ...SURPLUS_TOLERATED_LUNCH_SLOTS,
  ...SURPLUS_TOLERATED_DINNER_SLOTS,
])

/** Returns the largest mid-shift break (in hours) inside a pattern.
 *  Leading and trailing off-slots don't count — only gaps between work blocks. */
export function patternMaxBreakHours(
  pattern: number[] | boolean[],
  slots: { hours: number }[] = SLOTS,
): number {
  let maxBreak = 0
  let breakSoFar = 0
  let seenWork = false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]) {
      if (seenWork && breakSoFar > maxBreak) maxBreak = breakSoFar
      breakSoFar = 0
      seenWork = true
    } else if (seenWork) {
      breakSoFar += slots[i].hours
    }
  }
  return maxBreak
}

/** Returns the list of work-block durations (in hours) inside a pattern. */
export function patternWorkBlocks(
  pattern: number[] | boolean[],
  slots: { hours: number }[] = SLOTS,
): number[] {
  const blocks: number[] = []
  let cur = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]) cur += slots[i].hours
    else if (cur > 0) { blocks.push(cur); cur = 0 }
  }
  if (cur > 0) blocks.push(cur)
  return blocks
}

function totalWorkHours(pattern: number[] | boolean[], slots: { hours: number }[] = SLOTS): number {
  let h = 0
  for (let i = 0; i < pattern.length; i++) if (pattern[i]) h += slots[i].hours
  return h
}

/** Returns the SUM of all mid-shift break hours in a pattern (not just the
 *  longest, like patternMaxBreakHours). Leading and trailing off-slots are
 *  excluded — only gaps between the first and last worked slot count. */
export function patternTotalBreakHours(
  pattern: number[] | boolean[],
  slots: { hours: number }[] = SLOTS,
): number {
  let firstOn = -1, lastOn = -1
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]) { if (firstOn < 0) firstOn = i; lastOn = i }
  }
  if (firstOn < 0) return 0
  let total = 0
  for (let i = firstOn + 1; i < lastOn; i++) if (!pattern[i]) total += slots[i].hours
  return total
}

/** Returns the slot indices that fall inside any mid-shift break (off-slots
 *  between work blocks). Leading and trailing off-slots are excluded. */
export function midShiftBreakSlots(pattern: number[] | boolean[]): number[] {
  let firstOn = -1, lastOn = -1
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]) { if (firstOn < 0) firstOn = i; lastOn = i }
  }
  if (firstOn < 0) return []
  const out: number[] = []
  for (let i = firstOn + 1; i < lastOn; i++) if (!pattern[i]) out.push(i)
  return out
}

// Build-time assertion: with the small fixed two-team catalog, every
// pattern MUST satisfy the shape rules — a violation is a typo in this
// file, so fail the import loudly.
;(() => {
  const violations: string[] = []
  for (const day of Object.values(DAY_TEMPLATES)) {
    const isWeekend = day.dayOfWeek === 0 || day.dayOfWeek === 6
    day.shiftPatterns.forEach((pat, idx) => {
      const blocks = patternWorkBlocks(pat, day.slots)
      const brk = patternMaxBreakHours(pat, day.slots)
      const work = totalWorkHours(pat, day.slots)
      if (blocks.length === 0 || blocks.length > 2) {
        violations.push(`${day.dayName} #${idx}: ${blocks.length} stretches (need 1 or 2)`)
        return
      }
      if (blocks.length === 2 && brk !== MEAL_BREAK_HOURS) {
        violations.push(`${day.dayName} #${idx}: break ${brk}h ≠ the ${MEAL_BREAK_HOURS}h paid meal break`)
      }
      if (Math.max(...blocks) > MAX_CONSECUTIVE_HOURS) {
        violations.push(`${day.dayName} #${idx}: ${Math.max(...blocks)}h stretch > ${MAX_CONSECUTIVE_HOURS}h legal max`)
      }
      if (blocks[0] < MIN_BLOCK_HOURS) {
        violations.push(`${day.dayName} #${idx}: first stretch ${blocks[0]}h < ${MIN_BLOCK_HOURS}h`)
      }
      if (blocks.length === 2 && blocks[1] < MIN_TAIL_STRETCH_HOURS) {
        violations.push(`${day.dayName} #${idx}: tail ${blocks[1]}h < ${MIN_TAIL_STRETCH_HOURS}h`)
      }
      if (work > MAX_CONSECUTIVE_HOURS && blocks.length < 2) {
        violations.push(`${day.dayName} #${idx}: ${work}h worked with no meal break`)
      }
      if (work > 9) {
        violations.push(`${day.dayName} #${idx}: ${work}h > 9h daily max`)
      }
      if (!isWeekend && Math.max(...blocks) < WEEKDAY_PRIMARY_STRETCH_HOURS) {
        violations.push(`${day.dayName} #${idx}: no ${WEEKDAY_PRIMARY_STRETCH_HOURS}h primary stretch (weekday)`)
      }
    })
  }
  if (violations.length > 0) {
    throw new Error(`Dispatcher pattern shape violations:\n  ${violations.join('\n  ')}`)
  }
})()
