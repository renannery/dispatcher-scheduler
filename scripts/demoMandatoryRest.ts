/**
 * Verify the mandatory-weekly-rest pre-pass on the same 11-week window
 * the user cited (2026-06-25 → 2026-09-09) with the 7-dispatcher roster
 * currently loaded in production. Runs three PASS/FAIL gates plus a
 * baseline-vs-new comparison.
 *
 *   Gate 1 — streak audit: max consecutive workdays ≤ 6 for every
 *            dispatcher across the whole horizon. Any ≥ 7 fails.
 *   Gate 2 — trainee off-count: every trainee × work-week has exactly
 *            1 off-day (never 0, never 2). Ignores weeks fully outside
 *            the schedule range.
 *   Gate 3 — rest × anchor collision: prints the count of dates where
 *            a mandatory-rest lock and a peakWithoutAnchor warning
 *            coexist (informational, not a fail).
 *
 * Exit code: 0 if all pass/fail gates pass, 1 if any fail.
 *
 * Run with: npx tsx scripts/demoMandatoryRest.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher, DispatcherLevel, GeneratedSchedule } from '@/types/schedule'

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7']

// Roster matching the loaded production state: mix of Senior, Regular, Trainee.
// Ayrton = Senior; Adorre, Kimberly, Michelle, Paula = Regular; Resgie,
// Shamika = Trainee (the two the user called out as most affected).
const roster: Dispatcher[] = [
  { id: 'd1', name: 'Ayrton',   color: COLORS[0], level: 'Senior'  },
  { id: 'd2', name: 'Adorre',   color: COLORS[1], level: 'Regular' },
  { id: 'd3', name: 'Kimberly', color: COLORS[2], level: 'Regular' },
  { id: 'd4', name: 'Michelle', color: COLORS[3], level: 'Regular' },
  { id: 'd5', name: 'Paula',    color: COLORS[4], level: 'Regular' },
  { id: 'd6', name: 'Resgie',   color: COLORS[5], level: 'Trainee' },
  { id: 'd7', name: 'Shamika',  color: COLORS[6], level: 'Trainee' },
]

const startDate = '2026-06-25' // Thu
const endDate   = '2026-09-09' // Wed

const schedule = generateSchedule(roster, startDate, endDate, {}, 42)

function weekBoundaryLabel(date: string): string {
  // Same Thu→Wed bucketing the scheduler uses. Format: 'Jul 2 – Jul 8'.
  const d = new Date(date + 'T12:00:00')
  const dow = d.getDay()
  const thu = new Date(d); thu.setDate(d.getDate() - ((dow + 3) % 7))
  const wed = new Date(thu); wed.setDate(thu.getDate() + 6)
  const fmt = (dt: Date) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(thu)} – ${fmt(wed)}`
}

// ── Gate 1: max consecutive workdays ≤ 6 ────────────────────────────────
let gate1Failed = false
const streaks: Array<{ name: string; maxStreak: number; longestFrom: string; longestTo: string }> = []
for (const ds of schedule.dispatcherSchedules) {
  const days = [...ds.days].sort((a, b) => a.date.localeCompare(b.date))
  let currentStreak = 0
  let currentStart = ''
  let maxStreak = 0
  let maxFrom = ''
  let maxTo = ''
  for (const day of days) {
    if (day.isOff) {
      currentStreak = 0
      currentStart = ''
    } else {
      if (currentStreak === 0) currentStart = day.date
      currentStreak++
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak
        maxFrom = currentStart
        maxTo = day.date
      }
    }
  }
  streaks.push({ name: ds.dispatcher.name, maxStreak, longestFrom: maxFrom, longestTo: maxTo })
  if (maxStreak > 6) gate1Failed = true
}

console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Gate 1 — max consecutive workdays per dispatcher (must be ≤ 6)')
console.log('══════════════════════════════════════════════════════════════════════')
for (const s of streaks) {
  const flag = s.maxStreak > 6 ? ' ← FAIL' : ' ✓'
  console.log(`  ${s.name.padEnd(10)} max streak = ${s.maxStreak} (${s.longestFrom} → ${s.longestTo})${flag}`)
}
console.log(`  → ${gate1Failed ? 'FAIL' : 'PASS'}`)

// ── Gate 2: trainee weekly off-count is exactly 1 ───────────────────────
let gate2Failed = false
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate 2 — trainee weekly off-count (must be exactly 1 per work-week)')
console.log('══════════════════════════════════════════════════════════════════════')
for (const ds of schedule.dispatcherSchedules) {
  if (ds.dispatcher.level !== 'Trainee') continue
  // Bucket by weekLabel using date comparison
  const perWeek = new Map<string, { off: number; total: number }>()
  for (const day of ds.days) {
    const wLbl = weekBoundaryLabel(day.date)
    const entry = perWeek.get(wLbl) ?? { off: 0, total: 0 }
    entry.total++
    if (day.isOff) entry.off++
    perWeek.set(wLbl, entry)
  }
  const wkOffs: number[] = []
  let violations: string[] = []
  for (const [wLbl, { off, total }] of perWeek) {
    wkOffs.push(off)
    // Only enforce on weeks the schedule fully covers (7 days). Partial
    // weeks at the schedule edges are allowed to have 0 or fewer.
    if (total === 7 && off !== 1) violations.push(`${wLbl}: ${off} off`)
  }
  const trend = wkOffs.join(',')
  console.log(`  ${ds.dispatcher.name.padEnd(10)} weekly off counts = [${trend}]  (11 full weeks)`)
  if (violations.length > 0) {
    console.log(`    FAIL — weeks not at exactly 1 off: ${violations.join('; ')}`)
    gate2Failed = true
  }
}
console.log(`  → ${gate2Failed ? 'FAIL' : 'PASS'}`)

// ── Gate 3: rest × anchor collision (informational) ─────────────────────
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate 3 — rest-vs-anchor collision report (informational)')
console.log('══════════════════════════════════════════════════════════════════════')
const anchorDates = new Set<string>()
const restDates = new Set<string>()
for (const [date, ws] of Object.entries(schedule.coverageWarnings ?? {})) {
  for (const w of ws) {
    if (w.peak === 'lunch' || w.peak === 'dinner') anchorDates.add(date)
    if (w.peak === 'mandatory-rest') restDates.add(date)
  }
}
const collisions = [...anchorDates].filter((d) => restDates.has(d)).sort()
console.log(`  Dates with peakWithoutAnchor warnings: ${anchorDates.size}`)
console.log(`  Dates with mandatory-rest warnings:    ${restDates.size}`)
console.log(`  Collision (both on same date):         ${collisions.length}`)
if (collisions.length > 0) {
  console.log(`  Colliding dates: ${collisions.slice(0, 10).join(', ')}${collisions.length > 10 ? '...' : ''}`)
}

// ── Baseline-vs-new comparison ─────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Baseline (pre-change, cited by user) vs New (this build)')
console.log('══════════════════════════════════════════════════════════════════════')
const baselineStreaks = {
  Shamika: 31,
  Resgie:  25,
  Adorre:  13,
}
console.log('  Dispatcher   Baseline streak   New streak   Δ')
for (const [name, base] of Object.entries(baselineStreaks)) {
  const nw = streaks.find((s) => s.name === name)?.maxStreak ?? '?'
  const delta = typeof nw === 'number' ? nw - base : '?'
  console.log(`  ${name.padEnd(12)} ${String(base).padStart(15)}   ${String(nw).padStart(10)}   ${delta}`)
}

// Total mandatory-rest warnings count
let totalRestWarns = 0
for (const ws of Object.values(schedule.coverageWarnings ?? {})) {
  totalRestWarns += ws.filter((w) => w.peak === 'mandatory-rest').length
}
console.log(`\n  Total mandatory-rest warnings (new): ${totalRestWarns}`)
console.log(`  (Baseline had 0 mandatory-rest warnings because the constraint didn't exist.)`)

// Trainee weekly hours
console.log('\n  Trainee weekly-hours delta:')
for (const ds of schedule.dispatcherSchedules) {
  if (ds.dispatcher.level !== 'Trainee') continue
  const wkHours = Object.values(ds.weeklyHours)
  const avg = wkHours.length > 0 ? wkHours.reduce((a, b) => a + b, 0) / wkHours.length : 0
  console.log(`    ${ds.dispatcher.name.padEnd(10)} total ${ds.totalHours}h   avg ${avg.toFixed(1)}h/wk`)
}

// ── Final ──────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(` FINAL — Gate 1: ${gate1Failed ? 'FAIL' : 'PASS'}   Gate 2: ${gate2Failed ? 'FAIL' : 'PASS'}   Gate 3: informational`)
console.log('══════════════════════════════════════════════════════════════════════')

if (gate1Failed || gate2Failed) process.exit(1)
