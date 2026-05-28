/**
 * Driver coverage template — 15 one-hour slots per day, 8 AM – 11 PM.
 *
 * Operation hours match dispatchers:
 *   Mon–Fri: 9 AM – 11 PM  (slot 0 required = 0)
 *   Sat–Sun: 8 AM – 11 PM  (slot 0 required > 0)
 *
 * Hard rules:
 *   - Max 9 paid hours per day (over that = overtime)
 *   - Patterns ≥ 7 paid hours include a built-in unpaid gap (lunch/dinner)
 *   - Patterns track only PAID slots; gaps are unpaid breaks
 *
 * Slot index:
 *   0: 8-9 AM     1: 9-10 AM    2: 10-11 AM   3: 11-12 AM   4: 12-1 PM
 *   5: 1-2 PM     6: 2-3 PM     7: 3-4 PM     8: 4-5 PM     9: 5-6 PM
 *  10: 6-7 PM    11: 7-8 PM    12: 8-9 PM    13: 9-10 PM   14: 10-11 PM
 *
 * Required coverage and shift patterns derived from the reference Excel
 * (May 21–27, 2026 week, 56 unique drivers).
 */

export interface DriverTimeSlot {
  label: string
  hours: number
}

export interface DriverDayTemplate {
  dayOfWeek: number
  dayName: string
  slots: DriverTimeSlot[]
  requiredCoverage: number[]
  shiftPatterns: number[][]
}

export const DRIVER_SLOTS: DriverTimeSlot[] = [
  { label: '8–9 AM',    hours: 1 },  // 0
  { label: '9–10 AM',   hours: 1 },  // 1
  { label: '10–11 AM',  hours: 1 },  // 2
  { label: '11–12 AM',  hours: 1 },  // 3
  { label: '12–1 PM',   hours: 1 },  // 4
  { label: '1–2 PM',    hours: 1 },  // 5
  { label: '2–3 PM',    hours: 1 },  // 6
  { label: '3–4 PM',    hours: 1 },  // 7
  { label: '4–5 PM',    hours: 1 },  // 8
  { label: '5–6 PM',    hours: 1 },  // 9
  { label: '6–7 PM',    hours: 1 },  // 10
  { label: '7–8 PM',    hours: 1 },  // 11
  { label: '8–9 PM',    hours: 1 },  // 12
  { label: '9–10 PM',   hours: 1 },  // 13
  { label: '10–11 PM',  hours: 1 },  // 14
]

