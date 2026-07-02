/**
 * Acceptance gate: the auto-generated schedule must match the coverage
 * shape the human team achieved by hand for June 25 – July 8, 2026
 * (same 7 dispatchers, same absences). Targets were CALIBRATED to the
 * hand-made schedule in July 2026 (weekend open 1, Sat lunch 2,
 * Tue–Thu evening 3, weekday 10–11 PM 2) — this gate runs against the
 * calibrated targets, with the human matrix as the reference shape.
 *
 * Gates:
 *   B1 — zero 0-coverage slots (any slot with target > 0 or that the
 *        humans staffed).
 *   B2 — dinner peak (5–8 PM) at target every day.
 *   B3 — weekend staggered edges: exactly 1 at the 8–9 AM open, one
 *        morning shift ending 15:00 and one ending 16:00, both morning
 *        bodies overlapping the whole lunch peak.
 *   B4 — avg |generated − human| ≤ 0.60 per slot.
 *   B5 — residuals bounded: every under-target slot is depth −1,
 *        never inside a peak window, and non-absence residuals total
 *        ≤ 8 units across the two weeks. (Zero residual is not
 *        reachable under the formal 30-min break: the human matrix
 *        counts informal breaks as coverage — ~2.5h/day the formal
 *        model must place off-floor. The bound pins today's honest
 *        envelope so regressions can't hide.)
 *
 * Run with: npx tsx scripts/benchmarkHumanWeeks.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher, DispatcherTimeOff } from '@/types/schedule'
import {
  DINNER_PEAK_SLOTS,
  LUNCH_PEAK_SLOTS,
  SLOTS,
  calibrateLegacyWeekendOverrides,
} from '@/data/coverageTemplate'

// ── The hand-made reference (dispatchers active per slot) ───────────────
const HUMAN: Record<string, number[]> = {
  '2026-06-25': [0,2,2,2,2,2,2,1,2,2,2,3,3,3,3,3,3,3,3,1],
  '2026-06-26': [0,2,2,2,3,3,3,2,2,2,2,4,4,4,4,4,4,2,2,1],
  '2026-06-27': [1,2,2,2,2,2,1,1,2,2,2,3,2,3,3,3,3,3,3,1],
  '2026-06-28': [1,2,2,1,2,2,2,1,2,2,3,4,3,4,4,4,3,3,3,2],
  '2026-06-29': [0,1,1,2,2,2,2,1,2,1,2,2,3,3,3,3,1,2,2,2],
  '2026-06-30': [0,2,2,2,3,3,3,2,3,3,2,2,2,1,2,2,1,2,2,0],
  '2026-07-01': [0,2,2,2,3,3,3,2,3,3,3,3,3,3,3,3,2,3,3,1],
  '2026-07-02': [0,2,2,1,2,2,2,1,2,2,2,3,3,3,3,3,2,3,1,1],
  '2026-07-03': [0,2,2,2,3,3,3,2,3,2,2,3,4,4,4,4,4,2,2,1],
  '2026-07-04': [1,2,2,1,2,2,2,1,2,1,2,3,2,3,3,3,3,3,3,1],
  '2026-07-05': [1,2,2,2,3,3,3,2,2,2,3,4,3,4,4,4,3,2,2,2],
  '2026-07-06': [0,1,1,2,2,2,2,1,2,1,2,2,3,3,3,3,1,2,2,2],
  '2026-07-07': [0,2,2,1,2,2,2,1,2,2,1,3,3,3,3,3,3,3,2,0],
  '2026-07-08': [0,2,2,2,3,3,3,2,3,3,2,3,3,3,3,3,1,3,2,2],
}

// ── The production inputs the humans scheduled around ──────────────────
const roster: Dispatcher[] = [
  { id: 'l1dydyt', name: 'adorre',   color: '#10b981', level: 'Regular' },
  { id: '0gjtabx', name: 'ayrton',   color: '#ef4444', level: 'Senior'  },
  { id: 'fmvecxr', name: 'kimberly', color: '#eab308', level: 'Senior'  },
  { id: 'xb9f7rj', name: 'michelle', color: '#22c55e', level: 'Senior'  },
  { id: '75pmgeu', name: 'paula',    color: '#06b6d4', level: 'Senior'  },
  { id: 'zfqp9my', name: 'resgie',   color: '#3b82f6', level: 'Trainee' },
  { id: 'foczori', name: 'shamika',  color: '#a855f7', level: 'Trainee' },
]
const fullDay = () => new Array(20).fill(true)
const timeOff: DispatcherTimeOff = {
  'xb9f7rj': { '2026-06-25': fullDay() },                          // michelle
  '75pmgeu': { '2026-06-25': fullDay(), '2026-07-03': fullDay() }, // paula
  'fmvecxr': { '2026-07-05': fullDay() },                          // kimberly
}
/** Days thinned by an absence — residuals here are expected. 2026-07-02
 *  is absence-DISPLACED: paula's Friday vacation collapses shamika's
 *  legal rest window onto Thursday, doubling that day's rests. */
