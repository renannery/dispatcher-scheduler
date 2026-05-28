import * as XLSX from 'xlsx'
import { format, parseISO } from 'date-fns'

import { DRIVER_SLOTS } from './coverageTemplate'
import type { GeneratedDriverSchedule } from './types'

// ─── Layout constants (mirroring the reference workbook exactly) ────────────
// The backend importer parses this file by content markers AND row positions,
// so the exact spacing matters. Reference uses 71 rows between block 1 and 2
// (one extra blank row), then 70 rows between subsequent blocks.
const DATA_ROWS = 63                    // rows reserved per day-block for driver rows
const FIRST_HEADER_ROW = 5              // first day-block's header is at row 5 (1-indexed)
const FIRST_TRANSITION_GAP = 71         // header-to-header gap for the first transition
const SUBSEQUENT_TRANSITION_GAP = 70    // header-to-header gap for blocks 2+

const SLOT_LABELS = DRIVER_SLOTS.map((s) => s.label.replace('–', '-'))
const SLOT_COUNT = 15                   // C..Q (15 hourly slots, 8 AM–11 PM)

// Title-case day names — the sheet is named after the schedule's first day.
const DAY_NAMES_TITLE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_NAMES_UPPER = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

interface DayBlockData {
  date: string         // YYYY-MM-DD
  dayOfWeek: number
  drivers: { name: string; slots: boolean[] }[]
}

// ─── Cell helpers ──────────────────────────────────────────────────────────
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
function dateToExcelSerial(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH_MS) / 86400000)
}

function setCell(ws: XLSX.WorkSheet, addr: string, value: string | number | Date) {
  if (value instanceof Date) {
    // Match the reference's format exactly (`d/m/yyyy`, what the backend
    // parser expects). SheetJS registers this as a custom numFmt and the
    // cell references it — equivalent shape to the reference's xf 7.
    ws[addr] = { t: 'n', v: dateToExcelSerial(value), z: 'd/m/yyyy' }
  } else if (typeof value === 'number') {
    ws[addr] = { t: 'n', v: value }
  } else {
    ws[addr] = { t: 's', v: value }
  }
}

function setFormula(ws: XLSX.WorkSheet, addr: string, formula: string) {
  ws[addr] = { t: 'n', f: formula.replace(/^=/, '') }
}

function colLetter(idx1Based: number): string {
  return XLSX.utils.encode_col(idx1Based - 1)
}

function addr(col1: number, row1: number): string {
  return `${colLetter(col1)}${row1}`
}

function addMerge(ws: XLSX.WorkSheet, range: string) {
  if (!ws['!merges']) ws['!merges'] = []
  ws['!merges'].push(XLSX.utils.decode_range(range))
}

function ensureRef(ws: XLSX.WorkSheet, maxRow: number, maxCol: number) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: maxCol - 1, r: maxRow - 1 } })
}

// Header row index for block N (0-indexed). Layout:
//   block 0 header = 5
//   block 1 header = 5 + 71 = 76         (one blank row above title strip)
//   block 2 header = 76 + 70 = 146       (no blank row above title strip)
//   block 3 header = 146 + 70 = 216
//   ...
function blockHeaderRow(blockIdx: number): number {
  if (blockIdx === 0) return FIRST_HEADER_ROW
  return FIRST_HEADER_ROW + FIRST_TRANSITION_GAP + (blockIdx - 1) * SUBSEQUENT_TRANSITION_GAP
}

// ─── Per-block writer ──────────────────────────────────────────────────────
function writeTitleStrip(ws: XLSX.WorkSheet, headerRow: number, blockDate: Date) {
  // Title strip occupies the 4 rows immediately above the header row:
  //   headerRow - 4: B='Shift Schedule'  (merged B:F)
  //   headerRow - 3: B='For the Week of: ', D=blockDate (merged D:F)
  //   headerRow - 2: B='Department Name: '  (merged D:F)
  //   headerRow - 1: blank
  const r1 = headerRow - 4
  const r2 = headerRow - 3
  const r3 = headerRow - 2

  setCell(ws, addr(2, r1), 'Shift Schedule')
  addMerge(ws, `${addr(2, r1)}:${addr(6, r1)}`)

  setCell(ws, addr(2, r2), 'For the Week of: ')
  setCell(ws, addr(4, r2), blockDate)
  addMerge(ws, `${addr(4, r2)}:${addr(6, r2)}`)

  setCell(ws, addr(2, r3), 'Department Name: ')
  addMerge(ws, `${addr(4, r3)}:${addr(6, r3)}`)
}

