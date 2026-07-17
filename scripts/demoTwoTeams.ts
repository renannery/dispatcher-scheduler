/**
 * Verify the two-team (Morning/Evening) restructure on the 11-week window
 * with the 7-dispatcher production roster. PASS/FAIL gates:
 *
 *   Gate S — shape (Cayman salaried law, no hard 5h cap): every emitted
 *            shift has ≤2 stretches; a block may exceed 5h up to the 9h
 *            daily max; a shift >5h carries one 30-min paid break placed
 *            in a demand trough (post-lunch/post-dinner), never in a peak;
 *            first stretch ≥3h; work ≤9h; every Mon–Fri shift has a ≥4h
 *            primary stretch.
 *   Gate H — hours: no dispatcher exceeds the 45h weekly cap; report
 *            evening-shift counts (should be ≤4/week each).
 *   Gate O — handoff: every day that has an evening shift either has a
 *            morning shift covering the 15:00 handoff slot OR carries a
 *            `handoff` warning (no silent cold starts).
 *
 * Also reports: per-day-of-week team sizes, warning counts by kind, and
 * the expected structural shortfalls (Sat, 2–2:30 PM, evening breaks).
 *
 * Run with: npx tsx scripts/demoTwoTeams.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher } from '@/types/schedule'
import {
  BREAK_TROUGH_SLOTS,
  CLOSER_END_SLOT,
  CLOSER_PRIMARY_STRETCH_HOURS,
  HANDOFF_SLOT,
  MEAL_BREAK_TRIGGER_HOURS,
  MEAL_BREAK_HOURS,
  midShiftBreakSlots,
  MIN_BLOCK_HOURS,
  MIN_SPLIT_BLOCK_HOURS,
  MIN_TOTAL_SHIFT_HOURS,
  PEAK_SLOT_INDICES,
  SPLIT_GAP_MIN_HOURS,
  SPLIT_GAP_MAX_HOURS,
  SPLIT_GAP_SLOTS,
  WEEKDAY_PRIMARY_STRETCH_HOURS,
  patternMaxBreakHours,
  patternWorkBlocks,
  SLOTS,
} from '@/data/coverageTemplate'

const roster: Dispatcher[] = [
  { id: 'd1', name: 'Ayrton',   color: '#ef4444', level: 'Senior'  },
  { id: 'd2', name: 'Adorre',   color: '#f97316', level: 'Regular' },
  { id: 'd3', name: 'Kimberly', color: '#eab308', level: 'Regular' },
  { id: 'd4', name: 'Michelle', color: '#22c55e', level: 'Regular' },
  { id: 'd5', name: 'Paula',    color: '#06b6d4', level: 'Regular' },
  { id: 'd6', name: 'Resgie',   color: '#3b82f6', level: 'Trainee' },
  { id: 'd7', name: 'Shamika',  color: '#a855f7', level: 'Trainee' },
]

const schedule = generateSchedule(roster, '2026-06-25', '2026-09-09', {}, 42)
const isWeekendDow = (dow: number) => dow === 0 || dow === 6
const DOW_NAMES: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' }

// ── Production-config fixture — a PHOTO of the REAL config the team runs, made
// a permanent gate fixture (updated whenever the live operation changes). The
// leaks that motivated it (Kimberly, Adorre, the 12–2 PM weekend split, the
// Jul 22 missed staircase) all slipped the synthetic scenarios and only
// surfaced on the actual roster: recurringBlocks (personal fixed days off) +
// the team's weekend-peaked overrides + the live seed. Refreshed to the current
// operation: adorre/shamika are now FULL-DAY blocks (their Saturday partials
// were removed), and the live seed is 94.
const fullDay = () => new Array(20).fill(true)
const openDay = () => new Array(20).fill(false)
const prodRoster: Dispatcher[] = [
  { id: 'mq1uenf', name: 'adorre',   color: '#ec4899', level: 'Regular', recurringBlocks: [openDay(), openDay(), openDay(), fullDay(), fullDay(), openDay(), openDay()] }, // Wed+Thu full
  { id: '0gjtabx', name: 'ayrton',   color: '#3b82f6', level: 'Senior',  recurringBlocks: [fullDay(), openDay(), fullDay(), openDay(), openDay(), openDay(), openDay()] }, // Sun+Tue
  { id: 'fmvecxr', name: 'kimberly', color: '#ef4444', level: 'Senior',  recurringBlocks: [openDay(), fullDay(), openDay(), openDay(), openDay(), fullDay(), openDay()] }, // Mon+Fri
  { id: 'xb9f7rj', name: 'michelle', color: '#06b6d4', level: 'Senior',  recurringBlocks: [openDay(), openDay(), openDay(), fullDay(), openDay(), openDay(), fullDay()] }, // Wed+Sat
  { id: '75pmgeu', name: 'paula',    color: '#8b5cf6', level: 'Senior',  recurringBlocks: [openDay(), fullDay(), openDay(), openDay(), openDay(), openDay(), fullDay()] }, // Mon+Sat
  { id: 'zfqp9my', name: 'resgie',   color: '#f59e0b', level: 'Regular', recurringBlocks: [openDay(), openDay(), fullDay(), openDay(), fullDay(), openDay(), openDay()] }, // Tue+Thu
  { id: 'foczori', name: 'shamika',  color: '#ec4899', level: 'Trainee', recurringBlocks: [openDay(), fullDay(), openDay(), openDay(), openDay(), openDay(), openDay()] }, // Mon full
]
// The team's actual weekend-peaked overrides (from the live snapshots) — higher
// weekday baseline than the old synthetic profile, dinner-peaked on Fri/Sun.
const prodOverrides: Record<number, number[]> = {
  0: [1, 2, 2, 1, 2, 2, 3, 1, 2, 2, 2, 3, 3, 3, 3, 2, 2, 3, 1, 1],
  1: [0, 2, 2, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1],
  2: [0, 2, 2, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1],
  3: [0, 2, 2, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1],
  4: [0, 2, 2, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 2, 1, 1],
  5: [0, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3, 2, 2, 1, 1],
  6: [1, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2, 1, 1],
}
const PROD_SEED = 94 // live weekendRotationOffset(92) + regen(2)
const prodSchedule = generateSchedule(prodRoster, '2026-07-16', '2026-08-05', {}, PROD_SEED, prodOverrides, 101)
// No-staircase baselines (applyStaircase = false) for the FIFO gate diff.
// Gate T isolates the STAIRCASE pass, so both of its sides run with trainee
// supervision OFF. Diffing a staircase-on run against a staircase-off run
// while a LATER pass reshuffles bodies in both measures that later pass's
// noise, not the staircase: supervision legitimately lands different bodies
// in each run, and the diff reads those as the staircase worsening slots it
// never touched. Gate U below owns supervision, diffed against its own
// no-supervision baseline. One pass per gate, one baseline per pass.
// Gate U's own baseline: identical inputs, supervision OFF.
const noSup = generateSchedule(roster, '2026-06-25', '2026-09-09', {}, 42, {}, 0, true, true, false)
const prodNoSup = generateSchedule(prodRoster, '2026-07-16', '2026-08-05', {}, PROD_SEED, prodOverrides, 101, true, true, false)
const stairOn = generateSchedule(roster, '2026-06-25', '2026-09-09', {}, 42, {}, 0, true, true, false)
const stairOff = generateSchedule(roster, '2026-06-25', '2026-09-09', {}, 42, {}, 0, false, true, false)
const prodStairOn = generateSchedule(prodRoster, '2026-07-16', '2026-08-05', {}, PROD_SEED, prodOverrides, 101, true, true, false)
const prodStairOff = generateSchedule(prodRoster, '2026-07-16', '2026-08-05', {}, PROD_SEED, prodOverrides, 101, false, true, false)

// ── Gate S: emitted shift shapes (asserted on BOTH schedules) ───────────
function collectShapeViolations(sch: typeof schedule): string[] {
  const out: string[] = []
  for (const ds of sch.dispatcherSchedules) {
    for (const day of ds.days) {
      if (day.isOff) continue
      const blocks = patternWorkBlocks(day.slots, SLOTS)
      if (blocks.length === 0) continue
      const brk = patternMaxBreakHours(day.slots, SLOTS)
      const work = blocks.reduce((s, h) => s + h, 0)
      const problems: string[] = []
      // Trainees never work split shifts. The ONLY legal exception is a split
      // RETAINED because it was the only way to hold a peak at target — and it
      // must carry the `trainee-split` flag (the operational rule yielding to
      // the inviolable peak tier, surfaced never silent). An unflagged trainee
      // split is a hard FAIL, whatever path produced it.
      if (ds.dispatcher.level === 'Trainee' && blocks.length === 2 && brk >= SPLIT_GAP_MIN_HOURS) {
        const retained = (sch.coverageWarnings?.[day.date] ?? []).some((w) => w.peak === 'trainee-split')
        if (!retained) problems.push(`Trainee split (gap ${brk}h), UNFLAGGED — Trainees work continuous shifts only`)
      }
      if (blocks.length > 2) problems.push(`${blocks.length} stretches`)
      if (blocks.length === 2 && brk !== MEAL_BREAK_HOURS) {
        // Split exception: a 2–3h lull gap; both legs ≥ MIN_SPLIT_BLOCK_HOURS
        // (3h) — a 2h leg beside a multi-hour split gap is forbidden.
        const gap = midShiftBreakSlots(day.slots)
        const isSplit =
          brk >= SPLIT_GAP_MIN_HOURS && brk <= SPLIT_GAP_MAX_HOURS &&
          gap.every((s) => (SPLIT_GAP_SLOTS as readonly number[]).includes(s)) &&
          blocks[0] >= MIN_SPLIT_BLOCK_HOURS && blocks[1] >= MIN_SPLIT_BLOCK_HOURS
        if (!isSplit) problems.push(`break ${brk}h ≠ ${MEAL_BREAK_HOURS}h and not a legal split (legs must be ≥${MIN_SPLIT_BLOCK_HOURS}h)`)
      }
      if (blocks[0] < MIN_BLOCK_HOURS) problems.push(`first stretch ${blocks[0]}h < ${MIN_BLOCK_HOURS}h`)
      // A sub-5h shift is only legal as the flagged constrained-window exception.
      const constrainedExempt = (sch.coverageWarnings?.[day.date] ?? []).some((w) => w.peak === 'constrained-shift')
      if (work < MIN_TOTAL_SHIFT_HOURS && !constrainedExempt)
        problems.push(`${work}h total < ${MIN_TOTAL_SHIFT_HOURS}h min shift`)
      if (work > MEAL_BREAK_TRIGGER_HOURS && blocks.length < 2) problems.push(`${work}h (>5h) no meal break`)
      if (work > MEAL_BREAK_TRIGGER_HOURS && blocks.length === 2 && brk === MEAL_BREAK_HOURS) {
        const bslot = midShiftBreakSlots(day.slots)
        if (bslot.some((s) => PEAK_SLOT_INDICES.includes(s))) problems.push(`break in peak (slots ${bslot.join(',')})`)
        else if (!bslot.every((s) => BREAK_TROUGH_SLOTS.has(s))) problems.push(`break not in trough (slots ${bslot.join(',')})`)
      }
      if (work > 9) problems.push(`${work}h > 9h`)
      // Closers (last worked slot ends ≥ 10 PM) carry the reduced 3h primary
      // floor — the FIFO/staircase exemption that lets the LATEST arrival
      // legally close; every other weekday shift keeps the 4h primary.
      const lastOn = day.slots.reduce((acc, on, i) => (on ? i : acc), -1)
      const primaryFloor = lastOn >= CLOSER_END_SLOT ? CLOSER_PRIMARY_STRETCH_HOURS : WEEKDAY_PRIMARY_STRETCH_HOURS
      if (!isWeekendDow(day.dayOfWeek) && Math.max(...blocks) < primaryFloor) problems.push(`no ${primaryFloor}h primary (weekday${lastOn >= CLOSER_END_SLOT ? ' closer' : ''})`)
      if (problems.length > 0) out.push(`${ds.dispatcher.name} ${day.date}: ${problems.join('; ')} (blocks=[${blocks.join(',')}])`)
    }
  }
  return out
}
const mainViol = collectShapeViolations(schedule)
const prodViol = collectShapeViolations(prodSchedule)
const gateSFail = mainViol.length + prodViol.length
const shapeViolations = [...mainViol.slice(0, 4), ...prodViol.map((v) => `[prod-config] ${v}`).slice(0, 4)]
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Gate S — two-team shift shapes on every emitted shift')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  synthetic roster: ${mainViol.length} · prod-config fixture (recurringBlocks + weekend-peaked, seed ${PROD_SEED}): ${prodViol.length}`)
console.log(`  Violations: ${gateSFail}${gateSFail === 0 ? ' ✓' : ' ← FAIL'}`)
for (const v of shapeViolations) console.log(`    ${v}`)

// ── Gate H: weekly hours + evening counts ───────────────────────────────
let gateHFail = 0
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate H — weekly hours ≤ 45h; evening shifts per week ≤ 4')
console.log('══════════════════════════════════════════════════════════════════════')
for (const ds of schedule.dispatcherSchedules) {
  const weeks = Object.entries(ds.weeklyHours)
  const maxWk = Math.max(0, ...weeks.map(([, h]) => h))
  // Evening shifts per week (first worked slot ≥ HANDOFF_SLOT).
  const evByWeek = new Map<string, number>()
  for (const day of ds.days) {
    if (day.isOff) continue
    const wl = schedule.dates.find((d) => d.date === day.date)?.weekLabel ?? ''
    if (day.slots.findIndex(Boolean) >= HANDOFF_SLOT) {
      evByWeek.set(wl, (evByWeek.get(wl) ?? 0) + 1)
    }
  }
  const maxEv = Math.max(0, ...evByWeek.values())
  const capFlag = maxWk > 45 ? ' ← FAIL >45h' : ' ✓'
  if (maxWk > 45) gateHFail++
  console.log(`  ${ds.dispatcher.name.padEnd(10)} peak week ${maxWk.toFixed(1).padStart(5)}h · max evenings/wk ${maxEv}${capFlag}`)
}
console.log(`  → ${gateHFail === 0 ? 'PASS' : 'FAIL'}`)

// ── Gate O: lean transition — 3–4 PM never piles past target + 2 ───────
// There is no scheduled handoff overlap (incoming dispatchers arrive
// ~10 min early, off-schedule). The 3–4 PM slot must sit at its
// coverage target, tolerating at most the picker's req+2 over-cap tier.
let gateOFail = 0
let worstOver = 0
let worstOverDate = ''
for (const dInfo of schedule.dates) {
  const req = schedule.coverageRequired?.[dInfo.date]?.[HANDOFF_SLOT] ?? 0
  const act = schedule.coverageActual[dInfo.date]?.[HANDOFF_SLOT] ?? 0
  const over = act - req
  if (over > worstOver) { worstOver = over; worstOverDate = dInfo.date }
  if (over > 2) gateOFail++
}
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate O — lean 3–4 PM transition (actual ≤ required + 2 every day)')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  Days over target+2 at 3–4 PM: ${gateOFail}${gateOFail === 0 ? ' ✓' : ' ← FAIL'}`)
console.log(`  Worst 3–4 PM surplus: +${worstOver}${worstOverDate ? ` on ${worstOverDate}` : ''}`)

// ── Team sizes by day-of-week (first full week) ─────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Team sizes per day (first full week) — morning / evening / off')
console.log('══════════════════════════════════════════════════════════════════════')
for (const dInfo of schedule.dates.slice(0, 7)) {
  let m = 0, e = 0, off = 0
  for (const ds of schedule.dispatcherSchedules) {
    const day = ds.days.find((x) => x.date === dInfo.date)
    if (!day || day.isOff) { off++; continue }
    if (day.slots.findIndex(Boolean) >= HANDOFF_SLOT) e++
    else m++
  }
  console.log(`  ${dInfo.date} ${DOW_NAMES[dInfo.dayOfWeek]}: ${m}M / ${e}E / ${off} off`)
}

// ── Split usage + 2nd-day-off report ────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Mon–Wed splits + 2nd days off per week')
console.log('══════════════════════════════════════════════════════════════════════')
const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]
const isSplitShift = (slots: boolean[]) =>
  patternMaxBreakHours(slots, SLOTS) >= SPLIT_GAP_MIN_HOURS
let totalSecondOffs = 0
const secondOffByName = new Map<string, number>()
for (const wl of weekLabels) {
  const weekDates = new Set(schedule.dates.filter((d) => d.weekLabel === wl).map((d) => d.date))
  if (weekDates.size < 7) continue // partial edge weeks skew the count
  let splits = 0
  const twoOff: string[] = []
  for (const ds of schedule.dispatcherSchedules) {
    const days = ds.days.filter((d) => weekDates.has(d.date))
    splits += days.filter((d) => !d.isOff && isSplitShift(d.slots)).length
    const off = days.filter((d) => d.isOff).length
    if (off >= 2) {
      twoOff.push(`${ds.dispatcher.name}(${off})`)
      totalSecondOffs += off - 1
      secondOffByName.set(ds.dispatcher.name, (secondOffByName.get(ds.dispatcher.name) ?? 0) + (off - 1))
    }
  }
  console.log(`  ${wl}: splits=${splits} · 2-off: ${twoOff.length ? twoOff.join(', ') : '—'}`)
}
console.log(`  Total 2nd days off granted: ${totalSecondOffs}`)
console.log(`  Distribution: ${[...secondOffByName.entries()].map(([n, c]) => `${n}:${c}`).join(' ') || '—'}`)

// ── Warning counts by kind ──────────────────────────────────────────────
const counts: Record<string, number> = {}
for (const ws of Object.values(schedule.coverageWarnings ?? {})) {
  for (const w of ws) counts[w.peak] = (counts[w.peak] ?? 0) + 1
}
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Warning counts across 11-week horizon')
console.log('══════════════════════════════════════════════════════════════════════')
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)

// ── Gate T — FIFO / staircase (the latest evening arrival closes) ───────
// Asserted on BOTH the synthetic roster and the prod-config fixture, each
// diffed against its own no-staircase baseline:
//   • closing-band envelope inversions strictly DROP vs baseline, and every
//     one that remains carries an `envelope` flag (0 silent) — the fatigue
//     shape is fixed or surfaced, never hidden;
//   • the pass worsens NO slot vs baseline except the 8–9 PM shoulder
//     (slots 15/16), which may fall by at most 1 (never below target−1),
//     and every such dip is flagged — the bounded, flagged −1 the governance
//     change permits solely to dissolve an envelope.
//
// EXEMPTION BY PROVENANCE, never by tolerance: the 8–9 PM shoulder may go a
// second unit down ONLY on a slot carrying a `supervisionConcessions` record —
// the governance line that lets the shoulder reach 1 body when that is what
// buys a Trainee a fully Senior-supervised window. The threshold below is
// untouched; an unmarked target−2 dip fails exactly as it always did, which
// `gateTNegative` proves by planting one.
const STAIRCASE_SHOULDER = new Set([15, 16])
function presencesT(slots: boolean[]): Array<{ start: number; end: number }> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < slots.length;) {
    if (!slots[i]) { i++; continue }
    let j = i; while (j + 1 < slots.length && slots[j + 1]) j++
    runs.push([i, j]); i = j + 1
  }
  if (!runs.length) return []
  const merged: Array<[number, number]> = [runs[0]]
  for (let k = 1; k < runs.length; k++) {
    const p = merged[merged.length - 1]
    let g = 0; for (let s = p[1] + 1; s <= runs[k][0] - 1; s++) g += SLOTS[s].hours
    if (g < SPLIT_GAP_MIN_HOURS) merged[merged.length - 1] = [p[0], runs[k][1]]
    else merged.push(runs[k])
  }
  return merged.map(([a, b]) => ({ start: a, end: b }))
}
function closingBandT(sch: typeof schedule, date: string): number {
  const ps: Array<{ start: number; end: number }> = []
  for (const ds of sch.dispatcherSchedules) {
    const day = ds.days.find((d) => d.date === date)
    if (day && !day.isOff) ps.push(...presencesT(day.slots))
  }
  let n = 0
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    let e = ps[i], l = ps[j]
    if (l.start < e.start) { e = ps[j]; l = ps[i] } else if (ps[i].start === ps[j].start) continue
    if (e.end > l.end && e.end >= 16) n++ // enveloper ends ≥ 9 PM
  }
  return n
}
function gateT(name: string, withS: typeof schedule, base: typeof schedule): boolean {
  let totWith = 0, totBase = 0, silent = 0, deep = 0, worsened = 0
  for (const dInfo of withS.dates) {
    const date = dInfo.date
    const conceded = (s: number) => (withS.supervisionConcessions?.[date] ?? []).some((c) => c.slot === s)
    const cW = closingBandT(withS, date), cB = closingBandT(base, date)
    totWith += cW; totBase += cB
    if (cW > 0 && !(withS.coverageWarnings?.[date] ?? []).some((w) => w.peak === 'envelope')) silent++
    const req = withS.coverageRequired?.[date] ?? []
    const a = withS.coverageActual[date] ?? [], b = base.coverageActual[date] ?? []
    for (let s = 0; s < 20; s++) {
      if (STAIRCASE_SHOULDER.has(s)) {
        if ((a[s] ?? 0) < (req[s] ?? 0) - 1 && !conceded(s)) deep++   // never below target−1 unless bought
        if ((a[s] ?? 0) < (b[s] ?? 0) - 1 && !conceded(s)) worsened++  // never more than −1 vs baseline
      } else if ((a[s] ?? 0) < (b[s] ?? 0)) worsened++          // non-shoulder never worsens
    }
  }
  const pass = silent === 0 && deep === 0 && worsened === 0 && totWith < totBase
  console.log(`  ${name.padEnd(16)} closing-band ${totBase}→${totWith} · silent ${silent} · shoulder<t−1 ${deep} · worsened-vs-baseline ${worsened} ${pass ? '✓' : '← FAIL'}`)
  return pass
}
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate T — FIFO/staircase: closing-band ↓ (0 silent) · only 8–9 PM shoulder −1, flagged')
console.log('══════════════════════════════════════════════════════════════════════')
const gateTPass = gateT('synthetic', stairOn, stairOff) && gateT('prod-config', prodStairOn, prodStairOff)
const gateTFail = gateTPass ? 0 : 1


// ── Gate U — trainee supervision (the one rule) ─────────────────────────
// A Trainee requires SENIOR concurrency. One conditioned exception: up to
// 1.5h without a Senior, and only while a Regular is actively working
// alongside her. "Alone" (no Senior AND no Regular) is the same rule's
// hardest violation — illegal at any duration, yielding only to never-zero,
// and then only FLAGGED.
//
//   U1 — a Trainee alone with no flag = hard fail (flagged = surfaced, legal)
//   U2 — Regular-only bridge > 1.5h contiguous OR > 1.5h daily = hard fail
//   U3 — over-coverage the pass added carries a supervisionSlots mark naming
//        the guardian, and that guardian must actually WORK the slot;
//        unmarked over-coverage is NOT exempt anywhere
//   U4 — a shoulder dip below target−1 carries a supervisionConcessions
//        record; unmarked = hard fail; and the Trainee is never the last body
//        standing at a conceded slot (that would recreate the alone it bought)
//   U5 — the pass never worsens a non-shoulder slot vs the no-supervision
//        baseline, and never shrinks a Trainee's hours or days
//
// SCOPE, stated plainly rather than hidden in an exemption: U2 is hard-asserted
// on SINGLE-Trainee rosters — the shape the rule was written for and the shape
// the live operation has. The synthetic fixture is a coverage-shape stressor
// with one Senior for two Trainees: it is arithmetically unsupervisable (its
// lone Senior has 476h against 816h of Trainee hours needing concurrent cover,
// and works 14 days on which a Trainee works and no Senior is rostered at all).
// Asserting U2 there would assert a fiction, and reshaping the fixture until it
// passed would be fixture-shopping. So on multi-Trainee rosters U2 is REPORTED,
// not asserted — while U1/U3/U4/U5 stay hard on every roster, because
// provenance, surfacing and never-shrink hold regardless of arithmetic.
//
// THIS SCOPE IS TEMPORARY, and the exit is designed (see the MULTI-TRAINEE
// ladder on enforceTraineeSupervision): distribute 1:1 into different Seniors'
// windows → prefer one Trainee on senior-thin days → GROUP the cohort into one
// shared Senior-supervised window → flagged. Under that ladder the multi-
// Trainee case becomes ASSERTABLE, and this note must be replaced by the real
// assertion: every Trainee is either senior-paired, the sole Trainee that day,
// grouped-supervised, or flagged — no fifth outcome. Grouping is what makes it
// assertable: supervision demand collapses to one window per cohort, so the
// arithmetic that defeats the 1-Senior/2-Trainee fixture today (two windows
// needing concurrent cover from one body) stops being the question asked.
// When a second Trainee is rostered for real, build the ladder and tighten
// this — do not quietly keep the exemption.

const SUP_BRIDGE = 1.5
const SHOULDER_U = new Set([15, 16])
function gateU(name: string, withSup: typeof schedule, noSup: typeof schedule): boolean {
  let aloneUnflagged = 0, bridgeFail = 0, unmarkedOver = 0, unmarkedDeep = 0, soleTrainee = 0, worsened = 0, shrunk = 0
  let unsupervisable = 0, silentOnExempt = 0, bridgeReport = 0
  const trainees = withSup.dispatcherSchedules.filter((d) => d.dispatcher.level === 'Trainee')
  const seniorsU = withSup.dispatcherSchedules.filter((d) => d.dispatcher.level === 'Senior')
  const soleTraineeRoster = trainees.length <= 1
  for (const t of trainees) {
    const t0 = noSup.dispatcherSchedules.find((d) => d.dispatcher.id === t.dispatcher.id)!
    if (t.totalHours + 1e-9 < t0.totalHours) shrunk++
    if (t.days.filter((d) => !d.isOff).length < t0.days.filter((d) => !d.isOff).length) shrunk++
  }
  for (const dInfo of withSup.dates) {
    const date = dInfo.date
    const req = withSup.coverageRequired?.[date] ?? []
    const a = withSup.coverageActual[date] ?? []
    const b = noSup.coverageActual[date] ?? []
    const marks = withSup.supervisionSlots?.[date] ?? []
    const cons = withSup.supervisionConcessions?.[date] ?? []
    const flags = (withSup.coverageWarnings?.[date] ?? []).filter((w) => w.peak === 'supervision')
    const traineeOn = trainees.some((t) => { const d = t.days.find((x) => x.date === date); return d && !d.isOff })
    const seniorOn = seniorsU.some((p) => { const d = p.days.find((x) => x.date === date); return d && !d.isOff })
    if (traineeOn && !seniorOn) unsupervisable++

    for (let s = 0; s < SLOTS.length; s++) {
      // U3 — over-coverage added by the pass must be marked
      // Match on (slot, guardian-actually-present), not slot alone: a mark for
      // one body must not exempt over-coverage another body caused.
      const marked = marks.some((m) => {
        if (m.slot !== s) return false
        const g = withSup.dispatcherSchedules.find((x) => x.dispatcher.id === m.guardianId)
        const gd = g?.days.find((x) => x.date === date)
        return !!gd && !gd.isOff && gd.slots[s]
      })
      if ((a[s] ?? 0) > (req[s] ?? 0) && (a[s] ?? 0) > (b[s] ?? 0) && !marked) unmarkedOver++
      // U4 — a target−2 dip must be a recorded concession, on the shoulder
      if ((a[s] ?? 0) < (req[s] ?? 0) - 1 && !cons.some((c) => c.slot === s)) unmarkedDeep++
      if (cons.some((c) => c.slot === s) && !SHOULDER_U.has(s)) unmarkedDeep++
      // U5 — nothing outside the shoulder may worsen vs no-supervision
      if (!SHOULDER_U.has(s) && (a[s] ?? 0) < (b[s] ?? 0) && (a[s] ?? 0) < (req[s] ?? 0)) worsened++
    }
    for (const t of trainees) {
      const day = t.days.find((d) => d.date === date)
      if (!day || day.isOff) continue
      const peers = withSup.dispatcherSchedules.filter((d) => d !== t)
      const at = (lvl: string, s: number) =>
        peers.some((p) => { const d = p.days.find((x) => x.date === date)!; return p.dispatcher.level === lvl && !d.isOff && d.slots[s] })
      let run = 0, daily = 0
      for (let s = 0; s < SLOTS.length; s++) {
        if (!day.slots[s]) { run = 0; continue }
        if (at('Senior', s)) { run = 0; continue }
        if (!at('Regular', s)) {
          run = 0
          // U1 — alone: legal only when surfaced
          if (!flags.length) aloneUnflagged++
          // U4 — never the last body standing at a slot we conceded FOR her
          if (cons.some((c) => c.slot === s) && (a[s] ?? 0) === 1) soleTrainee++
          continue
        }
        run += SLOTS[s].hours; daily += SLOTS[s].hours
        if (run > SUP_BRIDGE + 1e-9 || daily > SUP_BRIDGE + 1e-9) {
          bridgeReport++
          if (soleTraineeRoster) bridgeFail++
          else if (!flags.length) silentOnExempt++ // out of scope is not unspoken
          run = 0; daily = 0
        }
      }
    }
  }
  const pass = aloneUnflagged === 0 && bridgeFail === 0 && unmarkedOver === 0 && unmarkedDeep === 0 && soleTrainee === 0 && worsened === 0 && shrunk === 0 && silentOnExempt === 0
  console.log(`  ${name.padEnd(16)} alone-unflagged ${aloneUnflagged} · bridge>1.5h ${bridgeFail} · unmarked-over ${unmarkedOver} · unmarked−2 ${unmarkedDeep} · sole-trainee ${soleTrainee} · worsened ${worsened} · shrunk ${shrunk} ${pass ? '✓' : '← FAIL'}`)
  if (!soleTraineeRoster) console.log(`  ${' '.padEnd(16)} └─ ${trainees.length} Trainees / ${seniorsU.length} Senior(s): U2 REPORTED not asserted (see scope note) — ${bridgeReport} bridge>1.5h, ${silentOnExempt} silent, ${unsupervisable} day(s) with no Senior rostered at all`)
  return pass
}

/** NEGATIVE TESTS — the net must not loosen, even transiently.
 *
 *  Provenance-keyed exemptions are only trustworthy if the un-provenanced
 *  case still fails. Each test plants a synthetic violation that carries NO
 *  mark and asserts the gate still rejects it. If one of these ever "passes",
 *  the exemption has widened into a tolerance and the gate is now decorative.
 *  (This is the discipline the once-imprecise "law-forced" flag taught us:
 *  it swallowed a real off-cap bug because it excused a category, not a fact.) */
