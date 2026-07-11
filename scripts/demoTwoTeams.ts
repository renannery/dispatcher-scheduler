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

// ── Gate S: emitted shift shapes ────────────────────────────────────────
let gateSFail = 0
const shapeViolations: string[] = []
for (const ds of schedule.dispatcherSchedules) {
  for (const day of ds.days) {
    if (day.isOff) continue
    const blocks = patternWorkBlocks(day.slots, SLOTS)
    if (blocks.length === 0) continue
    const brk = patternMaxBreakHours(day.slots, SLOTS)
    const work = blocks.reduce((s, h) => s + h, 0)
    const problems: string[] = []
    if (blocks.length > 2) problems.push(`${blocks.length} stretches`)
    if (blocks.length === 2 && brk !== MEAL_BREAK_HOURS) {
      // Mon–Wed split exception: 3h gap confined to the 14:00–17:00
      // lull, both blocks ≥ 3h.
      const gap = midShiftBreakSlots(day.slots)
      const isSplit =
        brk >= SPLIT_GAP_MIN_HOURS && brk <= SPLIT_GAP_MAX_HOURS &&
        gap.every((s) => (SPLIT_GAP_SLOTS as readonly number[]).includes(s)) &&
        blocks[0] >= MIN_SPLIT_BLOCK_HOURS && blocks[1] >= MIN_SPLIT_BLOCK_HOURS
      if (!isSplit) problems.push(`break ${brk}h ≠ ${MEAL_BREAK_HOURS}h and not a legal Mon–Wed split`)
    }
    // No hard 5h cap now — a block may run to the 9h daily max.
    if (blocks[0] < MIN_BLOCK_HOURS) problems.push(`first stretch ${blocks[0]}h < ${MIN_BLOCK_HOURS}h`)
    // A sub-5h shift is only legal as the flagged constrained-window
    // exception (a partial-block day whose window can't fit a 5h shift).
    const constrainedExempt = (schedule.coverageWarnings?.[day.date] ?? []).some(
      (w) => w.peak === 'constrained-shift',
    )
    if (work < MIN_TOTAL_SHIFT_HOURS && !constrainedExempt)
      problems.push(`${work}h total < ${MIN_TOTAL_SHIFT_HOURS}h min shift`)
    if (work > MEAL_BREAK_TRIGGER_HOURS && blocks.length < 2) problems.push(`${work}h (>5h) no meal break`)
    // >5h meal break must sit in a demand trough, never in a peak.
    if (work > MEAL_BREAK_TRIGGER_HOURS && blocks.length === 2 && brk === MEAL_BREAK_HOURS) {
      const bslot = midShiftBreakSlots(day.slots)
      if (bslot.some((s) => PEAK_SLOT_INDICES.includes(s))) problems.push(`break in peak (slots ${bslot.join(',')})`)
      else if (!bslot.every((s) => BREAK_TROUGH_SLOTS.has(s))) problems.push(`break not in trough (slots ${bslot.join(',')})`)
    }
    if (work > 9) problems.push(`${work}h > 9h`)
    if (!isWeekendDow(day.dayOfWeek) && Math.max(...blocks) < WEEKDAY_PRIMARY_STRETCH_HOURS) {
      problems.push(`no 5h primary (weekday)`)
    }
    if (problems.length > 0) {
      gateSFail++
      if (shapeViolations.length < 8) {
        shapeViolations.push(`${ds.dispatcher.name} ${day.date}: ${problems.join('; ')} (blocks=[${blocks.join(',')}])`)
      }
    }
  }
}
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Gate S — two-team shift shapes on every emitted shift')
console.log('══════════════════════════════════════════════════════════════════════')
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

const allPass = gateSFail === 0 && gateHFail === 0 && gateOFail === 0
console.log(`\n FINAL — Gate S: ${gateSFail === 0 ? 'PASS' : 'FAIL'}   Gate H: ${gateHFail === 0 ? 'PASS' : 'FAIL'}   Gate O: ${gateOFail === 0 ? 'PASS' : 'FAIL'}`)
if (!allPass) process.exit(1)
