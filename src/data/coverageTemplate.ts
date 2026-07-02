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

// STAGGERED starts and STAGGERED meal breaks. Every shape's break is
// baked into its bitmap, so identical copies break in the same slot —
// the original single-shape-per-period catalog collapsed coverage to 0
// whenever a whole team broke at once (2–2:30 PM on 49 of 77 days).
// The fix is break-variant + start-variant shapes: the gap-aware picker
// then staggers breaks on its own, because the variant that covers the
// current deficit outscores a duplicate of an already-picked shape.
//
// NO BREAK EVER SITS INSIDE A PEAK WINDOW (lunch 11:30–2, dinner 5–8).
// Every shape either has no break at all (the 5h straight shapes) or
// breaks on a shoulder slot: 11:00 AM before lunch, 8:00/8:30 PM after
// dinner. The 5h-max-stretch law pins each start time to specific
// break positions — a 3 PM starter can only break legally at 8:00 PM,
// a 4 PM starter at 8:00 or 8:30, a 2 PM starter has NO legal
// post-peak position (so the ramp shape is a 5h no-break block ending
// 7 PM). Unavoidable −1s land on shoulder slots (11–11:30 AM,
// 8–9 PM), never inside a peak, and surface as warnings.
//
// LEAN TRANSITION: morning shifts end by 15:00 and evening shifts start
// 15:00/16:00/17:00 per demand. There is NO scheduled overlap between
// the teams — the incoming dispatcher arrives ~10 min early (off the
// schedule) to catch up, so the 3–5 PM lull staffs to its coverage
// target instead of hosting a 6–7 body pile-up while both full teams
// pass through it.
//
// Weekday Morning 9 (9:00–14:00, 5h straight — at exactly 5h no meal
// break is due). Lunch anchor: continuous through 11:30–2 PM.
const WD_MORNING  = [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Weekday Morning 10 (10:00–15:00, 5h straight). Staggered start
// (avoids stacking the low-req opening) and holds 2–3 PM after
// Morning 9 leaves. Lunch anchor.
const WD_MORNING_10 = [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Weekday Morning LONG (9:00–16:00, meal 2:00–2:30 PM; 5h + 1.5h,
// 6.5h). The body-efficient morning: its break is on the 2 PM shoulder
// — OUTSIDE the lunch peak — so one long body replaces two short ones
// without ever thinning the peak. Lunch anchor. ONE copy only: 2 PM is
// this shape's only legal break position (9 AM + 5h max stretch), so
// two copies would break simultaneously and zero the 2–2:30 slot.
const WD_MORNING_L = [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Ramp (14:00–19:00, 5h straight — no break due at exactly 5h). Covers
// the 2–3 PM window after the mornings leave, the 3–5 PM lull, and the
// front of the dinner peak. A 2 PM starter has NO legal post-peak break
// position (14:00 + 5h max stretch = 19:00, before the peak ends), so
// instead of breaking inside the peak the shape simply ends at 7 PM —
// the closers own 7 PM onward.
const RAMP_14     = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]
// Weekend Morning 8a (8:00–14:00, meal 11:00–11:30 AM; 3h + 2.5h, 5.5h).
// Lunch anchor: break ends before the 11:30 peak start.
const WE_MORNING  = [1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// (Weekend Morning 8b — the 11:30–12 break twin — was RETIRED: its
// break sat inside the lunch peak. A 6h 8 AM shift can only break at
// 11:00 or 11:30, and only 11:00 is outside the peak.)
//
// Weekend Morning 8c (8:00–13:00, 5h straight — no break at all). The
// second 8 AM body: breakless, so the opening pair never shares a
// break slot. Ends 1 PM (inside the lunch window, but the anchors —
// 8a and Morning 10 — carry the peak through 2 PM).
const WE_MORNING_C = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
//
// Weekend Morning 10 (10:00–15:00, 5h straight). Staggered start —
// keeps the 8 AM opening at its req-2 target instead of stacking four
// bodies there — and holds 2–3 PM after the 8 AM shifts leave. Anchor.
const WE_MORNING_10 = [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Weekend Morning LONG (8:00–16:00, meal 11:00–11:30 AM; 3h + 4.5h,
// 7.5h). Body-efficient weekend opener: break before the lunch peak,
// carries the whole peak plus the 2–4 PM tail. Lunch anchor.
const WE_MORNING_L = [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
// Evening A (15:00–23:30, meal break 8:00–8:30 PM; stretches 5h + 3h, 8h
// worked). Dinner anchor: continuous through 5–8 PM, starts 3 PM.
const EVENING_A   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1]
// (Evening B and C — the 6:00 and 6:30 PM break variants — were
// RETIRED: both broke inside the dinner peak. A 3 PM starter's only
// legal outside-peak break is 8:00 PM, so Evening A is the only
// 15:00 shape; extra evening bodies come from the later starts below,
// whose breaks land legally after the peak.)
//
// Evening D (16:00–23:30, meal break 8:30–9 PM; stretches 4.5h + 2.5h,
// 7h). LATE start — lets the picker skip the 3–4 PM lull when its
// target is already met instead of forcing every evening body through
// it. Dinner anchor (starts 4 PM, continuous through 5–8 PM); breaks
// at 8:30 so the scarce 8–8:30 PM slot keeps its bodies.
const EVENING_D   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1]
// Evening D2 (16:00–23:30, meal break 8:00–8:30 PM; 4h + 3h, 7h).
// Break-stagger twin of D — same start, the other post-peak break
// position. Dinner anchor.
const EVENING_D2  = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1]
// Evening S (17:00–22:00, 5h straight — no break at all). The body
// that can never collapse a slot: full dinner peak + the 8–10 PM
// shoulder, then hands the close to the 23:30-enders. Not an anchor
// (starts exactly at the peak boundary). Weekday-legal (5h primary).
const EVENING_S   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0]
// Evening E (17:00–23:30, meal break 8–8:30 PM; stretches 3h + 3h, 6h).
// WEEKEND-ONLY latest start — its 3h primary stretch is under the 4h
// weekday minimum. Serves days like Saturday where the override wants
// 1 body at 3–5 PM but 4 at dinner: the dinner crowd arrives at 5.
const EVENING_E   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1]
// Evening E2 (17:00–23:30, meal break 8:30–9 PM; 3.5h + 2.5h, 6h).
// WEEKEND-ONLY break-stagger twin of E.
const EVENING_E2  = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1]
// Evening L (18:30–23:30, 5h straight — no break). The breakless
// CLOSER: carries the whole 8 PM–11:30 PM tail so the shoulder slots
// keep their bodies while the earlier shapes take their post-peak
// breaks. Weekday-legal (5h primary).
const EVENING_L   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]

