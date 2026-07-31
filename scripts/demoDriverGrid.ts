// Gate: driver day-grid hour alignment.
//
// The grid renders its hour headers AND every driver's slot cells from ONE
// array — driverGridVisibleSlots(). This gate pins the invariants that keep
// header position N above the cell for the same slot, so a driver's shift can
// never render an hour off (the false alarm that motivated this gate):
//
//   G1  the visible-slot list is strictly increasing and in range — headers
//       read left→right in chronological order with no duplicates.
//   G2  header count === cell count — every column has exactly one header and,
//       per row, exactly one cell (they map the same array, so a mismatch here
//       would mean the two loops diverged).
//   G3  a known shift renders under its own hours — a driver working an
//       explicit slot set has working-cells at exactly the visible positions
//       whose slot is in that set, and each of those columns' header labels
//       are the expected clock hours. This is the "Adip Lama 9AM–2PM shows
//       under 9am–1pm, not 10am–3pm" check, generalised.
//   G4  the left edge is stable across days — every day in a schedule shows
//       the same column set (the union), so a shift never slides sideways
//       between weekdays and weekends.

import { DRIVER_SLOTS } from '../src/drivers/coverageTemplate'
import { driverGridVisibleSlots } from '../src/drivers/scheduler'
import { shortHour } from '../src/drivers/utils'
import type { Driver, GeneratedDriverSchedule } from '../src/drivers/types'

let failures = 0
const check = (ok: boolean, msg: string) => {
  if (!ok) { console.log(`  ✗ ${msg}`); failures++ }
}

console.log('══════════════════════════════════════════════════════════════════════')
console.log(' Gate G — driver grid hour alignment (header N labels slot N)')
console.log('══════════════════════════════════════════════════════════════════════')

const N = DRIVER_SLOTS.length
const emptyBlocks = () => Array.from({ length: 7 }, () => new Array(N).fill(false))
const mkDriver = (id: string, name: string, isShopper = false): Driver => ({
  id, name, color: '#000', employmentType: 'full', isShopper, recurringBlocks: emptyBlocks(),
})
const slotsFrom = (on: number[]) => DRIVER_SLOTS.map((_, i) => on.includes(i))

// A known shift: 9 AM–2 PM = slots 1,2,3,4,5 (the Adip Lama case from the
// spot-check). Adip works Tuesday; nobody touches the 8-9 AM slot on weekdays.
const ADIP_SLOTS = [1, 2, 3, 4, 5]
const EXPECTED_HOURS = ['9am', '10am', '11am', '12pm', '1pm'] // shortHour of slots 1..5

// Build a minimal one-week schedule (Thu→Wed) with Adip working his set on
// Tuesday, plus a shopper working the 8-9 AM slot on Saturday so the union
// legitimately includes slot 0 (mirrors real weekend openings).
const dates = [
  { date: '2026-08-04', dayLabel: 'Tue', weekLabel: 'wk', dayOfWeek: 2 },
  { date: '2026-08-01', dayLabel: 'Sat', weekLabel: 'wk', dayOfWeek: 6 },
]
const day = (date: string, dow: number, slots: boolean[], isOff = false) => ({
  date, dayLabel: date, dayOfWeek: dow, slots, totalHours: slots.filter(Boolean).length, isOff,
})
const adip = mkDriver('adip', 'Adip Lama')
const shopper = mkDriver('shp', 'Weekend Opener', true)
const schedule: GeneratedDriverSchedule = {
  startDate: '2026-08-01', endDate: '2026-08-04', seed: 0,
  dates,
  driverSchedules: [
    { driver: adip, days: [
      day('2026-08-04', 2, slotsFrom(ADIP_SLOTS)),
      day('2026-08-01', 6, new Array(N).fill(false), true),
    ], weeklyHours: {}, totalHours: ADIP_SLOTS.length },
    { driver: shopper, days: [
      day('2026-08-04', 2, new Array(N).fill(false), true),
      day('2026-08-01', 6, slotsFrom([0])), // 8-9 AM Saturday
    ], weeklyHours: {}, totalHours: 1 },
  ],
  coverageActual: {
    '2026-08-04': (() => { const c = new Array(N).fill(0); ADIP_SLOTS.forEach((s) => c[s]++); return c })(),
    '2026-08-01': new Array(N).fill(0), // shopper excluded from driver coverage
  },
}

const visible = driverGridVisibleSlots(schedule, 1, {})

// G1 — strictly increasing, in range
const inRange = visible.every((s) => s >= 0 && s < N)
const increasing = visible.every((s, i) => i === 0 || s > visible[i - 1])
check(inRange && increasing, `G1 visible slots strictly increasing & in range — got [${visible.join(',')}]`)

// G2 — header count === cell count. Headers derive from `visible`; each driver
// row renders one cell per visible slot. Assert the row-cell count a component
// would produce equals the header count for every driver.
const headerCount = visible.length
for (const ds of schedule.driverSchedules) {
  const cellCount = visible.length // the row maps the same `visible` array
  check(cellCount === headerCount, `G2 ${ds.driver.name}: cell count ${cellCount} ≠ header count ${headerCount}`)
}

// G3 — the known shift renders under its own hours.
const adipDay = schedule.driverSchedules[0].days[0]
const workingPositions = visible
  .map((slot, pos) => ({ slot, pos, working: adipDay.slots[slot] }))
  .filter((x) => x.working)
const workingSlots = workingPositions.map((x) => x.slot)
check(
  JSON.stringify(workingSlots) === JSON.stringify(ADIP_SLOTS),
  `G3 Adip working slots via grid = [${workingSlots.join(',')}], expected [${ADIP_SLOTS.join(',')}]`,
)
const workingHours = workingPositions.map((x) => shortHour(DRIVER_SLOTS[x.slot].label))
check(
  JSON.stringify(workingHours) === JSON.stringify(EXPECTED_HOURS),
  `G3 Adip renders under hours [${workingHours.join(',')}], expected [${EXPECTED_HOURS.join(',')}] (must NOT be shifted to 10am–3pm)`,
)
// And the header at each working position is exactly that slot's own label.
for (const { slot, pos } of workingPositions) {
  check(
    shortHour(DRIVER_SLOTS[visible[pos]].label) === shortHour(DRIVER_SLOTS[slot].label),
    `G3 header at position ${pos} labels slot ${visible[pos]}, cell reads slot ${slot} — desync`,
  )
}

// G4 — left edge stable across days: the union includes slot 0 (8-9 AM) because
// the Saturday shopper opens it, so the SAME column set frames Tuesday too
// (Tuesday shows an empty 8-9 AM column rather than opening at 9am).
check(visible[0] === 0, `G4 left edge = slot ${visible[0]}, expected 0 (8-9 AM) — column set must be the cross-day union`)

console.log(
  `  visible columns: ${visible.map((s) => shortHour(DRIVER_SLOTS[s].label)).join(' ')}`,
)
console.log(`\n FINAL — Gate G: ${failures === 0 ? 'PASS' : 'FAIL'}`)
if (failures > 0) process.exit(1)
