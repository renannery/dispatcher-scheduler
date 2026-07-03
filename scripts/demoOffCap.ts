/**
 * Operational-week off-cap gate.
 *
 * Guards the ≤2 days-off/week cap (Regular/Senior) and ≤1 (Trainee) against
 * a coordination leak between the three mechanisms that can each place a day
 * off — Phase 0 mandatory rest, the rotating 2nd-off grant, and the trim.
 *
 * The leak this gate exists to catch (seen once in 77 dispatcher-weeks): a
 * PARTIAL time-off day can silently collapse to a full day off (the picker
 * finds no legal shift in the narrow open window). The rotating 2nd-off's
 * feasibility gate counts only rest locks + FULL-day blocks as known offs,
 * so it grants a 2nd off never seeing the partial day coming — Phase 0 rest
 * + partial-off + grant = 3, past the cap, with no single mechanism aware of
 * the running total. Reproduced from the exact snapshot that leaked:
 * Kimberly (Senior), week Jul 30 – Aug 5, 2026, with an evening time-off
 * block on Wed Aug 5.
 *
 *   Gate A — snapshot scenario: the real 7-dispatcher roster + the exact
 *            time-off inputs from the leaked snapshot, swept across seeds and
 *            cursors. NO full Thu–Wed week may exceed the cap for anyone.
 *   Gate B — empty-time-off roster: the grant-only path, swept across seeds.
 *   Gate C — the specific reproduce case (seed 102, cursor 112 — the stored
 *            snapshot's own seed, which reproduces it 99.8%): Kimberly's
 *            Jul 30 – Aug 5 week must be ≤ 2 days off.
 *   Also asserts 0 operating-slot zeros in every run (the fix un-offs a body,
 *   which only raises coverage — it must never open a zero).
 *
 * Exit code: 0 if all gates pass, 1 if any full week exceeds the cap or any
 * run ships a 0-coverage operating slot.
 *
 * Run with: npx tsx scripts/demoOffCap.ts
 */
import { generateSchedule } from '@/utils/scheduler'
import type { Dispatcher, DispatcherTimeOff, GeneratedSchedule } from '@/types/schedule'

const startDate = '2026-06-25' // Thu
const endDate = '2026-09-09' // Wed

// Production roster (ids match the leaked snapshot so time-off keys line up).
const roster: Dispatcher[] = [
  { id: 'l1dydyt', name: 'adorre', color: '#10b981', level: 'Regular' },
  { id: '0gjtabx', name: 'ayrton', color: '#3b82f6', level: 'Senior' },
  { id: 'fmvecxr', name: 'kimberly', color: '#ef4444', level: 'Senior' },
  { id: 'xb9f7rj', name: 'michelle', color: '#06b6d4', level: 'Senior' },
  { id: '75pmgeu', name: 'paula', color: '#8b5cf6', level: 'Senior' },
  { id: 'zfqp9my', name: 'resgie', color: '#f59e0b', level: 'Trainee' },
  { id: 'foczori', name: 'shamika', color: '#ec4899', level: 'Trainee' },
]

const full = () => new Array(20).fill(true)
const evening = () => Array.from({ length: 20 }, (_, i) => i >= 10) // slots 10–19 (4 PM–11:30 PM)
const range = (from: string, to: string) => {
  const out: string[] = []
  const d = new Date(from + 'T12:00:00')
  const end = new Date(to + 'T12:00:00')
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 1)
  }
  return out
}

// Exact time-off from the leaked snapshot. Kimberly's Aug 5 evening block is
// the trigger — the partial day that becomes a full off on top of a rest lock.
const snapshotTimeOff: DispatcherTimeOff = {
  '0gjtabx': Object.fromEntries(range('2026-06-11', '2026-06-24').map((d) => [d, full()])),
  'xb9f7rj': { '2026-06-25': full() },
  '75pmgeu': { '2026-06-25': full(), '2026-07-03': full() },
  'fmvecxr': { '2026-07-05': full(), '2026-07-19': evening(), '2026-08-05': evening() },
}

