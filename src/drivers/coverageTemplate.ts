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
// Hard rule (ops policy): NO pattern may have a break (an unpaid 0 between
// two work blocks) inside the food-delivery peak windows:
//   - 11 AM–1 PM (slots 3, 4) — lunch peak
//   - 6 PM–8 PM (slots 10, 11) — dinner peak
// Breaks in the mid-afternoon lull (2-5 PM, slots 6-8) and morning slot
// rest (4-6 PM, slots 8-9) are allowed. Any new pattern must respect this.
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
  // LEGACY: 8h continuous 9 AM – 5 PM filtered out at runtime by the
  // 8h-must-have-break rule. Replaced effectively by the 9 AM – 6 PM
  // with-break variant below.
  // [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // 8h:  9 AM – 5 PM (continuous)
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],  // 7h:  9 AM – 4 PM (continuous, lighter morning)
  [0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0],  // 8h:  9 AM – 6 PM (1h lunch break)
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0],  // 8h:  11 AM – 9 PM
  [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0],  // 7h:  11 AM – 8 PM
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],  // 8h:  12 PM – 10 PM
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],  // 9h:  11 AM – 10 PM
  // Late-start straight shifts — lets the rebalance pass swap a
  // 9 AM-start driver to a 12 PM/1 PM start when mornings are over-
  // staffed and evening peaks are short. Without these, the rebalance
  // can't find same-length alternatives that cover 6-8 PM peaks.
  // 9h MUST include a break per ops policy. Replaced the previous
  // 12-9 PM and 1-10 PM continuous 9h with break versions.
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],  // 9h:  12 PM – 10 PM (1h break 4-5 PM)
  [0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1],  // 9h:  1 PM – 11 PM (1h break 5-6 PM)
  // LEGACY: these two continuous 8h patterns stay in the pool but are
  // filtered out at runtime by the 8h-must-have-break rule (see
  // breakRequiredAt in scheduler.ts). They're kept as commented-out
  // documentation so future ops changes can re-enable them if the rule
  // ever relaxes.
  // [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],  // 8h:  12 PM – 8 PM (continuous)
  // [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 8h:  1 PM – 9 PM (continuous)
  // Mid-afternoon
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0],  // 7h:  12 PM – 9 PM (split: 12-3 PM + 6-9 PM)
  [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],  // 7h:  1 PM – 8 PM continuous (manual dispatcher's "1p-7p" — extends through dinner)
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
  // REMOVED: 3-4h "peak-to-peak" splits violated the new 2h max-break
  // rule per ops policy. Lunch + dinner peaks can't be covered by a
  // single driver — they need different drivers per peak window.
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
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 4h:  4 PM – 8 PM (closes the gap between 3-7p and 5-9p; lets drivers bound by Sat 8a 12h-rest take a Fri evening shift)
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0],  // 4h:  5 PM – 9 PM (evening peak)
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],  // 4h:  7 PM – 11 PM (closing)
  // Evening-peak patterns that AVOID the 10-11 PM slot (which fills its
  // +3 over-cap fast on light-target days, blocking 5 PM-11 PM patterns
  // that would otherwise be picked). These let the scheduler cover the
  // 6-7 PM peak (Sat/Sun/Mon target 43-56) without touching slot 14.
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0],  // 6h:  4 PM – 10 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0],  // 5h:  5 PM – 10 PM
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0],  // 4h:  6 PM – 10 PM (peak only)
  // REMOVED: 3h "orphan-filler" patterns. Conflicted with the
  // 4h-minimum-day rule (scheduler.ts enforces effectiveMin = max(4,
  // minHoursPerDay) at every call site, so they were already dead
  // code) AND the new shift-shape rules — a 3h block is the MINIMUM
  // for a single block but a 3h DAY violates ops policy. Removing
  // them entirely so a future relaxation of effectiveMin can't
  // accidentally re-enable a 3h day.
]

