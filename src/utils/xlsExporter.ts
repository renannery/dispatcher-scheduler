import * as XLSX from 'xlsx'

import { DAY_TEMPLATES, SLOTS } from '@/data/coverageTemplate'
import type { GeneratedSchedule } from '@/types/schedule'

export function exportScheduleToXLS(schedule: GeneratedSchedule, filename?: string): void {
  const { dispatcherSchedules, dates, coverageActual } = schedule
  const wb = XLSX.utils.book_new()

  // One sheet per unique date (matches the reference Excel format: one block per day)
  for (const dateInfo of dates) {
    const { date, dayLabel, dayOfWeek } = dateInfo
    const template = DAY_TEMPLATES[dayOfWeek]
    const slotLabels = SLOTS.map((s) => s.label)
    const slotWeights = SLOTS.map((s) => s.hours)

    // Header rows to match the original Excel structure
    const header1 = ['Shift Schedule', ...slotLabels.map(() => ''), '']
    const header2 = ['For the Week:', ...slotLabels.map(() => ''), '']
    const weightRow = ['', ...slotWeights, '']
    const dayRow = [dayLabel, ...slotLabels, 'TOTAL']

    // Dispatcher rows
    const dispatcherRows = dispatcherSchedules.map((ds) => {
      const entry = ds.days.find((d) => d.date === date)
      const slotCells = entry
        ? entry.slots.map((on) => (on ? ds.dispatcher.name : ''))
        : slotLabels.map(() => '')
      const total = entry?.totalHours ?? 0
      return [ds.dispatcher.name, ...slotCells, total]
    })

    // Coverage counter row
    const actual = coverageActual[date] ?? SLOTS.map(() => 0)
    const required = template?.requiredCoverage ?? SLOTS.map(() => 0)
    const counterRow = [
      '',
      ...actual.map((a, _i) => {
        const r = required[_i]
        return r === 0 ? 0 : `${a}/${r}`
      }),
      actual.reduce((s, a, i) => s + a * SLOTS[i].hours, 0).toFixed(1),
    ]

    const sheetData = [header1, header2, weightRow, dayRow, ...dispatcherRows, counterRow]
    const ws = XLSX.utils.aoa_to_sheet(sheetData)

    ws['!cols'] = [{ wch: 18 }, ...SLOTS.map(() => ({ wch: 10 })), { wch: 8 }]

    const safeName = dayLabel.replace(/[^a-zA-Z0-9 ,]/g, '').slice(0, 31)
    XLSX.utils.book_append_sheet(wb, ws, safeName)
  }

  const name = filename ?? `schedule-${schedule.startDate}-to-${schedule.endDate}.xlsx`
  XLSX.writeFile(wb, name)
}