// Mon–Wed SPLIT shapes — the one explicit exception to the 30-min paid
// meal break: one dispatcher covers BOTH peaks with a long unpaid 3h gap
// through the 14:00–17:00 lull (slots 7–10). The gap clears the lunch
// peak (ends 14:00) and the dinner peak (starts 17:00), both blocks are
// ≥3h and ≤5h, and the shape carries the weekday 5h primary stretch.
// A split dispatcher anchors BOTH peaks (starts before each, continuous
// through each). Splits free a body-day on Tue/Wed, which funds the
// rotating 2nd day off for Regular/Senior dispatchers.
//
// Split B (11:00–14:00 + 17:00–22:00, 3h + 5h, 8h worked — dinner-heavy;
// ends 10 PM so night-rest blocks a next-day morning.)
const SPLIT_B = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0]
// Split C (9:00–14:00 + 17:00–20:00, 5h + 3h, 8h worked — morning-heavy;
// helps the 9–11 AM open, ends 8 PM.)
const SPLIT_C = [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0]

/** Slots a Mon–Wed split gap may occupy (14:00–17:00 lull) and its
 *  exact length. Used by isValidShiftShape to admit the split shape. */
export const SPLIT_GAP_SLOTS = [7, 8, 9, 10] as const
export const SPLIT_GAP_HOURS = 3

/** Canonical split coverage bitmap — used by the coverage-gated off
 *  election to simulate how many bodies a split saves on a given day. */
export const SPLIT_COVERAGE: readonly number[] = SPLIT_B

// Copy counts set the per-shape team capacity. Break positions across
// the evening pool: A/D2/E at 8:00 PM, D/E2 at 8:30 PM, S/RAMP none —
// the picker staggers among them, and no position sits inside a peak.
const WEEKDAY_PATTERNS = [
  WD_MORNING, WD_MORNING,
  WD_MORNING_10, WD_MORNING_10,
  WD_MORNING_L,
  RAMP_14, RAMP_14,
  EVENING_A, EVENING_A,
  EVENING_D, EVENING_D,
  EVENING_D2, EVENING_D2,
  EVENING_S, EVENING_S,
  EVENING_L, EVENING_L,
]
// Mon–Wed: same catalog PLUS the split shapes. Thu–Sun get no splits.
const MON_WED_PATTERNS = [
  ...WEEKDAY_PATTERNS,
  SPLIT_B, SPLIT_B,
  SPLIT_C, SPLIT_C,
]
const WEEKEND_PATTERNS = [
  WE_MORNING, WE_MORNING,
  WE_MORNING_C, WE_MORNING_C,
  WE_MORNING_L,
  WE_MORNING_10, WE_MORNING_10,
  RAMP_14, RAMP_14,
  EVENING_A, EVENING_A,
  EVENING_D, EVENING_D,
  EVENING_D2, EVENING_D2,
  EVENING_S, EVENING_S,
  EVENING_E, EVENING_E,
  EVENING_E2, EVENING_E2,
  EVENING_L, EVENING_L,
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
  shiftPatterns: MON_WED_PATTERNS,
}