function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T }
function negatives(): boolean {
  let ok = true
  const day = prodSchedule.dates[3].date

  // 1. Unmarked over-coverage must still fail Gate U (U3).
  const overNoMark = clone(prodSchedule)
  const victim = overNoMark.dispatcherSchedules.find((d) => d.dispatcher.level === 'Senior')!
  const vd = victim.days.find((x) => x.date === day)!
  const free = vd.slots.findIndex((on) => !on)
  vd.slots[free] = true
  overNoMark.coverageActual[day][free] = (overNoMark.coverageActual[day][free] ?? 0) + 3
  const r1 = gateU('  neg: unmarked over', overNoMark, prodNoSup)
  if (r1) { console.log('    ✗ NEGATIVE TEST FAILED — unmarked over-coverage was exempted'); ok = false }

  // 2. Unmarked target−2 shoulder dip must still fail Gate U (U4) and Gate T.
  const deepNoMark = clone(prodSchedule)
  deepNoMark.supervisionConcessions = {}
  const r2 = gateU('  neg: unmarked −2', deepNoMark, prodNoSup)
  if (r2 && Object.values(prodSchedule.supervisionConcessions ?? {}).some((v) => v.length)) {
    console.log('    ✗ NEGATIVE TEST FAILED — a target−2 dip passed with its provenance stripped'); ok = false
  }
  const deepT = clone(prodStairOn)
  deepT.supervisionConcessions = {}
  deepT.coverageActual[day][15] = 0
  const r3 = gateT('  neg: unmarked −2 (T)', deepT, prodStairOff)
  if (r3) { console.log('    ✗ NEGATIVE TEST FAILED — Gate T exempted an unmarked shoulder collapse'); ok = false }

  // 3. An alone with no flag must still fail Gate U (U1).
  const silentAlone = clone(prodSchedule)
  for (const d of silentAlone.dates) {
    silentAlone.coverageWarnings![d.date] = (silentAlone.coverageWarnings?.[d.date] ?? []).filter((w) => w.peak !== 'supervision')
  }
  const anyAlone = Object.values(prodSchedule.coverageWarnings ?? {}).some((ws) => ws.some((w) => w.peak === 'supervision'))
  const r4 = gateU('  neg: unflagged alone', silentAlone, prodNoSup)
  if (r4 && anyAlone) { console.log('    ✗ NEGATIVE TEST FAILED — an unflagged alone passed'); ok = false }
  return ok
}

console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate U — trainee supervision: Senior concurrency, ≤1.5h Regular bridge')
console.log('══════════════════════════════════════════════════════════════════════')
const uSyn = gateU('synthetic', schedule, noSup)
const uProd = gateU('prod-config', prodSchedule, prodNoSup)
const gateUPass = uSyn && uProd
console.log('\n  negative tests (the exemption must not have widened into a tolerance):')
const negPass = negatives()
const gateUFail = gateUPass && negPass ? 0 : 1

const allPass = gateSFail === 0 && gateHFail === 0 && gateOFail === 0 && gateTFail === 0 && gateUFail === 0
console.log(`\n FINAL — Gate S: ${gateSFail === 0 ? 'PASS' : 'FAIL'}   Gate H: ${gateHFail === 0 ? 'PASS' : 'FAIL'}   Gate O: ${gateOFail === 0 ? 'PASS' : 'FAIL'}   Gate T: ${gateTFail === 0 ? 'PASS' : 'FAIL'}   Gate U: ${gateUFail === 0 ? 'PASS' : 'FAIL'}`)
if (!allPass) process.exit(1)
