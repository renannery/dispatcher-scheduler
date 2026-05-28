import * as XLSX from 'xlsx'
import { format, parseISO } from 'date-fns'

import { DRIVER_SLOTS } from './coverageTemplate'
import type { GeneratedDriverSchedule } from './types'

// ─── Layout constants (mirroring the reference workbook) ────────────────────
const DATA_ROWS = 63                  // rows reserved per day-block for driver rows
const BLOCK_ROWS = DATA_ROWS + 8      // header(1) + data + footer(1) + totals(1) + blank(1) + title(3) + blank(1)
const FIRST_HEADER_ROW = 5            // first day-block's header is at row 5 (1-indexed)

const SLOT_LABELS = DRIVER_SLOTS.map((s) => s.label.replace('–', '-'))
const SLOT_COUNT_MAIN = 15            // C..Q
const SLOT_COUNT_BACK = 14            // C..P (drops 10-11 PM); Q is "Sick?"

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

interface DayBlockData {
  date: string         // YYYY-MM-DD
  dayOfWeek: number
  drivers: { name: string; slots: boolean[] }[]
}

// ─── Cell helpers ──────────────────────────────────────────────────────────
// Excel date serial: 1 = 1900-01-01, with a one-day shift for the Lotus 1-2-3
// "1900 is a leap year" bug. We compute against the conventional 1899-12-30
// epoch and feed an integer serial so SheetJS doesn't drift the value via
// local-timezone Date round-tripping.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
function dateToExcelSerial(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH_MS) / 86400000)
}

function setCell(ws: XLSX.WorkSheet, addr: string, value: string | number | Date) {
  if (value instanceof Date) {
    ws[addr] = { t: 'n', v: dateToExcelSerial(value), z: 'm/d/yyyy' }
  } else if (typeof value === 'number') {
    ws[addr] = { t: 'n', v: value }
  } else {
    ws[addr] = { t: 's', v: value }
  }
}

