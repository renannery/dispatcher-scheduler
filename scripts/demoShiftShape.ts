/**
 * Verify the shift-shape rules:
 *   Gate A — every emitted shift's min block ≥ 3h (global rule).
 *   Gate B — every emitted WEEKDAY shift's max block ≥ 5h (primary stretch).
 *   Gate C — pool audit: valid weekday anchor patterns per template.
 *
 * Run with: npx tsx scripts/demoShiftShape.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher } from '@/types/schedule'
import { DAY_TEMPLATES, LUNCH_PEAK_SLOTS, DINNER_PEAK_SLOTS, MAX_BREAK_HARD_HOURS, MED_SHIFT_BREAK_MIN, LONG_SHIFT_BREAK_MIN, MIN_BLOCK_HOURS, WEEKDAY_PRIMARY_STRETCH_HOURS, patternWorkBlocks, patternMaxBreakHours, SLOTS } from '@/data/coverageTemplate'

const roster: Dispatcher[] = [
  { id: 'd1', name: 'Ayrton',   color: '#ef4444', level: 'Senior'  },
  { id: 'd2', name: 'Adorre',   color: '#f97316', level: 'Regular' },
  { id: 'd3', name: 'Kimberly', color: '#eab308', level: 'Regular' },
  { id: 'd4', name: 'Michelle', color: '#22c55e', level: 'Regular' },
  { id: 'd5', name: 'Paula',    color: '#06b6d4', level: 'Regular' },
  { id: 'd6', name: 'Resgie',   color: '#3b82f6', level: 'Trainee' },
  { id: 'd7', name: 'Shamika',  color: '#a855f7', level: 'Trainee' },
]

function isWeekendDow(dow: number): boolean { return dow === 0 || dow === 6 }

// Match the scheduler's isValidShiftShape rules for the pool audit.
function isValidForDow(pattern: boolean[] | number[], dow: number): boolean {
  const blocks = patternWorkBlocks(pattern, SLOTS)
  if (blocks.length === 0 || blocks.length > 2) return false
  if (Math.min(...blocks) < MIN_BLOCK_HOURS) return false
  if (Math.max(...blocks) > 5) return false
  const totalWork = blocks.reduce((s, h) => s + h, 0)
  if (totalWork < 4 || totalWork > 9) return false
  const maxBreak = patternMaxBreakHours(pattern, SLOTS)
  if (maxBreak > MAX_BREAK_HARD_HOURS) return false
  if (totalWork >= 8 && maxBreak < LONG_SHIFT_BREAK_MIN) return false
  if (totalWork > 5 && totalWork < 8 && maxBreak < MED_SHIFT_BREAK_MIN) return false
  if (!isWeekendDow(dow) && Math.max(...blocks) < WEEKDAY_PRIMARY_STRETCH_HOURS) return false
  return true
}

function isAnchorFor(pattern: boolean[] | number[], peak: readonly number[]): boolean {
  let first = -1
  for (let i = 0; i < pattern.length; i++) if (pattern[i]) { first = i; break }
  if (first < 0 || first >= peak[0]) return false
  for (const i of peak) if (!pattern[i]) return false
  return true
}

// ── Gate C: pool audit per weekday ─────────────────────────────────────
const DOW_NAMES: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' }
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Gate C — weekday pattern & anchor supply per day-of-week')
console.log('══════════════════════════════════════════════════════════════════════')
console.log('  dow  day  totalPatterns  valid  lunchAnchor  dinnerAnchor')
for (const dow of [1, 2, 3, 4, 5, 6, 0]) { // Mon-Sun order
  const tpl = DAY_TEMPLATES[dow]
  const total = tpl.shiftPatterns.length
  const valid = tpl.shiftPatterns.filter((p) => isValidForDow(p, dow))
  const lunchAnchors = valid.filter((p) => isAnchorFor(p, LUNCH_PEAK_SLOTS)).length
  const dinnerAnchors = valid.filter((p) => isAnchorFor(p, DINNER_PEAK_SLOTS)).length
  const wknd = isWeekendDow(dow) ? ' (weekend)' : ''
  const flag = !isWeekendDow(dow) && (lunchAnchors < 2 || dinnerAnchors < 2) ? ' ← THIN' : ''
  console.log(`  ${dow}    ${DOW_NAMES[dow]}${wknd.padEnd(11, ' ')} ${String(total).padStart(3)}   ${String(valid.length).padStart(5)}   ${String(lunchAnchors).padStart(11)}   ${String(dinnerAnchors).padStart(12)}${flag}`)
}

// ── Gates A & B: emitted-shift audit ────────────────────────────────────
const schedule = generateSchedule(roster, '2026-06-25', '2026-09-09', {}, 42)

let gateAFail = 0
let gateBFail = 0
const violationsA: string[] = []
const violationsB: string[] = []

for (const ds of schedule.dispatcherSchedules) {
  for (const day of ds.days) {
    if (day.isOff) continue
    const blocks = patternWorkBlocks(day.slots, SLOTS)
    if (blocks.length === 0) continue
    const minBlock = Math.min(...blocks)
    const maxBlock = Math.max(...blocks)
    if (minBlock < MIN_BLOCK_HOURS) {
      gateAFail++
      if (violationsA.length < 6) violationsA.push(`${ds.dispatcher.name} ${day.date}: blocks=[${blocks.join(',')}]`)
    }
    const dow = day.dayOfWeek
    if (!isWeekendDow(dow) && maxBlock < WEEKDAY_PRIMARY_STRETCH_HOURS) {
      gateBFail++
      if (violationsB.length < 6) violationsB.push(`${ds.dispatcher.name} ${day.date} (${DOW_NAMES[dow]}): blocks=[${blocks.join(',')}]`)
    }
  }
}

console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate A — global 3h min block on every emitted shift')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  Violations: ${gateAFail}${gateAFail === 0 ? ' ✓' : ' ← FAIL'}`)
for (const v of violationsA) console.log(`    ${v}`)

console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Gate B — 5h primary stretch on every emitted Mon-Fri shift')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  Violations: ${gateBFail}${gateBFail === 0 ? ' ✓' : ' ← FAIL'}`)
for (const v of violationsB) console.log(`    ${v}`)

// Anchor warning count
let anchorWarns = 0
let restWarns = 0
let transitionWarns = 0
for (const ws of Object.values(schedule.coverageWarnings ?? {})) {
  for (const w of ws) {
    if (w.peak === 'lunch' || w.peak === 'dinner') anchorWarns++
    else if (w.peak === 'mandatory-rest') restWarns++
    else if (w.peak === 'transition') transitionWarns++
  }
}

console.log('\n══════════════════════════════════════════════════════════════════════')
console.log(' Warning counts across 11-week horizon')
console.log('══════════════════════════════════════════════════════════════════════')
console.log(`  peakWithoutAnchor: ${anchorWarns}`)
console.log(`  mandatory-rest:    ${restWarns}`)
console.log(`  transition:        ${transitionWarns}`)

const allPass = gateAFail === 0 && gateBFail === 0
console.log(`\n FINAL — Gate A: ${gateAFail === 0 ? 'PASS' : 'FAIL'}   Gate B: ${gateBFail === 0 ? 'PASS' : 'FAIL'}   Gate C: informational`)
if (!allPass) process.exit(1)