// ─── TUESDAY (dayOfWeek=2) ──────────────────────────────────────────────────
const TUE: DayTemplate = {
  dayOfWeek: 2, dayName: 'Tuesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 3, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1],
  shiftPatterns: MON_WED_PATTERNS,
}

// ─── WEDNESDAY (dayOfWeek=3) ────────────────────────────────────────────────
const WED: DayTemplate = {
  dayOfWeek: 3, dayName: 'Wednesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 3, 3, 3, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 2, 1],
  shiftPatterns: MON_WED_PATTERNS,
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

/** Weekday-only requirement: every Mon–Fri shift must contain at least
 *  one worked stretch of this length. Relaxed from 5h to 4h to admit
 *  the staggered-start shapes (Morning-10 4.5h + 2h, Ramp-14 4h + 3.5h,
 *  Evening-C 3.5h + 4.5h) — the grid's half-slot positions make a 5h
 *  stretch impossible for any start except 9:00/15:00/18:30, so 5h and
 *  staggered starts were mutually exclusive. 4h still guarantees a real
 *  stretch of work and still bans slivers. Weekends are exempt so the
 *  8 AM opener can split 3h + 4.5h around a late-morning break.
 *  Enforced in isValidShiftShape via the caller-supplied `dayOfWeek`. */
export const WEEKDAY_PRIMARY_STRETCH_HOURS = 4

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

/** The Morning/Evening boundary (3 PM, slot 9). A shift whose first
 *  worked slot is at or after this is an Evening shift. There is no
 *  scheduled handoff overlap — context transfers because the incoming
 *  dispatcher arrives ~10 minutes before their shift (off-schedule),
 *  so shifts meet at the slot boundary without over-covering the lull. */
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
    const splitsAllowed = day.dayOfWeek >= 1 && day.dayOfWeek <= 3 // Mon–Wed
    day.shiftPatterns.forEach((pat, idx) => {
      const blocks = patternWorkBlocks(pat, day.slots)
      const brk = patternMaxBreakHours(pat, day.slots)
      const work = totalWorkHours(pat, day.slots)
      if (blocks.length === 0 || blocks.length > 2) {
        violations.push(`${day.dayName} #${idx}: ${blocks.length} stretches (need 1 or 2)`)
        return
      }
      if (blocks.length === 2 && brk !== MEAL_BREAK_HOURS) {
        // Mon–Wed split exception: a 3h unpaid gap confined to the
        // 14:00–17:00 lull, both blocks ≥ 3h.
        const gap = midShiftBreakSlots(pat)
        const isSplit =
          splitsAllowed &&
          brk === SPLIT_GAP_HOURS &&
          gap.every((s) => (SPLIT_GAP_SLOTS as readonly number[]).includes(s)) &&
          blocks[0] >= MIN_BLOCK_HOURS &&
          blocks[1] >= MIN_BLOCK_HOURS
        if (!isSplit) {
          violations.push(`${day.dayName} #${idx}: break ${brk}h is neither the ${MEAL_BREAK_HOURS}h meal break nor a legal Mon–Wed split gap`)
        }
      } else if (blocks.length === 2 && blocks[1] < MIN_TAIL_STRETCH_HOURS) {
        violations.push(`${day.dayName} #${idx}: tail ${blocks[1]}h < ${MIN_TAIL_STRETCH_HOURS}h`)
      }
      if (Math.max(...blocks) > MAX_CONSECUTIVE_HOURS) {
        violations.push(`${day.dayName} #${idx}: ${Math.max(...blocks)}h stretch > ${MAX_CONSECUTIVE_HOURS}h legal max`)
      }
      if (blocks[0] < MIN_BLOCK_HOURS) {
        violations.push(`${day.dayName} #${idx}: first stretch ${blocks[0]}h < ${MIN_BLOCK_HOURS}h`)
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