// Exact per-day coverage overrides from the leaked snapshot (a calmer,
// hand-calibrated profile — not the base templates). Faithful reproduction
// of the leak depends on these being byte-identical to the snapshot.
const coverageOverrides: Record<number, number[]> = {
  0: [1, 2, 2, 1, 1, 2, 2, 2, 2, 1, 2, 3, 3, 3, 3, 3, 3, 2, 1, 1],
  1: [0, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1],
  2: [0, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1],
  3: [0, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1],
  4: [0, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1],
  5: [0, 2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 3, 2, 1],
  6: [1, 2, 2, 1, 1, 2, 2, 2, 2, 1, 2, 3, 3, 3, 3, 3, 3, 2, 1, 1],
}

const maxOff = (level: string) => (level === 'Trainee' ? 1 : 2)

interface WeekViol { seed: number; cursor: number; name: string; level: string; week: string; offs: number; dates: string[]; flagged: boolean }

// Audit a generated schedule: return every full Thu–Wed week over cap that is
// NOT flagged as a law-forced exception (an UNFLAGGED >cap week is an accidental
// leak → build failure); flagged law-forced weeks are expected and pass. Also
// returns a count of operating-slot zeros and the flagged law-forced weeks.
function auditRun(sch: GeneratedSchedule, seed: number, cursor: number) {
  // date → weekLabel and weekLabel → #days-in-horizon (only 7-day weeks count).
  const weekOf: Record<string, string> = {}
  const weekSize: Record<string, number> = {}
  for (const d of sch.dates) {
    weekOf[d.date] = d.weekLabel
    weekSize[d.weekLabel] = (weekSize[d.weekLabel] ?? 0) + 1
  }
  // (dispatcherId|weekLabel) flagged as a law-forced cap exception.
  const flaggedKey = new Set(
    (sch.secondOffLog ?? []).filter((r) => r.forcedThirdOff).map((r) => r.candidateId + '|' + r.weekLabel),
  )
  const viols: WeekViol[] = []
  let flaggedCount = 0
  for (const ds of sch.dispatcherSchedules) {
    const perWeek: Record<string, string[]> = {}
    for (const day of ds.days) {
      if (!day.isOff) continue
      ;(perWeek[weekOf[day.date]] ??= []).push(day.date)
    }
    for (const [week, dates] of Object.entries(perWeek)) {
      if (weekSize[week] !== 7) continue // skip partial edge weeks
      if (dates.length <= maxOff(ds.dispatcher.level)) continue
      const flagged = flaggedKey.has(ds.dispatcher.id + '|' + week)
      if (flagged) { flaggedCount++; continue } // law-forced, surfaced — OK
      viols.push({ seed, cursor, name: ds.dispatcher.name, level: ds.dispatcher.level, week, offs: dates.length, dates, flagged })
    }
  }
  // operating-slot zeros (target > 0, coverage 0)
  let zeros = 0
  for (const d of sch.dates) {
    const req = sch.coverageRequired?.[d.date] ?? []
    const act = sch.coverageActual[d.date] ?? []
    req.forEach((r, i) => { if (r > 0 && (act[i] ?? 0) === 0) zeros++ })
  }
  return { viols, zeros, flaggedCount }
}

let failed = false
const allViols: WeekViol[] = []
let totalZeros = 0
let runs = 0

function sweep(label: string, timeOff: DispatcherTimeOff, seeds: number[], cursors: number[]) {
  let localViol = 0
  let localZero = 0
  for (const seed of seeds) {
    for (const cursor of cursors) {
      const sch = generateSchedule(roster, startDate, endDate, timeOff, seed, coverageOverrides, cursor)
      const { viols, zeros } = auditRun(sch, seed, cursor)
      runs++
      localViol += viols.length
      localZero += zeros
      allViols.push(...viols)
      totalZeros += zeros
    }
  }
  const ok = localViol === 0 && localZero === 0
  if (!ok) failed = true
  console.log(
    `${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${seeds.length}×${cursors.length} runs — ` +
      `${localViol} cap violation(s), ${localZero} zero-slot(s)`,
  )
}

console.log('═══ Operational-week off-cap gate ═══\n')

