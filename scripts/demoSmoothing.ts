/**
 * Demo for the transition-smoothing post-pass.
 *
 *   Run 1 — generateSchedule end-to-end on a regular week. Any
 *           [smoothTransitions] traces are real resolutions or warnings
 *           emitted during the normal scheduling flow.
 *
 *   Run 2A — hand-crafted day with a 1-below dip at slot 18 (10–11 PM).
 *           Frank works through slot 17, and extending forward keeps him
 *           within the 5h-consecutive labor-law rule → fallback-A
 *           nearest-neighbor net add resolves the dip. CASE (A).
 *
 *   Run 2B — hand-crafted day with a 1-below dip at slot 4 (11:30–12 PM).
 *           Bob is the only viable extender by shape, but timeOff blocks
 *           him at slot 4. Every other path (boundary, handoff, surplus,
 *           fallback-A) fails → the pass surfaces a `transition` warning.
 *           CASE (B).
 *
 * Run with: npx tsx scripts/demoSmoothing.ts
 */
import { generateSchedule, smoothTransitions } from '@/utils/scheduler'
import type { Dispatcher, DispatcherTimeOff } from '@/types/schedule'
import { SLOTS } from '@/data/coverageTemplate'

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7']
const names = ['Alice', 'Bob', 'Carla', 'Diego', 'Esther', 'Frank', 'Gina']
const dispatchers: Dispatcher[] = names.map((name, i) => ({
  id: `d${i + 1}`,
  name,
  color: COLORS[i],
  level: i === 0 ? 'Senior' : 'Regular',
}))

const n = SLOTS.length
const ones = (idxs: number[]): boolean[] => {
  const p = new Array<boolean>(n).fill(false)
  for (const i of idxs) p[i] = true
  return p
}

const originalInfo = console.info
const captureTraces = (sink: string[]) => (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  if (line.startsWith('[smoothTransitions]')) sink.push(line)
}

// ── Run 1: end-to-end ────────────────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Run 1: end-to-end generateSchedule (Thu 6/25 → Wed 7/1, seed=1)')
console.log('══════════════════════════════════════════════════════════════════════\n')

const traces1: string[] = []
console.info = captureTraces(traces1)
generateSchedule(dispatchers, '2026-06-25', '2026-07-01', {}, 1)
console.info = originalInfo

const r1Resolved = traces1.filter((t) => !t.endsWith('→ warning'))
const r1Warned = traces1.filter((t) => t.endsWith('→ warning'))
console.log(`Resolved (case A) — ${r1Resolved.length}:`)
for (const t of r1Resolved) console.log('  ✓ ' + t.replace('[smoothTransitions] ', ''))
console.log(`\nWarned (case B) — ${r1Warned.length}:`)
for (const t of r1Warned) console.log('  ⚠ ' + t.replace('[smoothTransitions] ', ''))

// ── Common helper for hand-crafted scenarios ────────────────────────────
function runScenario(
  label: string,
  assignmentsIn: Array<{ dispatcher: Dispatcher; pattern: boolean[] }>,
  requiredAdjustments: Array<{ slot: number; delta: number }>,
  blockSlotForOthers: { slot: number; keepers: string[] } | null,
) {
  const assignments = assignmentsIn.map((a) => ({ ...a, pattern: [...a.pattern] }))
  const actual = new Array<number>(n).fill(0)
  for (const { pattern } of assignments) pattern.forEach((on, i) => { if (on) actual[i]++ })
  const required = [...actual]
  for (const { slot, delta } of requiredAdjustments) required[slot] = actual[slot] + delta

  const weekHours: Record<string, Record<string, number>> = {}
  const smoothingBudget: Record<string, Record<string, number>> = {}
  for (const d of dispatchers) {
    weekHours[d.id] = { W: 20 }
    smoothingBudget[d.id] = { W: 0 }
  }
  const timeOff: DispatcherTimeOff = {}
  for (const d of dispatchers) timeOff[d.id] = {}
  const date = '2026-06-29'
  if (blockSlotForOthers) {
    for (const d of dispatchers) {
      if (blockSlotForOthers.keepers.includes(d.id)) continue
      const bm = new Array(n).fill(false)
      bm[blockSlotForOthers.slot] = true
      timeOff[d.id][date] = bm
    }
  }

  const dipSlots = requiredAdjustments.map((r) => r.slot)
  console.log(`Scenario: ${label}`)
  console.log('  pre-cov:  ' + required.map((r, i) => `${i}:${actual[i]}/${r}`).join(' '))
  console.log(`  dip:      ${dipSlots.map((i) => `slot ${i} (${SLOTS[i].label})`).join(', ')}\n`)

  const traces: string[] = []
  console.info = captureTraces(traces)
  const result = smoothTransitions({
    assignments, required, weekHours, smoothingBudget,
    wLabel: 'W', timeOff, dateStr: date, dow: 1,
  })
  console.info = originalInfo

  console.log(`  Resolved: ${result.resolved.length}`)
  for (const t of result.resolved) console.log('    ✓ ' + t)
  console.log(`  Unresolved (→ warning): ${result.unresolved.length}`)
  for (const i of result.unresolved) {
    console.log(`    ⚠ slot ${i} (${SLOTS[i].label}) — fallback B`)
  }

  const postCov = new Array<number>(n).fill(0)
  for (const { pattern } of assignments) pattern.forEach((on, i) => { if (on) postCov[i]++ })
  console.log('  post-cov: ' + required.map((r, i) => `${i}:${postCov[i]}/${r}${postCov[i] < r ? '*' : ''}`).join(' '))
  console.log('')
}

