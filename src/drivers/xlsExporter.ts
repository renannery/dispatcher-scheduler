import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import * as XLSX from 'xlsx'
import { format, parseISO } from 'date-fns'

import { DRIVER_SLOTS } from './coverageTemplate'
import type { GeneratedDriverSchedule } from './types'
import { xlsxName } from './utils'

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

interface DayBlockDriver {
  name: string
  slots: boolean[]
  isShopper: boolean
  /** Backend-system driver ID (e.g. Firestore doc ID). Emitted in column S. */
  driverId?: string
}

// Column S (col index 19) holds the backend driverId so the importer can
// reconcile rows by stable ID instead of substring-matching the name.
const DRIVER_ID_COL = 19
const TOTAL_COLS = 19  // A..S

interface DayBlockData {
  date: string         // YYYY-MM-DD
  dayOfWeek: number
  drivers: DayBlockDriver[]
}

// Reference workbook places shopper-drivers at rows 64-67 (with header at row
// 5) — that's 4 empty gap rows (60-63), 4 shopper rows (64-67), and 1 trailing
// blank row (68) before the footer at row 69. The backend may key off these
// positions when reconciling roster membership.
const SHOPPER_ROW_COUNT = 4
const SHOPPER_GAP_ROWS = 4
const SHOPPER_TRAILING_BLANK_ROWS = 1

// ─── Cell helpers ──────────────────────────────────────────────────────────
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
function dateToExcelSerial(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH_MS) / 86400000)
}

