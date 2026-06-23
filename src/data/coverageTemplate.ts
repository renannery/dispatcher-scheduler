/**
 * Coverage template — 19 time slots per day.
 *
 * Mon–Fri: 9 AM – 11 PM  (slot 0 = 8–9 AM, coverage = 0 → hidden in UI)
 * Sat–Sun: 8 AM – 11 PM  (slot 0 = 8–9 AM, coverage > 0)
 *
 * Shape rules enforced in every pattern (build-time assertion at the bottom
 * of this file fails the import on violation):
 *   Every work block ≥ MIN_BLOCK_HOURS (3 h)        — no 1-2 h tail blocks
 *   work ≤ 6 h           → no break required
 *   6 h < work < 8 h     → ≥ 30 min break
 *   work ≥ 8 h           → ≥ 1 h break
 *   Mid-shift break ≤ MAX_BREAK_HARD_HOURS (3 h)    — 2 h preferred, 3 h fallback
 * Max work per day = 9 h.
 *
 * Peak-time breaks (lunch 12–2 PM / dinner 5–8 PM) are *allowed* in
 * patterns — the picker decides whether to use them. Coverage targets
 * still need to be met overall; the picker prefers peak-safe patterns
 * unless using a peak-break variant earns extra morning/late coverage
 * from the same dispatcher. See PEAK_SLOT_INDICES below for the set.
 *
 * Where a break inside a pattern would reduce coverage below required,
 * the required number is adjusted down by 1 for that slot.
 *
 * Slot index reference:
 *  0: 8–9 AM   1: 9–10 AM   2: 10–11 AM
 *  3: 11–11:30  4: 11:30–12  5: 12–1 PM
 *  6: 1–2 PM   7: 2–2:30    8: 2:30–3
 *  9: 3–4 PM  10: 4–5 PM   11: 5–6 PM
 * 12: 6–6:30  13: 6:30–7   14: 7–8 PM
 * 15: 8–8:30  16: 8:30–9   17: 9–10 PM
 * 18: 10–11 PM
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
]

// ─── THURSDAY (dayOfWeek=4) ─────────────────────────────────────────────────
const THU: DayTemplate = {
  dayOfWeek: 4, dayName: 'Thursday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 1, 2, 2, 2, 1, 2, 2, 3, 3, 2, 2, 3, 3, 2, 3, 1],
  //                                              ↑  ↑ adjusted down 1 (staggered late breaks)
  shiftPatterns: [
    // Early    (9 AM–3 PM, 6 h single block — covers morning + lunch peak)
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    // Bridge   (11 AM–5 PM, 6 h single block — covers lunch + afternoon)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Long split (11 AM–3 PM + 5 PM–10 PM, 9 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late A   (4 PM–10 PM, 6 h single block — covers dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── FRIDAY (dayOfWeek=5) ───────────────────────────────────────────────────
const FRI: DayTemplate = {
  dayOfWeek: 5, dayName: 'Friday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 2, 2, 2, 2, 3, 4, 3, 3, 4, 3, 2, 3, 3],
  //                                    ↑ adjusted (Early A on lunch break)
  //                                                      ↑  ↑ adjusted (Late B on break)
  //                                                               ↑ adjusted (Late A on break)
  shiftPatterns: [
    // Early A  (9 AM–3 PM, 6 h single block — covers morning + lunch peak)
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (10 AM–4 PM, 6 h single block — covers mid-morning + lunch + afternoon)
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    //Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Long split (11 AM–3 PM + 5 PM–10 PM, 9 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late A   (4 PM–10 PM, 6 h single block — covers dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── SATURDAY (dayOfWeek=6) ─────────────────────────────────────────────────
const SAT: DayTemplate = {
  dayOfWeek: 6, dayName: 'Saturday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    2, 2, 2, 2, 4, 4, 4, 2, 2, 1, 1, 4, 4, 4, 4, 3, 3, 2, 1],
  //                                                           ↑  ↑ adjusted (Late A on break)
  shiftPatterns: [
    // Early A  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (8 AM–4 PM, 7 h + 1 h break at 11–12, blocks 3 h + 4 h —
    //   covers the 3–4 PM gap that Early A leaves)
    [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split A  (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Split B  (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4 PM–10 PM, 6 h single block — covers dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── SUNDAY (dayOfWeek=0) ───────────────────────────────────────────────────
const SUN: DayTemplate = {
  dayOfWeek: 0, dayName: 'Sunday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    2, 2, 2, 2, 3, 3, 3, 2, 2, 1, 3, 4, 4, 4, 4, 3, 2, 3, 3],
  //                                                            ↑ adjusted (Early A on lunch)
  shiftPatterns: [
    // Early A  (8 AM–3 PM, 6 h + 1 h break at 11 AM–12 PM, blocks 3 h + 3 h)
    [1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30, blocks 3 h + 3.5 h)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (3 PM–9 PM, 6 h single block — covers afternoon + dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late B   (4 PM–10 PM, 6 h single block — covers dinner peak + evening)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late C   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── MONDAY (dayOfWeek=1) ───────────────────────────────────────────────────
const MON: DayTemplate = {
  dayOfWeek: 1, dayName: 'Monday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 1, 1, 2, 2, 2, 2, 1, 2, 1, 2, 2, 3, 3, 3, 3, 1, 2, 2],
  shiftPatterns: [
    // Early    (9 AM–3 PM, 6 h single block — covers morning + lunch peak)
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Bridge   (11 AM–5 PM, 6 h single block — covers lunch + afternoon,
    //   fills the 3–4 PM gap where Early ends and the Split takes a break)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    //Split    (11 AM–3 PM + 5 PM–8:30 PM, 7.5 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4 PM–10 PM, 6 h single block — covers dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── TUESDAY (dayOfWeek=2) ──────────────────────────────────────────────────
const TUE: DayTemplate = {
  dayOfWeek: 2, dayName: 'Tuesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 3, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1],
  shiftPatterns: [
    // Early A  (9 AM–3 PM, 6 h single block — covers morning + lunch peak)
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    //Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–9:30 PM, ~8 h, 2 h break 2–4 PM — trimmed from 9.5 h)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late     (11 AM–2 PM + 5 PM–11 PM, 9 h, 3 h break 2–5 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── WEDNESDAY (dayOfWeek=3) ────────────────────────────────────────────────
const WED: DayTemplate = {
  dayOfWeek: 3, dayName: 'Wednesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 3, 3, 3, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 2],
  //                                       ↑ adjusted (Early A on lunch break)
  shiftPatterns: [
    // Early    (9 AM–3 PM, 6 h single block — covers morning + lunch peak)
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    //Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Bridge   (11 AM–5 PM, 6 h single block — covers lunch + afternoon)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Late A   (4 PM–10 PM, 6 h single block — covers dinner peak)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h single block — covers dinner + late)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  ],
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
// Break-shape rules
// ───────────────────────────────────────────────────────────────────────────

/** Preferred max mid-shift break. Patterns over this are scored lower. */
export const MAX_BREAK_PREFERRED_HOURS = 2