// ── Run 2A: hand-crafted (A) — Frank extends to plug slot 18 dip ───────
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Run 2A: hand-crafted day — net-add resolution (case A)')
console.log('══════════════════════════════════════════════════════════════════════\n')

// All shifts below are law-valid: ≤5h consecutive, ≥2h min block, breaks
// satisfy MED_SHIFT_BREAK_MIN=0.5h for 5–8h shifts, ≥4h daily floor.
runScenario(
  'slot 18 dip → Frank (works to slot 17) extends forward',
  [
    { dispatcher: dispatchers[0], pattern: ones([1, 2, 3, 4, 5, 6]) },          // Alice 9–2 (lunch anchor)
    { dispatcher: dispatchers[1], pattern: ones([5, 6, 7, 9, 10, 11]) },         // Bob 12–6 w/ break at 2:30
    { dispatcher: dispatchers[2], pattern: ones([4, 5, 6, 8, 9, 10]) },          // Carla 11:30–5 w/ break at 2
    { dispatcher: dispatchers[3], pattern: ones([6, 7, 8, 10, 11, 12, 13]) },    // Diego 1–8 w/ break at 3 (dinner anchor)
    { dispatcher: dispatchers[4], pattern: ones([6, 7, 8, 10, 11, 12, 13]) },    // Esther same
    { dispatcher: dispatchers[5], pattern: ones([10, 11, 12, 14, 15, 16, 17]) }, // Frank 3–10 w/ break at 7 ← extends to 18
    { dispatcher: dispatchers[6], pattern: ones([11, 12, 13, 14, 15, 16, 17]) }, // Gina 5–10 (one block, 5h continuous)
  ],
  [{ slot: 18, delta: 1 }],
  null,
)

// ── Run 2B: hand-crafted (B) — slot 4 dip, blocked extender → warning ──
console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Run 2B: hand-crafted day — fallback-B warning (case B)')
console.log('══════════════════════════════════════════════════════════════════════\n')

runScenario(
  'slot 4 dip → Bob can extend by shape, but is time-off-blocked at slot 4',
  [
    { dispatcher: dispatchers[0], pattern: ones([1, 2, 3, 4, 5, 6]) },          // Alice 9–2 (covers slot 4)
    { dispatcher: dispatchers[1], pattern: ones([5, 6, 7, 9, 10, 11]) },         // Bob 12–6 (would extend back into slot 4)
    { dispatcher: dispatchers[2], pattern: ones([4, 5, 6, 8, 9, 10]) },          // Carla 11:30–5 (covers slot 4)
    { dispatcher: dispatchers[3], pattern: ones([6, 7, 8, 10, 11, 12, 13]) },    // Diego 1–8
    { dispatcher: dispatchers[4], pattern: ones([6, 7, 8, 10, 11, 12, 13]) },    // Esther same
    { dispatcher: dispatchers[5], pattern: ones([10, 11, 12, 14, 15, 16, 17]) }, // Frank 3–10
    { dispatcher: dispatchers[6], pattern: ones([11, 12, 13, 14, 15, 16, 17]) }, // Gina 5–10
  ],
  [{ slot: 4, delta: 1 }],
  // Block slot 4 for everyone EXCEPT Alice + Carla (the two already there).
  // Bob is the only fallback-A candidate (works slot 5 with extendable
  // shape); blocking him forces fallback-B.
  { slot: 4, keepers: [dispatchers[0].id, dispatchers[2].id] },
)