const ABSENCE_DAYS = new Set(['2026-06-25', '2026-07-02', '2026-07-03', '2026-07-05'])
// The user's stored Saturday override (post-calibration values via the
// same migration the app applies on import).
const overrides = calibrateLegacyWeekendOverrides({
  6: [2, 2, 2, 2, 3, 3, 3, 2, 2, 1, 1, 4, 4, 4, 4, 3, 3, 2, 1, 1],
})!

const s = generateSchedule(roster, '2026-06-25', '2026-07-08', timeOff, 48, overrides)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

let zeroFails = 0
let depthFails = 0
let peakResidualFails = 0
const PEAK_SLOTS = new Set<number>([...LUNCH_PEAK_SLOTS, ...DINNER_PEAK_SLOTS])
let dinnerFails = 0
let edgeFails: string[] = []
let absSum = 0
let absN = 0
const residuals: string[] = []
let residualOffDays = 0

console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Benchmark — calibrated target / human / generated, per slot')
console.log('══════════════════════════════════════════════════════════════════════')
for (const [date, human] of Object.entries(HUMAN)) {
  const dInfo = s.dates.find((d) => d.date === date)!
  const req = s.coverageRequired?.[date] ?? []
  const act = s.coverageActual[date] ?? []
  console.log(`\n${date} ${DOW[dInfo.dayOfWeek]}`)
  console.log('  target: ' + req.join(' '))
  console.log('  human : ' + human.join(' '))
  console.log('  gen   : ' + act.join(' '))
  let dayUnder = 0
  human.forEach((h, i) => {
    const a = act[i] ?? 0
    const r = req[i] ?? 0
    if ((r > 0 || h > 0) && a === 0) zeroFails++
    if (h > 0 || r > 0) { absSum += Math.abs(a - h); absN++ }
    if (r > 0 && a < r) {
      dayUnder += r - a
      if (r - a > 1) depthFails++
      if (PEAK_SLOTS.has(i)) peakResidualFails++
    }
  })
  for (const i of DINNER_PEAK_SLOTS) {
    if ((act[i] ?? 0) < (req[i] ?? 0)) dinnerFails++
  }
  if (dayUnder > 0) {
    residuals.push(`${date} ${DOW[dInfo.dayOfWeek]}: −${dayUnder}`)
    if (!ABSENCE_DAYS.has(date)) residualOffDays += dayUnder
  }

  // B3 — weekend staggered edges
  if (dInfo.dayOfWeek === 0 || dInfo.dayOfWeek === 6) {
    if ((act[0] ?? 0) !== 1) edgeFails.push(`${date}: open has ${act[0]} (want 1)`)
    const morningShifts = s.dispatcherSchedules
      .map((ds) => ds.days.find((x) => x.date === date))
      .filter((d): d is NonNullable<typeof d> => !!d && !d.isOff)
      .map((d) => d.slots)
      // Morning shifts only: start 8–10 AM, done by 16:00 (splits and
      // evening shapes are not part of the weekend-edge check).
      .filter((slots) => slots.findIndex(Boolean) <= 2 && slots.lastIndexOf(true) <= 9)
    const ends = morningShifts.map((slots) => slots.lastIndexOf(true))
    const endsAt15 = ends.filter((e) => e === 8).length // last slot 2:30–3
    const endsAt16 = ends.filter((e) => e === 9).length // last slot 3–4 PM
    if (endsAt15 < 1 || endsAt16 < 1) {
      edgeFails.push(`${date}: morning ends ${ends.map((e) => SLOTS[e].label).join(', ')} (want one 15:00 + one 16:00)`)
    }
    for (const slots of morningShifts) {
      if (!LUNCH_PEAK_SLOTS.every((i) => slots[i])) {
        edgeFails.push(`${date}: a morning shift misses part of the lunch peak`)
      }
    }
  }
}

const avgAbs = absSum / absN
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gates')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  B1 zero-coverage slots:            ${zeroFails === 0 ? '0 ✓' : `${zeroFails} ← FAIL`}`)
console.log(`  B2 dinner-below-target slot-days:  ${dinnerFails === 0 ? '0 ✓' : `${dinnerFails} ← FAIL`}`)
console.log(`  B3 weekend staggered edges:        ${edgeFails.length === 0 ? 'all ✓' : `${edgeFails.length} ← FAIL`}`)
for (const e of edgeFails) console.log(`       ${e}`)
console.log(`  B4 avg |gen − human| per slot:     ${avgAbs.toFixed(2)} ${avgAbs <= 0.6 ? '✓' : '← FAIL (>0.60)'}`)
console.log(`  B5 under-target residuals:         ${residuals.join(' · ') || 'none'}`)
console.log(`     depth > 1:                      ${depthFails === 0 ? '0 ✓' : `${depthFails} ← FAIL`}`)
console.log(`     inside a peak window:           ${peakResidualFails === 0 ? '0 ✓' : `${peakResidualFails} ← FAIL`}`)
console.log(`     units on NON-absence days:      ${residualOffDays} ${residualOffDays <= 8 ? '✓ (≤8)' : '← FAIL (>8)'}`)

const pass = zeroFails === 0 && dinnerFails === 0 && edgeFails.length === 0 && avgAbs <= 0.6 &&
  depthFails === 0 && peakResidualFails === 0 && residualOffDays <= 8
console.log(`\n FINAL — ${pass ? 'PASS' : 'FAIL'}`)
if (!pass) process.exit(1)