// Weekend adds early-morning patterns (8 AM start).
const WEEKEND_PATTERNS: number[][] = [
  ...WEEKDAY_PATTERNS,
  // Weekend openers — break capped at 3h per the shift-shape rules
  // (was 2h). Wider pool to give the main pass more landing pads for
  // 8 AM starts — diagnosis showed 42 of 54 drivers AVAILABLE for
  // Sat 8 AM but only 3-4 placed because the pool was thin on opener
  // patterns and longer 9 AM-start patterns score higher on more
  // peak slots.
  [1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],  // 9h:  8 AM – 7 PM  (1-3 PM break, 2h)
  [1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0],  // 10h: 8 AM – 8 PM  (2-4 PM break, 2h)
  // New split-opener patterns with longer breaks (2h / 3h) — give
  // optimizer more ways to land a driver on opening slots while still
  // covering the dinner peak.
  [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0],  //  8h: 8 AM – 12 PM + 2 PM – 6 PM  (2h break)
  [1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],  //  8h: 8 AM – 12 PM + 3 PM – 7 PM  (3h break, ceiling)
  [1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],  //  9h: 8 AM – 1 PM  + 3 PM – 7 PM  (2h break)
  [1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0],  //  9h: 8 AM – 1 PM  + 4 PM – 8 PM  (3h break, ceiling)
  // REMOVED: 8 AM – 3 PM with 11-12 PM break — break sits in the
  // forbidden lunch-peak window (11 AM-1 PM). Continuous 8 AM-3 PM 7h
  // pattern is already in the pool below as the weekend opener.
  // Short 8 AM weekend openers — weekend mornings need 6-13 drivers at 8 AM
  // and the weekday short patterns all start at 9 AM, leaving 8 AM unstaffed.
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 4h:  8 AM – 12 PM
  [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 5h:  8 AM – 1 PM
  [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 6h:  8 AM – 2 PM
  [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],  // 7h:  8 AM – 3 PM
]

// ─── Weekend split-shift fallback ───────────────────────────────────────
// Single 10h pattern with a 3h midday break:
//   08:00 – 13:00 (5h)  + break 13:00 – 16:00  + 16:00 – 21:00 (5h)
// EXCEPTION to the standard "max 2h break" rule — allowed ONLY for this
// pattern, ONLY on Sat/Sun, and ONLY via the dedicated phase that uses
// it as a last-resort dual-peak fallback. Not included in
// WEEKEND_PATTERNS — the main pass, spread, and push phases never see
// it. The scheduler explicitly invokes it from the Phase-8.5 weekend
// split-shift filler, which caps usage at the minimum number of drivers
// needed to close BOTH a morning shortfall AND an evening shortfall on
// the same day.
//
// Manual overrides (e.g. ops keeping a few drivers on until 14:00
// before breaking) are NOT auto-generated, but also NOT blocked —
// the day-grid slot toggle bypasses this pool entirely.
export const WEEKEND_SPLIT_PATTERN: number[] = [
//8a 9a 10a 11a 12p 1p 2p 3p 4p 5p 6p 7p 8p 9p 10p
  1, 1, 1, 1, 1,  0, 0, 0, 1, 1, 1, 1, 1, 0, 0,
]

// ─── Required coverage — 5-week DRIVER-ONLY average ───────────────────────
// Apr 30 – May 6 2026 single high-coverage reference week (57 drivers
// in operation that week — a snapshot from when the roster was larger
// than the 5-week historical average). Replaces the previous 5-week
// average baseline (Apr 30 – Jun 3) at the user's request: ops wants
// the targets to reflect the peak operating state, not the average,
// so generated schedules push more bodies into the busiest hours.
// Shoppers (Annie, Eliraiza, Kishan, Noli) excluded — they're scored
// against the separate SHOPPER_COVERAGE pool below.
//
// Biggest peak increases vs prior baseline:
//   Sat 5p: 41→46, Sat 6p/7p: 52→56, Sun 6p/7p: 51→54
//   Fri 6p/7p: 52→54, Mon 6p/7p: 40→42, Wed 6p/7p: 34→36
//
// Mid-afternoon 2-5 PM (slot indices 6, 7, 8) TRIMMED ~3-6 below Apr 30
// reference: the user's manual edit on the Jun 4 schedule pulled 19
// driver-hours out of this window (especially −11 at 3 PM) without
// missing service. Ops policy: this is the slowest part of the day, so
// the baseline target itself should be lower — combined with the per-DOW
// SLOT_PRIORITY_WEIGHT below to push the algorithm to staff it leaner
// AND tolerate brief under-coverage there.
// Weekly total: ~2300h.
const COV_THU = [0,  9, 16, 23, 29, 29, 14, 11, 13, 24, 39, 39, 25, 16, 6]
const COV_FRI = [0,  9, 19, 25, 34, 34, 19, 16, 19, 36, 54, 54, 35, 18, 6]
const COV_SAT = [6, 12, 17, 21, 27, 28, 18, 14, 23, 46, 56, 56, 29, 18, 7]
const COV_SUN = [7, 11, 17, 24, 31, 26, 24, 18, 22, 41, 54, 54, 31, 17, 7]
const COV_MON = [0,  9, 16, 22, 30, 30, 16, 13, 14, 20, 42, 42, 32, 14, 6]
const COV_TUE = [0,  9, 15, 21, 26, 26, 13, 11, 14, 22, 36, 36, 23, 14, 6]
const COV_WED = [0,  9, 12, 20, 26, 26, 14, 11, 15, 20, 36, 36, 25, 15, 6]

// ─── Per-DOW per-slot PRIORITY weights ──────────────────────────────────
// Multiplicative weights applied wherever the scheduler scores filling a
// slot: main pass, Phase 5 narrow gap-fill, Phase 6 spread, Phase 8 push.
// Higher weight → algorithm prefers placing a body here. Lower weight →
// algorithm tolerates under-coverage here.
//
// Per ops policy:
//   - Friday peaks (12-2 PM and 6-8 PM) are SHARP → weight 2.5
//   - Sat/Sun peaks are FLATTER (longer broad mid-day demand) → weight 1.8
//   - 3 PM is the slowest hour everywhere → weight 0.3 (under-coverage OK)
//   - 4 PM dampened → weight 0.5
//   - 10 PM closing-edge dampened → weight 0.5
//
// A slot with weight < 0.5 that's under-target gets a milder color
// ('short-low-priority', muted amber) instead of red 'short' — see
// coverageStatus() in scheduler.ts.
// Opening-hour slots (8 AM, 9 AM, 10 AM = indices 0, 1, 2) carry a
// REAL boost — not just default 1.0 — because the optimizer was
// draining them to feed lunch/dinner peaks (snap10 diagnostic showed
// Sat 8 AM landing 5/6, 9 AM 12/18). Fri/Sat get 2.0, other days
// get 1.8 so morning placements compete on equal footing with the
// dinner-peak shoulders. Combined with the FLOOR_SLOTS hard-floor
// mechanism below, this stops the morning bleed.
const PRIORITY_FRI = [2.0, 2.0, 1.8, 1.5, 2.5, 2.5, 1.0, 0.3, 0.5, 1.5, 2.5, 2.5, 1.5, 1.0, 0.5]
// Sat/Sun opening hours (8-10 AM) get the heaviest weights of any slot
// anywhere — even higher than weekday peaks (2.5). Ops policy:
// "weekend mornings are the start of operation and non-negotiable; the
// afternoon 3-5 PM window absorbs the trade-off if capacity is short".
// Combined with OPENING_FLOOR_RATIO bumped to 0.80 on weekends (vs 0.65
// weekdays), this drives both the main-pass scorer AND Phase 10
// redistribution toward opening hours.
const PRIORITY_SAT = [3.0, 3.0, 2.5, 1.5, 1.8, 1.8, 1.4, 0.5, 0.8, 1.5, 1.8, 1.8, 1.5, 1.0, 0.5]
const PRIORITY_SUN = [3.0, 3.0, 2.5, 1.5, 1.8, 1.8, 1.4, 0.5, 0.8, 1.5, 1.8, 1.8, 1.5, 1.0, 0.5]
const PRIORITY_THU = [1.8, 1.8, 1.5, 1.3, 1.8, 1.8, 1.0, 0.3, 0.5, 1.3, 1.8, 1.8, 1.3, 1.0, 0.5]
const PRIORITY_MON = [1.8, 1.8, 1.5, 1.2, 1.5, 1.5, 1.0, 0.3, 0.5, 1.2, 1.8, 1.8, 1.3, 1.0, 0.5]
const PRIORITY_TUE = [1.8, 1.8, 1.5, 1.2, 1.5, 1.5, 1.0, 0.3, 0.5, 1.2, 1.5, 1.5, 1.2, 1.0, 0.5]
const PRIORITY_WED = [1.8, 1.8, 1.5, 1.2, 1.5, 1.5, 1.0, 0.3, 0.5, 1.2, 1.5, 1.5, 1.2, 1.0, 0.5]

export const SLOT_PRIORITY_WEIGHT: Record<number, number[]> = {
  0: PRIORITY_SUN, 1: PRIORITY_MON, 2: PRIORITY_TUE, 3: PRIORITY_WED,
  4: PRIORITY_THU, 5: PRIORITY_FRI, 6: PRIORITY_SAT,
}

/** Read the priority weight for a given (dow, slot). Defaults to 1.0
 *  if the lookup misses (defensive — never zero-multiplies a score). */
export function slotPriorityWeight(dow: number, slot: number): number {
  return SLOT_PRIORITY_WEIGHT[dow]?.[slot] ?? 1.0
}

// ─── Hard-floor slots ───────────────────────────────────────────────────
// Per ops policy: these slots MUST meet target. They cannot be demoted
// to 'short-low-priority', the hiring recommender counts their gaps as
// full shortfall, and the main pass adds a large score penalty for any
// pattern that would leave them short. The ONLY slot allowed to fall
// below target is slot 7 (3 PM) — the slowest hour of the day, where
// under-coverage is explicitly acceptable.
//
// Currently floor = every slot EXCEPT 3 PM. If ops ever wants a
// different policy ("4 PM may also dip"), edit FLOOR_SLOTS here — the
// algorithm reads from this single source of truth.
const NON_FLOOR_SLOT_IDX = 7  // 3-4 PM
export const FLOOR_SLOTS: number[] = (() => {
  const arr: number[] = []
  for (let i = 0; i < 15; i++) if (i !== NON_FLOOR_SLOT_IDX) arr.push(i)
  return arr
})()

/** True when the (dow, slot) has a HARD floor — coverage must meet target.
 *  Currently dow-independent (3 PM is the only exempt slot every day) but
 *  the signature keeps dow so day-specific rules can be added later. */
export function isFloorSlot(_dow: number, slot: number): boolean {
  return slot !== NON_FLOOR_SLOT_IDX
}

/** Subset of floor slots that the main-pass scorer ACTIVELY penalizes
 *  when left short — i.e. the slots where ops most needs the algorithm
 *  to fight for coverage. Currently the opening window (8-10 AM, indices
 *  0-2) which the optimizer was draining to feed peaks. Keeping this
 *  narrower than FLOOR_SLOTS prevents the scorer from going so deeply
 *  negative on busy-day patterns that it refuses to place anything. */
export const PROTECTED_OPENING_SLOTS: number[] = [0, 1, 2]
export function isProtectedOpeningSlot(_dow: number, slot: number): boolean {
  return PROTECTED_OPENING_SLOTS.includes(slot)
}

/** Dinner-peak slots (6-8 PM) that the scorer should aggressively chase
 *  when below their high floor. Same mechanism as PROTECTED_OPENING_SLOTS
 *  but on the other end of the day. Identified from manual-dispatcher
 *  comparison: the generator was missing dinner-peak target by 4-7 bodies
 *  per weekday while the dispatcher consistently lands +4 over target.
 *  Slots 10/11/12 = 6 PM / 7 PM / 8 PM. */
export const PROTECTED_DINNER_SLOTS: number[] = [10, 11, 12]
export function isProtectedDinnerSlot(_dow: number, slot: number): boolean {
  return PROTECTED_DINNER_SLOTS.includes(slot)
}

/** Threshold below which a slot is considered "low priority" — used by
 *  coverageStatus() to render under-target slots in amber (acceptable
 *  shortfall) instead of red (real gap). */
export const LOW_PRIORITY_WEIGHT = 0.5

// ─── Hard coverage floors (safety nets for under-target slots) ───────────
// No floor slot may drop below its FLOOR ratio of target. Distinct from
// FLOOR_SLOTS (which says "this slot must meet target" — a soft
// preference): floor ratios are the HARD bottom that triggers Phase 10
// redistribution. Even when total demand exceeds capacity, the optimizer
// must spread the shortfall so every floor slot stays at or above its
// floor — taking the hit from the deprioritized 15:00-16:00 window
// instead.
//
// Four ratios:
//   - 40% default — Wed 22:00 came in at 2/5 (40%) and Wed 19:00 at
//     21/36 (58%) on a tight week. Both were judged "near-collapse"
//     service quality. The default floor prevents anything worse.
//   - 65% on weekday opening slots (8-10 AM) — start of operation,
//     thinner than peaks but still important.
//   - 80% on WEEKEND opening slots (Sat/Sun 8-10 AM) — ops policy:
//     "weekend mornings are non-negotiable, the afternoon absorbs
//     the trade-off when capacity is short". Sat 8 AM with target 7
//     floors at ceil(7×0.80)=6.
//   - 90% on DINNER peak slots (6-8 PM, Mon-Sat) — manual-dispatcher
//     comparison showed the generator missing dinner target by 4-7
//     bodies per weekday while the dispatcher landed +4 over. 90%
//     forces the optimizer to fight harder for dinner peaks instead
//     of trickling drivers into mid-afternoon shifts that miss the
//     peak entirely. Fri 6 PM target 50 floors at 45.
export const COVERAGE_FLOOR_RATIO = 0.40
export const OPENING_FLOOR_RATIO = 0.65
export const WEEKEND_OPENING_FLOOR_RATIO = 0.80
export const DINNER_FLOOR_RATIO = 0.90

/** Minimum coverage a slot may run at, given its target. The ratio
 *  depends on which "protected" window the slot falls into:
 *    - opening (8-10 AM): 80% weekends, 65% weekdays
 *    - dinner peak (6-8 PM): 90% Mon-Sat
 *    - everything else: 40% default safety net
 *  Rounded UP so the optimizer can't happily land at "just under". */
export function floorCoverageFor(target: number, dow?: number, slot?: number): number {
  if (target <= 0) return 0
  let ratio = COVERAGE_FLOOR_RATIO
  if (dow !== undefined && slot !== undefined) {
    if (isProtectedOpeningSlot(dow, slot)) {
      ratio = (dow === 0 || dow === 6) ? WEEKEND_OPENING_FLOOR_RATIO : OPENING_FLOOR_RATIO
    } else if (isProtectedDinnerSlot(dow, slot)) {
      // 90% floor on dinner peaks (6-8 PM) every day. Empirically the
      // manual dispatcher hits target on Sunday 6-7 PM too, so the
      // generator should have the same pressure there.
      ratio = DINNER_FLOOR_RATIO
    }
  }
  return Math.ceil(target * ratio)
}

/** Afternoon "donor" slots — 3 PM (15:00) and 4 PM (16:00). When total
 *  capacity is short, the floor enforcer takes the shortfall here FIRST
 *  per ops policy ("take the shortfall from the lowest-priority slots
 *  first, the deprioritized 15:00–16:00 window"). The 40% floor does NOT
 *  apply to these slots — they can collapse to 0% if it means lifting
 *  the opening / lunch / dinner / closing slots back to floor.
 *
 *  10 PM (slot 14) carries weight 0.5 on most days too, but the user
 *  explicitly cited Wed 22:00 = 2/5 as the kind of collapse the floor
 *  is meant to PREVENT — so it stays IN the protected set, not a donor. */
export const DONOR_SLOTS: number[] = [7, 8]

/** Slots that the 40% hard floor protects. Every FLOOR slot EXCEPT the
 *  afternoon donor window (3-4 PM). This is the protected set ops cited:
 *  opening hours (8-10 AM), late-morning ramp (11 AM), lunch/dinner peaks
 *  (12-2 PM, 5-9 PM), and the closing window (10 PM). All of those must
 *  stay >= 40% of their target even when capacity is too short to meet
 *  every target. */
export function isFloorPrioritySlot(dow: number, slot: number): boolean {
  if (!isFloorSlot(dow, slot)) return false
  return !DONOR_SLOTS.includes(slot)
}

// ─── Shopper coverage targets (separate pool, groceries) ─────────────────
// From the Apr 30 – May 6 2026 reference week (same source as the driver
// targets above). Sunday is 0 — shoppers don't work Sundays. Shown as a
// SECOND row in the day-grid footer so ops can verify shopper presence
// independently from driver coverage.
const SHOP_COV_THU = [0, 1, 1, 2, 3, 3, 2, 2, 2, 3, 3, 2, 2, 0, 0]
const SHOP_COV_FRI = [0, 1, 2, 3, 3, 3, 3, 2, 3, 3, 4, 4, 2, 0, 0]
const SHOP_COV_SAT = [0, 1, 2, 3, 3, 3, 2, 3, 2, 4, 4, 4, 2, 0, 0]
const SHOP_COV_SUN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const SHOP_COV_MON = [0, 1, 2, 2, 3, 3, 2, 2, 3, 4, 2, 2, 1, 0, 0]
const SHOP_COV_TUE = [0, 1, 2, 2, 3, 3, 2, 2, 3, 4, 4, 4, 2, 0, 0]
const SHOP_COV_WED = [0, 1, 2, 2, 2, 3, 3, 2, 2, 4, 4, 4, 3, 0, 0]

export const SHOPPER_COVERAGE: Record<number, number[]> = {
  0: SHOP_COV_SUN, 1: SHOP_COV_MON, 2: SHOP_COV_TUE, 3: SHOP_COV_WED,
  4: SHOP_COV_THU, 5: SHOP_COV_FRI, 6: SHOP_COV_SAT,
}

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
// Ops-preferred default caps (Ops sets these explicitly per the user;
// they sit below the legal max so the +10% buffer can absorb a few
// over-cap hours without crossing into legal weekly overtime).
//   FT default: 42h (legal max 45h)
//   PT default: 28h (legal max 30h)
export const DEFAULT_PART_TIME_CAP = 28
export const DEFAULT_FULL_TIME_CAP = 42

// Legal pre-overtime daily ceiling: 9h. Used both as the default value of
// the Period step's `maxHoursPerDay` knob AND as the absolute clamp for
// the soft-overflow logic — so an op-driven schedule never silently pushes
// a driver into 10h+ daily overtime.
export const LEGAL_DAILY_MAX_HOURS = 9
// Legal pre-overtime WEEKLY ceiling, per employment type:
//   - Full-time: 45h
//   - Part-time: 30h
// Used as the clamp for the soft buffer above the user-set cap so PT
// drivers can't silently be pushed past their type's legal max.
export const LEGAL_WEEKLY_MAX_HOURS = 45
export const LEGAL_PT_WEEKLY_MAX_HOURS = 30

// Overtime policy — applied only as a LAST RESORT when normal cap-fill
// can't meet coverage demand. The algorithm picks the top X% of FT
// drivers (by current weekly hours, so the most-engaged ones) and lets
// each go up to +5h/week and +1h/day past the legal pre-OT caps.
export const OT_FLEET_PCT = 0.10              // top 10% of FT can do OT
export const OT_WEEKLY_BONUS = 5              // +5h per OT-eligible driver → 50h/wk
export const OT_DAILY_BONUS = 1               // +1h per OT-eligible shift → 10h/day

// Soft "buffer" over the USER-set cap (distinct from legal overtime).
// If the user sets cap=40, drivers can stretch to 44h (40 × 1.10) when
// the algorithm needs them to cover gaps — but still clamped at the
// legal 45h/wk maximum so this doesn't silently push anyone into legal
// OT. Same idea daily: max=8 lets a few drivers reach 9h (already done
// via the existing soft-overflow on daily max). Default 10% but the
// user can tune in the Period step in a future commit.
export const USER_CAP_BUFFER_PCT = 0.10

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
