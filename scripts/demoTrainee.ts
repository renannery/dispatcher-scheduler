/**
 * Verify:
 *   (1) Trainees get at most 1 day off per week (Regular/Senior stay at ≤2).
 *   (2) Surplus over-cov lands preferentially inside SURPLUS_TOLERATED slots
 *       (lunch 11:00–13:00 = slots 3,4,5; dinner 17:00–20:00 = slots 11-14)
 *       rather than off-peak.
 *
 * Runs generateSchedule twice on the same roster shape — once with all
 * Regulars, once with two Trainees + rest Regular — and reports the
 * off-day tally per dispatcher plus the over-cov distribution split by
 * tolerated / off-peak windows.
 *
 * Run with: npx tsx scripts/demoTrainee.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher, DispatcherLevel, GeneratedSchedule } from '@/types/schedule'
import { SLOTS, SURPLUS_TOLERATED_SLOTS } from '@/data/coverageTemplate'

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7']
const names  = ['Alice', 'Bob', 'Carla', 'Diego', 'Esther', 'Frank', 'Gina']

function makeRoster(levels: DispatcherLevel[]): Dispatcher[] {
  return names.map((name, i) => ({
    id: `d${i + 1}`,
    name,
    color: COLORS[i],
    level: levels[i],
  }))
}

function labelPattern(bool: boolean[]): string {
  let start = -1
  for (let i = 0; i < bool.length; i++) if (bool[i]) { start = i; break }
  let end = -1
  for (let i = bool.length - 1; i >= 0; i--) if (bool[i]) { end = i; break }
  return start < 0 ? '(off)' : `${SLOTS[start].label.split('–')[0]}→${SLOTS[end].label.split('–')[1] || SLOTS[end].label}`
}

function analyze(label: string, roster: Dispatcher[]) {
  const schedule = generateSchedule(roster, '2026-07-02', '2026-07-08', {}, 42) // Thu → Wed

  // Off-days per dispatcher per week
  const offByDisp: Record<string, number> = {}
  for (const d of roster) offByDisp[d.id] = 0
  for (const ds of schedule.dispatcherSchedules) {
    for (const day of ds.days) if (day.isOff) offByDisp[ds.dispatcher.id]++
  }

  // Over-cov distribution: tolerated vs off-peak
  let overTolerated = 0
  let overOff = 0
  for (const d of schedule.dates) {
    const req = schedule.coverageRequired?.[d.date] ?? []
    const act = schedule.coverageActual[d.date] ?? []
    for (let i = 0; i < req.length; i++) {
      const surplus = Math.max(0, act[i] - req[i])
      if (surplus === 0) continue
      if (SURPLUS_TOLERATED_SLOTS.has(i)) overTolerated += surplus
      else overOff += surplus
    }
  }

  // Under-cov total (should be similar or better with more trainee hours)
  let underTotal = 0
  for (const d of schedule.dates) {
    const req = schedule.coverageRequired?.[d.date] ?? []
    const act = schedule.coverageActual[d.date] ?? []
    for (let i = 0; i < req.length; i++) underTotal += Math.max(0, req[i] - act[i])
  }

  console.log(`\n─── ${label} ───`)
  console.log('Off-days per dispatcher (this week):')
  for (const d of roster) {
    const flag = d.level === 'Trainee' && offByDisp[d.id] > 1 ? ' ← VIOLATES trainee cap!' : ''
    console.log(`  ${d.name.padEnd(8)} ${d.level.padEnd(8)} ${offByDisp[d.id]} off${flag}`)
  }
  console.log(`Over-cov distribution: ${overTolerated} in tolerated windows, ${overOff} off-peak`)
  console.log(`Under-cov total slots: ${underTotal}`)

  // Per-day per-dispatcher shift log — helps see which day's shape shifted
  console.log('Shifts per day (dispatcher → shift):')
  for (const d of schedule.dates) {
    const line = schedule.dispatcherSchedules.map((ds) => {
      const day = ds.days.find((x) => x.date === d.date)
      if (!day || day.isOff) return `${ds.dispatcher.name.slice(0, 3)}:OFF`
      return `${ds.dispatcher.name.slice(0, 3)}:${labelPattern(day.slots)}`
    }).join('  ')
    console.log(`  ${d.date} ${d.dayLabel}: ${line}`)
  }
  return { overTolerated, overOff, offByDisp, schedule }
}

// Baseline: 1 Senior + 6 Regulars
const baseline = analyze(
  'BASELINE: 1 Senior + 6 Regular (Trainees=0)',
  makeRoster(['Senior', 'Regular', 'Regular', 'Regular', 'Regular', 'Regular', 'Regular']),
)

// Trainee test: 1 Senior + 4 Regulars + 2 Trainees (Frank, Gina)
const trained = analyze(
  'TRAINEE: 1 Senior + 4 Regular + 2 Trainee (Frank, Gina = Trainees)',
  makeRoster(['Senior', 'Regular', 'Regular', 'Regular', 'Regular', 'Trainee', 'Trainee']),
)

// Summary comparison
console.log('\n══════════════ Summary ══════════════')
console.log(`Baseline over-cov  →  tolerated: ${baseline.overTolerated}  off-peak: ${baseline.overOff}`)
console.log(`Trainee  over-cov  →  tolerated: ${trained.overTolerated}  off-peak: ${trained.overOff}`)
const trShare = trained.overTolerated + trained.overOff > 0
  ? Math.round(100 * trained.overTolerated / (trained.overTolerated + trained.overOff))
  : 0
console.log(`Trainee tolerated share: ${trShare}%  (higher = surplus steered to tolerated windows)`)
console.log(`\nSlot legend:`)
console.log(`  tolerated lunch (11:00–13:00) = slots 3,4,5 → ${[3,4,5].map(i=>SLOTS[i].label).join(', ')}`)
console.log(`  tolerated dinner (17:00–20:00) = slots 11-14 → ${[11,12,13,14].map(i=>SLOTS[i].label).join(', ')}`)
