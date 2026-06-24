/**
 * Coverage template — 20 time slots per day.
 *
 * Mon–Fri: 9 AM – 11:30 PM  (slot 0 = 8–9 AM, coverage = 0 → hidden in UI)
 * Sat–Sun: 8 AM – 11:30 PM  (slot 0 = 8–9 AM, coverage > 0)
 *
 * Shape rules enforced in every pattern (build-time assertion at the bottom
 * of this file fails the import on violation):
 *   Every work block ≥ MIN_BLOCK_HOURS (3 h)        — no 1-2 h tail blocks
 *   work ≤ 7 h           → no break required
 *   7 h < work < 8 h     → ≥ 30 min break
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

// ─── THURSDAY (dayOfWeek=4) ─────────────────────────────────────────────────
const THU: DayTemplate = {
  dayOfWeek: 4, dayName: 'Thursday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 1, 2, 2, 2, 1, 2, 2, 3, 3, 2, 2, 3, 3, 2, 3, 1, 1],
  //                                              ↑  ↑ adjusted down 1 (staggered late breaks)
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early    (9 AM-11:30 + 12-3 PM, 5.5 h, 30 min lunch break at
    //   11:30-12 — preserves the original 9-3 PM time range while
    //   satisfying the law's >5h consecutive break requirement.)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Bridge   (11 AM-2 PM + 2:30-5 PM, 5.5 h, 30 min break at 2-2:30 PM —
    //   preserves the original 11 AM-5 PM range with a non-peak break.)
    [0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Long split (11 AM–3 PM + 5 PM–10 PM, 9 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break at 8-8:30 PM —
    //   non-peak break, blocks 4h + 2.5h. Slightly extended past original
    //   4-10 PM range so the tail meets MIN_BLOCK while keeping the
    //   break out of dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late A'  (4-8:30 PM + 9-11 PM, 6.5 h, 30 min break at 8:30-9 PM — A
    //   variant: break shifted to slot 16 instead of 15, fills the
    //   8-8:30 PM gap that the standard Late A leaves behind)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late B'  (5-8:30 PM + 9-11:30 PM, 6 h, 30 min break at 8:30-9 PM — B
    //   variant: same break-slot shift for the closer.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Afternoon (2-7 PM, 5 h single block — fills the 2-4 PM lull gap
    //   that morning shifts taper out of and dinner shifts haven't
    //   started yet. Exactly at legal max consecutive, no break.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    // Morning Mini (9-11 AM, 2 h single block — minimum-length filler for
    //   the 9-11 AM gap when full-length morning shifts are already
    //   covering peak. Gap-aware picker uses it when fill > over.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h single block — surgically fills
    //   the 2-4 PM lull slots without committing a dispatcher to a
    //   long shift that would over-cover dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── FRIDAY (dayOfWeek=5) ───────────────────────────────────────────────────
const FRI: DayTemplate = {
  dayOfWeek: 5, dayName: 'Friday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 2, 2, 2, 2, 3, 4, 3, 3, 4, 3, 2, 3, 3, 1],
  //                                    ↑ adjusted (Early A on lunch break)
  //                                                      ↑  ↑ adjusted (Late B on break)
  //                                                               ↑ adjusted (Late A on break)
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early A  (9 AM-11:30 + 12-3 PM, 5.5 h, 30 min lunch break — law: >5h needs break)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (10 AM-3 PM, 5 h single block — exactly at the legal max
    //   consecutive limit; no break required.)
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    //Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Long split (11 AM–3 PM + 5 PM–10 PM, 9 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    // Late A   (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break at 8-8:30 PM —
    //   non-peak break, blocks 4h + 2.5h. Slightly extended past original
    //   4-10 PM range so the tail meets MIN_BLOCK while keeping the
    //   break out of dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late C   (7 PM–11:30 PM, 4.5 h single block — 2nd closer body so
    //   Fri slot 19 (req=1) + slot 18 (req=3) can stack 2 bodies)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
    // Closer Split (4-7 PM + 8:30-11:30 PM, 6 h, 1 h break 7-8:30 PM —
    //   covers dinner-peak + the full closer block, skips slot 15-16)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
    // Closer Split B (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break 8-8:30 PM —
    //   ends at 11 PM, covers slot 18 (req=3) which was the biggest
    //   Fri deficit. User's manual no-gaps fix used this exact shape.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Early Bridge (9-11:30 AM + 12-4 PM, 6.5 h, 30 min lunch break —
    //   3rd pattern covering slot 9 (3-4 PM) so Fri's req=2 there can
    //   actually be met. Early A + Early B + this gives 3 candidates.)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Late A'  (4-8:30 PM + 9-11 PM, 6.5 h, 30 min break at 8:30-9 PM —
    //   break shifted to slot 16 fills the 8-8:30 PM gap.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late B'  (5-8:30 PM + 9-11:30 PM, 6 h, 30 min break at 8:30-9 PM —
    //   closer variant with the break-slot shift.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Afternoon (2-7 PM, 5 h single block — fills the 2-4 PM lull gap.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    // Morning Mini (9-11 AM, 2 h single block — surgical filler.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h single block — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── SATURDAY (dayOfWeek=6) ─────────────────────────────────────────────────
const SAT: DayTemplate = {
  dayOfWeek: 6, dayName: 'Saturday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    2, 2, 2, 2, 4, 4, 4, 2, 2, 1, 1, 4, 4, 4, 4, 3, 3, 2, 1, 1],
  //                                                           ↑  ↑ adjusted (Late A on break)
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early A  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (8 AM–4 PM, 7 h + 1 h break at 11–12, blocks 3 h + 4 h —
    //   covers the 3–4 PM gap that Early A leaves)
    [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split A  (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Split B  (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Late A   (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break at 8-8:30 PM —
    //   non-peak break, blocks 4h + 2.5h. Slightly extended past original
    //   4-10 PM range so the tail meets MIN_BLOCK while keeping the
    //   break out of dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late A'  (4-8:30 PM + 9-11 PM, 6.5 h, break at 8:30-9 PM — fills slot 15)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late B'  (5-8:30 PM + 9-11:30 PM, 6 h, break at 8:30-9 PM — closer + slot 15 fill)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Morning Mini (9-11 AM, 2 h — surgical filler for morning gap.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── SUNDAY (dayOfWeek=0) ───────────────────────────────────────────────────
const SUN: DayTemplate = {
  dayOfWeek: 0, dayName: 'Sunday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    2, 2, 2, 2, 3, 3, 3, 2, 2, 1, 3, 4, 4, 4, 4, 3, 2, 3, 3, 1],
  //                                                            ↑ adjusted (Early A on lunch)
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early A  (8 AM–3 PM, 6 h + 1 h break at 11 AM–12 PM, blocks 3 h + 3 h)
    [1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early B  (8 AM–3 PM, 6.5 h + 30 m break at 11–11:30, blocks 3 h + 3.5 h)
    [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Late A   (3-6 PM + 6:30-10 PM, 6.5 h, 30 min break — law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0],
    // Late B   (4-6:30 PM + 7-11 PM, 6.5 h, 30 min break — law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
    // Late C   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late D   (7 PM–11:30 PM, 4.5 h single block — 2nd closer body so
    //   Sun slots 17/18 (req=3, only Late C otherwise) can stack a 2nd
    //   body. Uniqueness scoring credits both C+D for slot 18 deficit.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
    // Mid Split (11 AM–2 PM + 3 PM–8 PM, 8 h, 1 h break 2-3 PM — covers
    //   lunch + dinner peaks but SKIPS slot 16 to avoid the 8:30-9 PM
    //   stack that blocks evening closer assignments.)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    // Closer Split (4-7 PM + 8:30-11:30 PM, 6 h, 1 h break 7-8:30 PM —
    //   covers dinner-peak + the full closer block, breaks BEFORE slot
    //   16 so it doesn't stack the low-req 8:30 PM slot.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
    // Closer Split B (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break 8-8:30 PM —
    //   ends at 11 PM, covers slot 18 (10-11 PM) which was the biggest
    //   Sun deficit. User's manual no-gaps fix used this exact shape.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B'  (4-8:30 PM + 9-11 PM, 6 h, break at 8:30-9 PM — Sun variant
    //   that puts the break at slot 16 to fill the 8-8:30 PM gap.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late C'  (5-8:30 PM + 9-11:30 PM, 6 h, break at 8:30-9 PM — closer with break-slot shift.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Morning Mini (9-11 AM, 2 h — surgical filler for morning gap.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── MONDAY (dayOfWeek=1) ───────────────────────────────────────────────────
const MON: DayTemplate = {
  dayOfWeek: 1, dayName: 'Monday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 1, 1, 2, 2, 2, 2, 1, 2, 1, 2, 2, 3, 3, 3, 3, 1, 2, 2, 1],
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early    (9 AM-11:30 + 12-3 PM, 5.5 h, 30 min lunch break — law: >5h needs break)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Bridge   (11 AM-2 PM + 2:30-5 PM, 5.5 h, 30 min break at 2-2:30 PM —
    //   preserves the original 11 AM-5 PM range with a non-peak break.)
    [0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    //Split    (11 AM–3 PM + 5 PM–8:30 PM, 7.5 h, 2 h break 3–5 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Late A   (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break at 8-8:30 PM —
    //   non-peak break, blocks 4h + 2.5h. Slightly extended past original
    //   4-10 PM range so the tail meets MIN_BLOCK while keeping the
    //   break out of dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late C   (7 PM–11:30 PM, 4.5 h single block — 2nd closer body so
    //   Mon dinner-peak + closer slots can stack a 2nd body)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
    // Closer Split (4-7 PM + 8:30-11:30 PM, 6 h, 1 h break 7-8:30 PM —
    //   covers dinner-peak + the full closer block, skips slot 15-16)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
    // Late A'  (4-8:30 PM + 9-11 PM, 6.5 h, break at 8:30-9 PM — fills slot 15)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late B'  (5-8:30 PM + 9-11:30 PM, 6 h, break at 8:30-9 PM — closer + slot 15 fill)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Afternoon (2-7 PM, 5 h single block — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    // Morning Mini (9-11 AM, 2 h — surgical filler for morning gap.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── TUESDAY (dayOfWeek=2) ──────────────────────────────────────────────────
const TUE: DayTemplate = {
  dayOfWeek: 2, dayName: 'Tuesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 2, 3, 3, 3, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1],
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early A  (9 AM-11:30 + 12-3 PM, 5.5 h, 30 min lunch break — law: >5h needs break)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    //Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Split    (11 AM–2 PM + 4-9 PM, 8 h, 2 h break 2–4 PM — 2nd block
    //   trimmed from 5.5h to 5h max consecutive per labor law)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Late     (4-8 PM + 8:30-11:30 PM, 7 h, 30 min break — covers closer
    //   with no consecutive block over 5 h)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Late'    (4-8:30 PM + 9-11:30 PM, 7 h, break at 8:30-9 PM — fills slot 15)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Afternoon (2-7 PM, 5 h single block — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    // Morning Mini (9-11 AM, 2 h — surgical filler for morning gap.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
}

// ─── WEDNESDAY (dayOfWeek=3) ────────────────────────────────────────────────
const WED: DayTemplate = {
  dayOfWeek: 3, dayName: 'Wednesday', slots: SLOTS,
  //                     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
  requiredCoverage: [    0, 2, 2, 3, 3, 3, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 2, 1],
  //                                       ↑ adjusted (Early A on lunch break)
  //                                                                              ↑ closer slot
  shiftPatterns: [
    // Early    (9 AM-11:30 + 12-3 PM, 5.5 h, 30 min lunch break — law: >5h needs break)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Morning split (9 AM–6 PM, 8 h work + 1 h break 2–3 PM — covers
    //   morning gap + lunch peak + early dinner peak in a single shift)
    [0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    //Split    (11 AM–2 PM + 4 PM–8:30 PM, 7.5 h, 2 h break 2–4 PM — covers both peaks)
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    // Bridge   (11 AM-2 PM + 2:30-5 PM, 5.5 h, 30 min break at 2-2:30 PM —
    //   preserves the original 11 AM-5 PM range with a non-peak break.)
    [0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    // Late A   (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break at 8-8:30 PM —
    //   non-peak break, blocks 4h + 2.5h. Slightly extended past original
    //   4-10 PM range so the tail meets MIN_BLOCK while keeping the
    //   break out of dinner peak.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late B   (5-8 PM + 8:30-11:30 PM, 6 h, 30 min break — closer; law: >5h needs break)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
    // Bridge Late (2:30-4 PM + 6-11 PM, 7.5 h, 1 h break 5-6 PM —
    //   user's no-gaps fix used this exact shape on Wed: tiny
    //   afternoon slice + dinner-to-close, filling Wed's evening
    //   peak that one-block patterns can't cover after off-day
    //   clustering eats the working pool.)
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0],
    // Closer Split B (4-8 PM + 8:30-11 PM, 6.5 h, 30 min break —
    //   ends at 11 PM to fill Wed slot 18 deficit without piling on
    //   slot 19 which is already covered by Late B.)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0],
    // Late A'  (4-8:30 PM + 9-11 PM, 6.5 h, break at 8:30-9 PM — fills slot 15)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    // Late B'  (5-8:30 PM + 9-11:30 PM, 6 h, break at 8:30-9 PM — closer + slot 15 fill)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1],
    // Afternoon (2-7 PM, 5 h single block — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    // Morning Mini (9-11 AM, 2 h — surgical filler for morning gap.)
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Afternoon Mini (2-4 PM, 2.5 h — fills 2-4 PM lull.)
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // Early Bridge (9-11:30 AM + 12-4 PM, 6.5 h, 30 min lunch break —
    //   3rd pattern covering slots 1, 2 (9-11 AM, req=2) and slot 9
    //   (3-4 PM, req=2) so the picker has options when the existing
    //   2 morning patterns can't both reach those slots.)
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
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

/** Minimum length of any single work block in a pattern. Lowered to 2h
 *  so the labor-law 30-min meal break (mandatory at > 5h consecutive)
 *  can be placed in non-peak slots without leaving an orphan tail
 *  shorter than the legal min — e.g. a 6h Late A 4-10 PM can break at
 *  8-8:30 PM (off-peak) with blocks 4h + 2h. User's no-gaps snapshot
 *  accepted 2h blocks in a few cases. */