function setFormula(ws: XLSX.WorkSheet, addr: string, formula: string) {
  // SheetJS represents formulas via `f` (without leading "=")
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

// ─── Per-block writers ─────────────────────────────────────────────────────
function writeTitleStrip(ws: XLSX.WorkSheet, headerRow: number, weekStartDate: Date) {
  // Title strip occupies the 4 rows immediately above the header row:
  //   headerRow - 4: B='Shift Schedule'  (merged B:F)
  //   headerRow - 3: B='For the Week of: ', D=date (merged D:F)
  //   headerRow - 2: B='Department Name: '  (merged D:F)
  //   headerRow - 1: blank
  const r1 = headerRow - 4
  const r2 = headerRow - 3
  const r3 = headerRow - 2

  setCell(ws, addr(2, r1), 'Shift Schedule')
  addMerge(ws, `${addr(2, r1)}:${addr(6, r1)}`)

  setCell(ws, addr(2, r2), 'For the Week of: ')
  setCell(ws, addr(4, r2), weekStartDate)
  addMerge(ws, `${addr(4, r2)}:${addr(6, r2)}`)

  setCell(ws, addr(2, r3), 'Department Name: ')
  addMerge(ws, `${addr(4, r3)}:${addr(6, r3)}`)
}

function writeMainBlock(
  ws: XLSX.WorkSheet,
  blockIdx: number,
  block: DayBlockData,
  weekStartDate: Date,
) {
  const headerRow = FIRST_HEADER_ROW + blockIdx * BLOCK_ROWS
  const dayName = DAY_NAMES[block.dayOfWeek]
  const sheetName = DAY_NAMES[blockIdx === 0 ? block.dayOfWeek : 0] // placeholder, real sheet name set later

  // ── Title strip ──────────────────────────────────────────────────────────
  // First block gets a title strip above starting at row 1.
  // Subsequent blocks get a title strip above starting at headerRow - 4.
  if (blockIdx === 0) {
    setCell(ws, 'B1', 'Shift Schedule')
    addMerge(ws, 'B1:F1')
    setCell(ws, 'B2', 'For the Week of: ')
    setCell(ws, 'D2', weekStartDate)
    addMerge(ws, 'D2:F2')
    setCell(ws, 'B3', 'Department Name: ')
    addMerge(ws, 'D3:F3')
  } else {
    writeTitleStrip(ws, headerRow, weekStartDate)
  }

  // ── Header row: B=DAY, C..Q=slot labels, R='TOTAL' ───────────────────────
  setCell(ws, addr(2, headerRow), dayName)
  for (let s = 0; s < SLOT_COUNT_MAIN; s++) {
    setCell(ws, addr(3 + s, headerRow), SLOT_LABELS[s])
  }
  setCell(ws, addr(18, headerRow), 'TOTAL')

  // ── Data rows ────────────────────────────────────────────────────────────
  for (let i = 0; i < DATA_ROWS; i++) {
    const r = headerRow + 1 + i
    // A: =ROW(A{i+1}) → produces the row number as a plain integer
    setFormula(ws, addr(1, r), `ROW(A${i + 1})`)

    if (i < block.drivers.length) {
      const drv = block.drivers[i]
      setCell(ws, addr(2, r), drv.name)
      for (let s = 0; s < SLOT_COUNT_MAIN; s++) {
        if (drv.slots[s]) setCell(ws, addr(3 + s, r), drv.name)
      }
    }
    // R: total formula counts non-empty slot cells across C..Q
    setFormula(ws, addr(18, r), `COUNTIF($C${r}:$Q${r},"*")`)
  }

  // ── Footer row: B=DAY, C..Q=slot labels (no TOTAL header) ────────────────
  const footerRow = headerRow + 1 + DATA_ROWS
  setCell(ws, addr(2, footerRow), dayName)
  for (let s = 0; s < SLOT_COUNT_MAIN; s++) {
    setCell(ws, addr(3 + s, footerRow), SLOT_LABELS[s])
  }

  // ── Totals row: C..Q = COUNTIF per slot column, R = SUM(R{data}) ────────
  const totalsRow = footerRow + 1
  const dataStart = headerRow + 1
  const dataEnd = headerRow + DATA_ROWS
  for (let s = 0; s < SLOT_COUNT_MAIN; s++) {
    const col = colLetter(3 + s)
    setFormula(ws, addr(3 + s, totalsRow), `COUNTIF(${col}${dataStart}:${col}${dataEnd},"*")`)
  }
  setFormula(ws, addr(18, totalsRow), `SUM(R${dataStart}:R${dataEnd})`)

  void sheetName  // suppress unused
}

function writeBackOfficeBlock(
  ws: XLSX.WorkSheet,
  blockIdx: number,
  block: DayBlockData,
  weekStartDate: Date,
) {
  const headerRow = FIRST_HEADER_ROW + blockIdx * BLOCK_ROWS
  const dayName = DAY_NAMES[block.dayOfWeek]

  if (blockIdx === 0) {
    setCell(ws, 'B1', 'Shift Schedule')
    addMerge(ws, 'B1:F1')
    setCell(ws, 'B2', 'For the Week of: ')
    setCell(ws, 'D2', weekStartDate)
    addMerge(ws, 'D2:F2')
    setCell(ws, 'B3', 'Department Name: ')
    addMerge(ws, 'D3:F3')
  } else {
    writeTitleStrip(ws, headerRow, weekStartDate)
  }

  // Header: B=DAY, C..P=14 hour slots (8 AM–10 PM), Q='Sick?', R='TOTAL'
  setCell(ws, addr(2, headerRow), dayName)
  for (let s = 0; s < SLOT_COUNT_BACK; s++) {
    setCell(ws, addr(3 + s, headerRow), SLOT_LABELS[s])
  }
  setCell(ws, addr(17, headerRow), 'Sick?')
  setCell(ws, addr(18, headerRow), 'TOTAL')

  for (let i = 0; i < DATA_ROWS; i++) {
    const r = headerRow + 1 + i
    setFormula(ws, addr(1, r), `ROW(A${i + 1})`)

    if (i < block.drivers.length) {
      const drv = block.drivers[i]
      setCell(ws, addr(2, r), drv.name)
      // Drop the last slot (10–11 PM) — BackOffice File format covers 8 AM–10 PM only
      for (let s = 0; s < SLOT_COUNT_BACK; s++) {
        if (drv.slots[s]) setCell(ws, addr(3 + s, r), drv.name)
      }
      // Q (Sick?) left blank — gets filled by hand later if a driver calls out
    }
    setFormula(ws, addr(18, r), `COUNTIF($C${r}:$P${r},"*")`)
  }

  const footerRow = headerRow + 1 + DATA_ROWS
  setCell(ws, addr(2, footerRow), dayName)
  for (let s = 0; s < SLOT_COUNT_BACK; s++) {
    setCell(ws, addr(3 + s, footerRow), SLOT_LABELS[s])
  }
  setCell(ws, addr(17, footerRow), 'Sick?')

  const totalsRow = footerRow + 1
  const dataStart = headerRow + 1
  const dataEnd = headerRow + DATA_ROWS
  for (let s = 0; s < SLOT_COUNT_BACK; s++) {
    const col = colLetter(3 + s)
    setFormula(ws, addr(3 + s, totalsRow), `COUNTIF(${col}${dataStart}:${col}${dataEnd},"*")`)
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
  // Build per-day blocks. The first sheet is ordered starting from the schedule's first day
  // (matches the reference: workbook tab named after the first day-of-week).
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

  const weekStart = parseISO(schedule.startDate)
  const wb = XLSX.utils.book_new()

  // ── Main human-readable sheet (named after starting day) ────────────────
  const mainWs: XLSX.WorkSheet = {}
  blocks.forEach((b, i) => writeMainBlock(mainWs, i, b, weekStart))
  const maxRowMain = FIRST_HEADER_ROW + (blocks.length - 1) * BLOCK_ROWS + DATA_ROWS + 2
  ensureRef(mainWs, maxRowMain, 18)
  mainWs['!cols'] = [
    { wch: 5 },   // A
    { wch: 18 },  // B
    ...Array(SLOT_COUNT_MAIN).fill({ wch: 11 }),  // C..Q
    { wch: 10 }, // R
  ]
  const mainSheetName = DAY_NAMES[blocks[0]?.dayOfWeek ?? 0]
  XLSX.utils.book_append_sheet(wb, mainWs, mainSheetName)

  // ── BackOffice File sheet (integration target) ──────────────────────────
  const backWs: XLSX.WorkSheet = {}
  blocks.forEach((b, i) => writeBackOfficeBlock(backWs, i, b, weekStart))
  const maxRowBack = FIRST_HEADER_ROW + (blocks.length - 1) * BLOCK_ROWS + DATA_ROWS + 2
  ensureRef(backWs, maxRowBack, 18)
  backWs['!cols'] = [
    { wch: 5 },   // A
    { wch: 18 },  // B
    ...Array(SLOT_COUNT_BACK).fill({ wch: 11 }),  // C..P
    { wch: 8 },   // Q (Sick?)
    { wch: 10 },  // R
  ]
  XLSX.utils.book_append_sheet(wb, backWs, 'BackOffice File')

  return wb
}