function writeBlock(
  ws: XLSX.WorkSheet,
  sheetName: string,
  blockIdx: number,
  block: DayBlockData,
) {
  const headerRow = blockHeaderRow(blockIdx)
  const dayName = DAY_NAMES_UPPER[block.dayOfWeek]
  const blockDate = parseISO(block.date)

  writeTitleStrip(ws, headerRow, blockDate)

  // ── Header row: B=DAY, C..Q=slot labels, R='TOTAL' ───────────────────────
  setCell(ws, addr(2, headerRow), dayName)
  for (let s = 0; s < SLOT_COUNT; s++) {
    setCell(ws, addr(3 + s, headerRow), SLOT_LABELS[s])
  }
  setCell(ws, addr(18, headerRow), 'TOTAL')

  // ── Data rows ────────────────────────────────────────────────────────────
  for (let i = 0; i < DATA_ROWS; i++) {
    const r = headerRow + 1 + i
    // A: =row(A{i+1}) — lowercase to match the reference exactly
    setFormula(ws, addr(1, r), `row(A${i + 1})`)

    if (i < block.drivers.length) {
      const drv = block.drivers[i]
      setCell(ws, addr(2, r), drv.name)
      for (let s = 0; s < SLOT_COUNT; s++) {
        if (drv.slots[s]) setCell(ws, addr(3 + s, r), drv.name)
      }
    }
    // R: per-row COUNTIF includes the sheet name prefix (backend requires it)
    setFormula(ws, addr(18, r), `COUNTIF(${sheetName}!$C${r}:$Q${r},"*")`)
  }

  // ── Footer row: B=DAY, C..Q=slot labels (no TOTAL header) ────────────────
  const footerRow = headerRow + 1 + DATA_ROWS
  setCell(ws, addr(2, footerRow), dayName)
  for (let s = 0; s < SLOT_COUNT; s++) {
    setCell(ws, addr(3 + s, footerRow), SLOT_LABELS[s])
  }

  // ── Totals row: per-slot COUNTIFs (with sheet prefix), SUM in R ──────────
  const totalsRow = footerRow + 1
  const dataStart = headerRow + 1
  const dataEnd = headerRow + DATA_ROWS
  for (let s = 0; s < SLOT_COUNT; s++) {
    const col = colLetter(3 + s)
    setFormula(ws, addr(3 + s, totalsRow), `COUNTIF(${sheetName}!${col}${dataStart}:${col}${dataEnd},"*")`)
  }
  setFormula(ws, addr(18, totalsRow), `SUM(R${dataStart}:R${dataEnd})`)
}

// ─── Public API ────────────────────────────────────────────────────────────
export function buildDriverWorkbook(schedule: GeneratedDriverSchedule): XLSX.WorkBook {
  return buildWb(schedule)
}

export function exportDriverScheduleToXLS(
  schedule: GeneratedDriverSchedule,
  filename?: string,
): void {
  const wb = buildWb(schedule)
  const weekStart = parseISO(schedule.startDate)
  const fname =
    filename ??
    `${format(weekStart, "MMMM do yyyy")} to ${format(parseISO(schedule.endDate), "MMMM do yyyy")} Drivers Schedule.xlsx`
  XLSX.writeFile(wb, fname)
}

function buildWb(schedule: GeneratedDriverSchedule): XLSX.WorkBook {
  // One block per day in schedule order; each driver who works that day
  // appears as a row, slots populated with their name.
  const blocks: DayBlockData[] = schedule.dates.map((dateInfo) => ({
    date: dateInfo.date,
    dayOfWeek: dateInfo.dayOfWeek,
    drivers: schedule.driverSchedules
      .map((ds) => {
        const entry = ds.days.find((d) => d.date === dateInfo.date)
        if (!entry || entry.isOff) return null
        return { name: ds.driver.name, slots: entry.slots }
      })
      .filter((d): d is { name: string; slots: boolean[] } => d !== null),
  }))

  const wb = XLSX.utils.book_new()
  const sheetName = DAY_NAMES_TITLE[blocks[0]?.dayOfWeek ?? 4]  // default Thursday

  const ws: XLSX.WorkSheet = {}
  blocks.forEach((b, i) => writeBlock(ws, sheetName, i, b))
  const lastHeaderRow = blockHeaderRow(blocks.length - 1)
  const maxRow = lastHeaderRow + DATA_ROWS + 2  // header + data + footer + totals
  ensureRef(ws, maxRow, 18)
  ws['!cols'] = [
    { wch: 5 },   // A
    { wch: 18 },  // B
    ...Array(SLOT_COUNT).fill({ wch: 11 }),  // C..Q
    { wch: 10 }, // R
  ]
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  return wb
}