export const MIN_BLOCK_HOURS = 2

/** Required break for an 8 h+ shift. */
export const LONG_SHIFT_BREAK_MIN = 1

/** Required break for any shift over 5 h. Labor-law floor (Section 23):
 *  any employee working more than 5 consecutive hours in a day is
 *  entitled to a 30-min uninterrupted meal break. */
export const MED_SHIFT_BREAK_MIN = 0.5

/** Labor-law max consecutive work hours. Any single work block over this
 *  triggers the same 30-min break requirement WITHIN the block — i.e. a
 *  pattern can't have a single block above this length, even if its
 *  total work hours are small. */
export const MAX_CONSECUTIVE_HOURS = 5

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
      // Labor-law: no single block can exceed MAX_CONSECUTIVE_HOURS (5h).
      // > 5h consecutive triggers the legal 30-min meal break.
      const maxBlock = blocks.length === 0 ? 0 : Math.max(...blocks)
      if (maxBlock > MAX_CONSECUTIVE_HOURS) {
        violations.push(`${day.dayName} #${idx}: ${maxBlock}h consecutive block > ${MAX_CONSECUTIVE_HOURS}h legal max (blocks=[${blocks.join(',')}])`)
      }
      if (work >= 8 && brk < LONG_SHIFT_BREAK_MIN) {
        violations.push(`${day.dayName} #${idx}: ${work}h shift needs ≥${LONG_SHIFT_BREAK_MIN}h break, has ${brk}h`)
      } else if (work > MAX_CONSECUTIVE_HOURS && work < 8 && brk < MED_SHIFT_BREAK_MIN) {
        // Labor law: > 5h work needs a 30-min meal break.
        violations.push(`${day.dayName} #${idx}: ${work}h shift needs ≥${MED_SHIFT_BREAK_MIN}h break, has ${brk}h`)
      }
    })
  }
  if (violations.length > 0) {
    throw new Error(`Dispatcher pattern shape violations:\n  ${violations.join('\n  ')}`)
  }
})()