/** Hard cap on mid-shift break. Patterns over this are rejected at import. */
export const MAX_BREAK_HARD_HOURS = 3

/** Minimum length of any single work block in a pattern. Prevents 1-2 h
 *  tail-blocks before/after a break. A dispatcher should work at least 3 h
 *  before taking a break. */
export const MIN_BLOCK_HOURS = 3

/** Required break for an 8 h+ shift. */
export const LONG_SHIFT_BREAK_MIN = 1

/** Required break for a 6–8 h shift. */
export const MED_SHIFT_BREAK_MIN = 0.5

/** Slot indices that fall within peak hours — lunch (12–2 PM) and dinner
 *  (5–8 PM). Mid-shift breaks must not overlap any of these slots; the
 *  whole peak must always be staffed at full intent. */
export const PEAK_SLOT_INDICES = [5, 6, 11, 12, 13, 14]

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

// Build-time assertion: every pattern must satisfy the shape rules.
// Peak-time breaks are no longer rejected here — the picker decides
// whether to use peak-break patterns based on real coverage need.
;(() => {
  const violations: string[] = []
  for (const day of Object.values(DAY_TEMPLATES)) {
    day.shiftPatterns.forEach((pat, idx) => {
      const brk = patternMaxBreakHours(pat, day.slots)
      const blocks = patternWorkBlocks(pat, day.slots)
      const minBlock = blocks.length === 0 ? 0 : Math.min(...blocks)
      const work = totalWorkHours(pat, day.slots)
      if (brk > MAX_BREAK_HARD_HOURS) {
        violations.push(`${day.dayName} #${idx}: ${brk}h break > ${MAX_BREAK_HARD_HOURS}h hard cap`)
      }
      if (blocks.length > 1 && minBlock < MIN_BLOCK_HOURS) {
        violations.push(`${day.dayName} #${idx}: ${minBlock}h work block < ${MIN_BLOCK_HOURS}h min (blocks=[${blocks.join(',')}])`)
      }
      if (work >= 8 && brk < LONG_SHIFT_BREAK_MIN) {
        violations.push(`${day.dayName} #${idx}: ${work}h shift needs ≥${LONG_SHIFT_BREAK_MIN}h break, has ${brk}h`)
      } else if (work > 6 && work < 8 && brk < MED_SHIFT_BREAK_MIN) {
        violations.push(`${day.dayName} #${idx}: ${work}h shift needs ≥${MED_SHIFT_BREAK_MIN}h break, has ${brk}h`)
      }
    })
  }
  if (violations.length > 0) {
    throw new Error(`Dispatcher pattern shape violations:\n  ${violations.join('\n  ')}`)
  }
})()