function setCell(ws: XLSX.WorkSheet, addr: string, value: string | number | Date) {
  if (value instanceof Date) {
    // Match the reference's exact format code (uppercase `D/M/YYYY`).
    // Excel format codes are case-insensitive for date components, but the
    // backend parser may compare format strings literally, so case matters.
    ws[addr] = { t: 'n', v: dateToExcelSerial(value), z: 'D/M/YYYY' }
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

  // ── Header row: B=DAY, C..Q=slot labels, R='TOTAL', S='Driver ID' ────────
  setCell(ws, addr(2, headerRow), dayName)
  for (let s = 0; s < SLOT_COUNT; s++) {
    setCell(ws, addr(3 + s, headerRow), SLOT_LABELS[s])
  }
  setCell(ws, addr(18, headerRow), 'TOTAL')
  setCell(ws, addr(DRIVER_ID_COL, headerRow), 'Driver ID')

  // ── Driver row layout ───────────────────────────────────────────────────
  // Match the reference exactly: regular drivers fill from the top of the
  // data section; shopper-drivers always occupy the LAST 4 driver rows of
  // the block (rows 64-67 when headerRow=5), with a 4-row gap above them.
  const regulars = block.drivers.filter((d) => !d.isShopper)
  const shoppers = block.drivers.filter((d) => d.isShopper)

  const shopperStartIdx = DATA_ROWS - SHOPPER_ROW_COUNT - SHOPPER_TRAILING_BLANK_ROWS  // 58 → row 64
  const regularLimit = shopperStartIdx - SHOPPER_GAP_ROWS                              // 54 → row 59 last
  const limitedRegulars = regulars.slice(0, regularLimit)
  const limitedShoppers = shoppers.slice(0, SHOPPER_ROW_COUNT)

  const cellsForRow = (i: number): DayBlockDriver | null => {
    if (i < limitedRegulars.length) return limitedRegulars[i]
    if (i >= shopperStartIdx && i - shopperStartIdx < limitedShoppers.length) {
      return limitedShoppers[i - shopperStartIdx]
    }
    return null
  }

  for (let i = 0; i < DATA_ROWS; i++) {
    const r = headerRow + 1 + i
    // A: must be a plain numeric VALUE — the backend decoder routes rows by
    // `typeof sheet['A<row>'].v === 'number'`, so a formula like `=row(A1)`
    // without a cached value gets classified as 'unknown' and the entire shift
    // row is silently dropped on upload.
    setCell(ws, addr(1, r), i + 1)

    const drv = cellsForRow(i)
    if (drv) {
      setCell(ws, addr(2, r), drv.name)
      for (let s = 0; s < SLOT_COUNT; s++) {
        if (drv.slots[s]) setCell(ws, addr(3 + s, r), drv.name)
      }
      // S: backend driverId — only emit on rows with an actual driver
      if (drv.driverId) setCell(ws, addr(DRIVER_ID_COL, r), drv.driverId)
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
  const rawBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const fixedBuf = normalizeCustomNumFmtIds(new Uint8Array(rawBuf))
  // Trigger browser download
  const blob = new Blob([fixedBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * SheetJS emits custom numFmtIds starting at 60, but the OOXML spec reserves
 * 0-163 for built-ins and only allows custom IDs at 164+. Strict xlsx
 * parsers (e.g. the user's backend) reject the reserved-range IDs.
 *
 * We post-process the zip: any <numFmt> with id in [50, 163] gets renumbered
 * to a fresh ID at 164+, and every reference in styles.xml is updated to
 * match. Cell `s="..."` references don't change (they index cellXfs, not
 * numFmtId directly).
 */
export function normalizeCustomNumFmtIds(buf: Uint8Array): Uint8Array {
  const files = unzipSync(buf)
  const stylesPath = 'xl/styles.xml'
  if (!files[stylesPath]) return buf

  let xml = strFromU8(files[stylesPath])

  // Collect all custom numFmt entries — `<numFmt numFmtId="X" formatCode="..."/>`
  const numFmtRe = /<numFmt\s+numFmtId="(\d+)"\s+formatCode="[^"]*"\s*\/>/g
  const seenIds: number[] = []
  for (const m of xml.matchAll(numFmtRe)) {
    seenIds.push(Number(m[1]))
  }

  // Build a remap for any id in the reserved range
  const remap = new Map<number, number>()
  let nextId = 164
  for (const id of seenIds) {
    if (id < 164) {
      while (seenIds.includes(nextId) || [...remap.values()].includes(nextId)) nextId++
      remap.set(id, nextId)
      nextId++
    }
  }
  if (remap.size === 0) return buf

  // Rewrite every occurrence of `numFmtId="<oldId>"` in styles.xml.
  // (Both the <numFmt> defs themselves and the <xf> references.)
  for (const [oldId, newId] of remap) {
    const re = new RegExp(`numFmtId="${oldId}"`, 'g')
    xml = xml.replace(re, `numFmtId="${newId}"`)
  }

  files[stylesPath] = strToU8(xml)
  return zipSync(files)
}

function buildWb(schedule: GeneratedDriverSchedule): XLSX.WorkBook {
  // One block per day in schedule order. Every driver appears in every block
  // (in roster order); off drivers get a name with no slot cells filled.
  // Names use a short form that's guaranteed to be a substring of the DB
  // driver's full name (see xlsxName + the backend's `findDriver` matcher).
  const emptySlots = new Array(DRIVER_SLOTS.length).fill(false)
  const allFullNames = schedule.driverSchedules.map((ds) => ds.driver.name)
  const blocks: DayBlockData[] = schedule.dates.map((dateInfo) => ({
    date: dateInfo.date,
    dayOfWeek: dateInfo.dayOfWeek,
    drivers: schedule.driverSchedules.map((ds) => {
      const entry = ds.days.find((d) => d.date === dateInfo.date)
      return {
        name: xlsxName(ds.driver.name, allFullNames),
        slots: entry?.slots ?? emptySlots,
        isShopper: !!ds.driver.isShopper,
        driverId: ds.driver.driverId,
      }
    }),
  }))

  const wb = XLSX.utils.book_new()
  const sheetName = DAY_NAMES_TITLE[blocks[0]?.dayOfWeek ?? 4]  // default Thursday

  const ws: XLSX.WorkSheet = {}
  blocks.forEach((b, i) => writeBlock(ws, sheetName, i, b))
  const lastHeaderRow = blockHeaderRow(blocks.length - 1)
  const maxRow = lastHeaderRow + DATA_ROWS + 2  // header + data + footer + totals
  ensureRef(ws, maxRow, TOTAL_COLS)
  ws['!cols'] = [
    { wch: 5 },   // A
    { wch: 18 },  // B
    ...Array(SLOT_COUNT).fill({ wch: 11 }),  // C..Q
    { wch: 10 }, // R (TOTAL)
    { wch: 22 }, // S (Driver ID)
  ]
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  return wb
}