// ─── Canonical shift patterns ──────────────────────────────────────────────
// Each pattern: 15-slot bitmap (1 = paid working, 0 = off/gap).
// Sum of bits = paid hours. All patterns ≤ 9h.
const WEEKDAY_PATTERNS: number[][] = [
  // Long shifts (10-11h with built-in unpaid breaks) — only used when
  // maxHoursPerDay is raised above 9 in the Period step. Lets a smaller
  // roster squeeze more hours per driver per day.
  [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0],  // 11h: 9 AM – 9 PM  (3-4 PM break)
  [0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0],  // 11h: 10 AM – 10 PM (3-4 PM break)
  [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0],  // 10h: 9 AM – 8 PM  (3-4 PM break)
  [0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0],  // 10h: 10 AM – 9 PM (3-4 PM break)
  // Morning-evening (start ≤ 11 AM, end ≤ 9 PM)
  [0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 9h:  9 AM – 8 PM (1-2 PM lunch)   ← workhorse
  [0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 8h:  10 AM – 8 PM
  // 9 AM-start mid-length patterns — without these, 8h drivers default
  // to 10 AM starts even when there's a 9 AM coverage gap, because the
  // existing 9 AM patterns are either 4-6h (too short to absorb their
  // cap) or 9-11h (penalized by the length quadratic).
  [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // 8h:  9 AM – 5 PM (continuous, covers morning gap)
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 7h:  9 AM – 4 PM (continuous, lighter morning)
  [0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0],  // 8h:  9 AM – 6 PM (1h lunch break)
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0],  // 8h:  11 AM – 9 PM
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0],  // 7h:  11 AM – 8 PM
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],  // 8h:  12 PM – 10 PM
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],  // 9h:  11 AM – 10 PM
  // Mid-afternoon
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0],  // 7h:  12 PM – 9 PM
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 7h:  2 PM – 9 PM
  // Evening-night (start ≥ 3 PM, end up to 11 PM)
  [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0],  // 7h:  3 PM – 10 PM
  [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],  // 6h:  3 PM – 9 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],  // 6h:  5 PM – 11 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],  // 5h:  6 PM – 11 PM
  // ─── Split shifts (morning + 2h unpaid break + evening) ─────────────────
  // Cover lunch + dinner peaks with a short mid-afternoon break (business
  // policy: max 2h unpaid). 8-10h paid total.
  [0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 8h:  10 AM – 2 PM + 4 PM – 8 PM  (2h break)
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0],  // 9h:  11 AM – 3 PM + 5 PM – 10 PM (2h break)
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0],  // 8h:  11 AM – 3 PM + 5 PM – 9 PM  (2h break)
  [0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0],  // 10h: 9 AM – 2 PM  + 4 PM – 9 PM  (2h break)
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],  // 8h:  12 PM – 4 PM + 6 PM – 10 PM (2h break)
  // ─── Short shifts (4-6h, full day coverage) ─────────────────────────────
  // Used when the demand-weighted dailyCap restricts longer shifts (early in
  // the work-week) or when drivers have a small remaining weekly budget
  // (late in the work-week — Tue/Wed). Spread across morning/midday/evening
  // so all slots can still be covered with short shifts.
  // Morning
  [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],  // 6h:  9 AM – 3 PM
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 6h:  10 AM – 4 PM
  [0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 5h:  9 AM – 2 PM
  [0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 4h:  9 AM – 1 PM
  [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 4h:  10 AM – 2 PM
  // Midday
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],  // 6h:  12 PM – 6 PM
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 5h:  11 AM – 4 PM
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // 5h:  12 PM – 5 PM
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 4h:  12 PM – 4 PM
  // Afternoon-evening
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],  // 5h:  2 PM – 7 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0],  // 5h:  4 PM – 9 PM
  [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],  // 4h:  3 PM – 7 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0],  // 4h:  5 PM – 9 PM (evening peak)
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],  // 4h:  7 PM – 11 PM (closing)
  // Evening-peak patterns that AVOID the 10-11 PM slot (which fills its
  // +3 over-cap fast on light-target days, blocking 5 PM-11 PM patterns
  // that would otherwise be picked). These let the scheduler cover the
  // 6-7 PM peak (Sat/Sun/Mon target 43-56) without touching slot 14.
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0],  // 6h:  4 PM – 10 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0],  // 5h:  5 PM – 10 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0],  // 4h:  6 PM – 10 PM (peak only)
]

