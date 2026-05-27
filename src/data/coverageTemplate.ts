/**
 * Coverage template — 19 time slots per day.
 *
 * Mon–Fri: 9 AM – 11 PM  (slot 0 = 8–9 AM, coverage = 0 → hidden in UI)
 * Sat–Sun: 8 AM – 11 PM  (slot 0 = 8–9 AM, coverage > 0)
 *
 * Break rules enforced in every pattern:
 *   ≥ 6 h work → at least 30 min break (one 0.5 h slot gap inside the shift)
 *   ≥ 7 h work → at least 1 h break   (one 1 h slot gap, or two consecutive 0.5 h gaps)
 * Max work per day = 9 h.
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
    // Early A  (9 AM–4 PM, 6.5 h + 30 m break at 11–11:30)
    [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (9 AM–4 PM, 6.5 h + 30 m break at 2–2:30)
    [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Late A   (4 PM–11 PM, 6.5 h + 30 m break at 6:30–7)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1],
    // Late B   (4 PM–11 PM, 6.5 h + 30 m break at 6–6:30)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    // Late C   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
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
    // Early A  (9 AM–4 PM, 6 h work + 1 h break at noon)
    [0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (9 AM–4 PM, 6.5 h + 30 m break at 11–11:30)
    [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 5 PM–8:30 PM, ~6.5 h, natural break 2–5 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4 PM–11 PM, 6 h + 1 h break at 8–9 PM)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1],
    // Late B   (4 PM–11 PM, 6 h + 1 h break at 6–7 PM)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1],
    // Late C   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
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
    // Early B  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split A  (11 AM–2 PM + 5 PM–8:30 PM, ~6.5 h, natural break 2–5 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Split B  (11 AM–2 PM + 5 PM–8:30 PM, ~6.5 h)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (3 PM–10 PM, 6 h + 1 h break at 6–7 PM)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0],
    // Late B   (5 PM–11 PM, 6 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1],
    //  NOTE: Late B has only 5.5h → still shows 30m break as good practice ↑
  ],
}

// ─── SUNDAY (dayOfWeek=0) ───────────────────────────────────────────────────
const SUN: DayTemplate = {
  dayOfWeek: 0, dayName: 'Sunday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    2, 2, 2, 2, 3, 3, 3, 2, 2, 1, 3, 4, 4, 4, 4, 3, 2, 3, 3],
  //                                                            ↑ adjusted (Early A on lunch)
  shiftPatterns: [
    // Early A  (8 AM–3 PM, 6 h + 1 h break at noon)
    [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 5 PM–8:30 PM, ~6.5 h, natural break 2–5 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (3 PM–11 PM, 7 h + 1 h break at 7–8 PM)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late B   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
    // Late C   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
  ],
}

// ─── MONDAY (dayOfWeek=1) ───────────────────────────────────────────────────
const MON: DayTemplate = {
  dayOfWeek: 1, dayName: 'Monday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 1, 1, 2, 2, 2, 2, 1, 2, 1, 2, 2, 3, 3, 3, 3, 1, 2, 2],
  shiftPatterns: [
    // Early    (9 AM–4 PM, 6.5 h + 30 m break at 2–2:30)
    [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–3 PM + 6 PM–8:30 PM, ~6 h, natural break 3–6 PM)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
    // Late B   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
  ],
}

// ─── TUESDAY (dayOfWeek=2) ──────────────────────────────────────────────────
const TUE: DayTemplate = {
  dayOfWeek: 2, dayName: 'Tuesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 3, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1],
  shiftPatterns: [
    // Early A  (9 AM–3 PM, 6 h + 30 m break at 11–11:30)
    [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (9 AM–4 PM, 6.5 h + 30 m break at 2–2:30)
    [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–9:30 PM, ~8 h, natural break 2–4 PM — trimmed from 9.5 h)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    // Late     (11 AM–2 PM + 6 PM–11 PM, ~7.5 h, natural break 2–6 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
  ],
}

// ─── WEDNESDAY (dayOfWeek=3) ────────────────────────────────────────────────
const WED: DayTemplate = {
  dayOfWeek: 3, dayName: 'Wednesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
  requiredCoverage: [    0, 2, 2, 3, 3, 3, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 2],
  //                                       ↑ adjusted (Early A on lunch break)
  shiftPatterns: [
    // Early A  (9 AM–4 PM, 6 h + 1 h break at noon)
    [0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 5 PM–8:30 PM, ~6 h, natural break 2–5 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    // Early C  (9 AM–4 PM, 6 h + 30 m break at 2–2:30)
    [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Late A   (4 PM–11 PM, 7 h + 1 h break at 8–9 PM)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1],
    // Late B   (4 PM–11 PM, 6.5 h + 30 m break at 8:30–9)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
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