// Gate A — the snapshot scenario (the leak's real inputs), swept across seeds
// and cursors. The stored artifact was seed 101/102, cursor 112.
const seedsA = Array.from({ length: 41 }, (_, i) => 90 + i) // 90..130 (covers 101/102)
sweep('Gate A · snapshot time-off', snapshotTimeOff, seedsA, [112, 0, 89])

// Gate B — grant-only path with no time-off, swept across seeds.
const seedsB = Array.from({ length: 41 }, (_, i) => i) // 0..40
sweep('Gate B · empty time-off  ', {}, seedsB, [0])

// Gate C — the exact reproduce case: Kimberly Jul 30 – Aug 5 must be ≤ 2 off.
const repro = generateSchedule(roster, startDate, endDate, snapshotTimeOff, 102, coverageOverrides, 112)
const kim = repro.dispatcherSchedules.find((x) => x.dispatcher.name === 'kimberly')!
const kimWeekOff = kim.days.filter(
  (d) => !!repro.dates.find((x) => x.date === d.date && x.weekLabel.startsWith('Jul 30')) && d.isOff,
)
const gateCok = kimWeekOff.length <= 2
if (!gateCok) failed = true
console.log(
  `${gateCok ? '✅ PASS' : '❌ FAIL'}  Gate C · reproduce case: Kimberly Jul 30 – Aug 5 = ` +
    `${kimWeekOff.length} day(s) off [${kimWeekOff.map((d) => d.date).join(', ')}] (cap 2)`,
)

// Gate D — synthetic LAW-FORCED case: a dispatcher with 3 full-day time-off in
// one operational week CANNOT be < 3 days off. The ≤2 cap must YIELD — but the
// extra off must be FLAGGED (forcedThirdOff), surfaced not silent, and the gate
// must PASS on it (a flagged law-forced week is expected, not an accidental
// leak). This proves the accidental / law-forced distinction works both ways.
const lawForcedTimeOff: DispatcherTimeOff = {
  ...snapshotTimeOff,
  fmvecxr: {
    ...(snapshotTimeOff.fmvecxr ?? {}),
    '2026-08-06': full(), // Thu ┐
    '2026-08-07': full(), // Fri ├ 3 full-day blocks in the Aug 6–12 week
    '2026-08-08': full(), // Sat ┘
  },
}
const lf = generateSchedule(roster, startDate, endDate, lawForcedTimeOff, 102, coverageOverrides, 112)
const lfKimWeek = lf.dispatcherSchedules
  .find((x) => x.dispatcher.name === 'kimberly')!
  .days.filter((d) => !!lf.dates.find((x) => x.date === d.date && x.weekLabel.startsWith('Aug 6')) && d.isOff)
const lfFlag = (lf.secondOffLog ?? []).find(
  (r) => r.forcedThirdOff && r.candidateName === 'kimberly' && r.weekLabel.startsWith('Aug 6'),
)
const lfAudit = auditRun(lf, 102, 112)
const gateDok = lfKimWeek.length >= 3 && !!lfFlag && lfAudit.viols.length === 0
if (!gateDok) failed = true
console.log(
  `${gateDok ? '✅ PASS' : '❌ FAIL'}  Gate D · law-forced flag: Kimberly ${lfKimWeek.length} offs in Aug 6–12 ` +
    `(3 full-day time-off) → flagged=${!!lfFlag}, unflagged-leaks=${lfAudit.viols.length} (must be 0)`,
)
if (lfFlag) console.log(`         └─ surfaced as: "${lfFlag.reason}"`)

console.log(`\nTotal runs: ${runs + 1} · cap violations: ${allViols.length} · zero-slots: ${totalZeros}`)
if (allViols.length) {
  console.log('\nCap violations:')
  for (const v of allViols)
    console.log(`  ✗ seed ${v.seed}/cur ${v.cursor}: ${v.name}(${v.level}) ${v.week} = ${v.offs} offs [${v.dates.join(', ')}]`)
}

console.log(`\n${failed ? '❌ OFF-CAP GATE FAILED' : '✅ OFF-CAP GATE PASSED'}`)
process.exit(failed ? 1 : 0)