// Weekend adds early-morning patterns (8 AM start).
const WEEKEND_PATTERNS: number[][] = [
  ...WEEKDAY_PATTERNS,
  [1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 9h:  8 AM – 8 PM (1-4 PM split)
  [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0],  // 9h:  8 AM – 8 PM (2-5 PM break)
  [1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 6h:  8 AM – 3 PM (11-12 break)
  // Short 8 AM weekend openers — weekend mornings need 6-13 drivers at 8 AM
  // and the weekday short patterns all start at 9 AM, leaving 8 AM unstaffed.
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 4h:  8 AM – 12 PM
  [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 5h:  8 AM – 1 PM
  [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 6h:  8 AM – 2 PM
  [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],  // 7h:  8 AM – 3 PM
]

// ─── Required coverage — 5-week average of actual operations ──────────────
// Apr 30 – Jun 3 2026 (5 weeks of historical schedules). Replaces the
// original single-week May 21–27 snapshot. Weekly total ~2486h, with Wed
// being the slowest day (312h) and Fri the busiest (419h).
const COV_THU = [0, 10, 16, 25, 30, 30, 19, 17, 19, 28, 42, 42, 27, 16, 6]
const COV_FRI = [0, 10, 20, 29, 37, 37, 26, 23, 26, 39, 56, 56, 36, 18, 6]
const COV_SAT = [6, 13, 18, 22, 29, 28, 23, 22, 27, 45, 56, 56, 33, 18, 6]
const COV_SUN = [7, 11, 17, 23, 29, 24, 26, 21, 25, 39, 51, 51, 30, 17, 7]
const COV_MON = [0, 10, 16, 22, 31, 31, 21, 21, 20, 23, 43, 43, 33, 13, 6]
const COV_TUE = [0,  9, 16, 24, 31, 31, 20, 19, 18, 24, 39, 39, 25, 14, 6]
const COV_WED = [0, 10, 14, 22, 29, 30, 21, 19, 19, 24, 38, 39, 27, 14, 6]

export const DRIVER_DAY_TEMPLATES: Record<number, DriverDayTemplate> = {
  0: { dayOfWeek: 0, dayName: 'Sunday',    slots: DRIVER_SLOTS, requiredCoverage: COV_SUN, shiftPatterns: WEEKEND_PATTERNS },
  1: { dayOfWeek: 1, dayName: 'Monday',    slots: DRIVER_SLOTS, requiredCoverage: COV_MON, shiftPatterns: WEEKDAY_PATTERNS },
  2: { dayOfWeek: 2, dayName: 'Tuesday',   slots: DRIVER_SLOTS, requiredCoverage: COV_TUE, shiftPatterns: WEEKDAY_PATTERNS },
  3: { dayOfWeek: 3, dayName: 'Wednesday', slots: DRIVER_SLOTS, requiredCoverage: COV_WED, shiftPatterns: WEEKDAY_PATTERNS },
  4: { dayOfWeek: 4, dayName: 'Thursday',  slots: DRIVER_SLOTS, requiredCoverage: COV_THU, shiftPatterns: WEEKDAY_PATTERNS },
  5: { dayOfWeek: 5, dayName: 'Friday',    slots: DRIVER_SLOTS, requiredCoverage: COV_FRI, shiftPatterns: WEEKDAY_PATTERNS },
  6: { dayOfWeek: 6, dayName: 'Saturday',  slots: DRIVER_SLOTS, requiredCoverage: COV_SAT, shiftPatterns: WEEKEND_PATTERNS },
}

// Hard ceiling on shift length. The Period step's `maxHoursPerDay` knob is
// further clamped by this; if you want shifts longer than 11h, raise this AND
// add a corresponding pattern (a 12h shift with no pattern available won't help).
export const MAX_HOURS_PER_DAY = 11
export const DEFAULT_PART_TIME_CAP = 30
export const DEFAULT_FULL_TIME_CAP = 40

// Sum of required driver-hours per day-of-week (0=Sun…6=Sat). Used by the
// scheduler to weight how much of a driver's weekly capacity should be spent
// today vs. saved for the rest of the work-week (Thu→Wed). Without this
// weighting the greedy pass spends 9h shifts Thu-Sat and starves Tue/Wed.
export const DAILY_DEMAND_BY_DOW: Record<number, number> = {
  0: COV_SUN.reduce((s, v) => s + v, 0),
  1: COV_MON.reduce((s, v) => s + v, 0),
  2: COV_TUE.reduce((s, v) => s + v, 0),
  3: COV_WED.reduce((s, v) => s + v, 0),
  4: COV_THU.reduce((s, v) => s + v, 0),
  5: COV_FRI.reduce((s, v) => s + v, 0),
  6: COV_SAT.reduce((s, v) => s + v, 0),
}

/**
 * Resolve the effective per-slot required-coverage array for a given day,
 * applying any user-supplied override first and then the scale multiplier.
 * Single source of truth — used by both the scheduler and the UI so the
 * grid the user edits is exactly what gets enforced.
 */
export function effectiveCoverage(
  dayOfWeek: number,
  coverageScale = 1,
  coverageOverrides: Record<number, number[]> = {},
): number[] {
  const base = coverageOverrides[dayOfWeek] ?? DRIVER_DAY_TEMPLATES[dayOfWeek].requiredCoverage
  return base.map((v) => Math.max(0, Math.round(v * coverageScale)))
}
