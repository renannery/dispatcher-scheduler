export type AbsenceReason = 'vacation' | 'loa' | 'appointment' | 'other'

export const ABSENCE_REASONS: { value: AbsenceReason; label: string; short: string }[] = [
  { value: 'vacation',    label: 'Vacation',    short: 'VAC' },
  { value: 'loa',         label: 'Leave of absence', short: 'LOA' },
  { value: 'appointment', label: 'Appointment', short: 'APT' },
  { value: 'other',       label: 'Other',       short: 'OFF' },
]

export function reasonColors(r: AbsenceReason): { bg: string; bdr: string; fg: string; tw: string } {
  switch (r) {
    case 'vacation':    return { bg: '#dbeafe', bdr: '#93c5fd', fg: '#1d4ed8', tw: 'bg-blue-100 text-blue-700 border-blue-300' }
    case 'loa':         return { bg: '#ede9fe', bdr: '#c4b5fd', fg: '#6d28d9', tw: 'bg-violet-100 text-violet-700 border-violet-300' }
    case 'appointment': return { bg: '#fef3c7', bdr: '#fde68a', fg: '#92400e', tw: 'bg-amber-100 text-amber-700 border-amber-300' }
    case 'other':       return { bg: '#f1f5f9', bdr: '#cbd5e1', fg: '#475569', tw: 'bg-slate-100 text-slate-700 border-slate-300' }
  }
}

export function reasonLabel(r: AbsenceReason): string {
  return ABSENCE_REASONS.find((x) => x.value === r)?.label ?? r
}

export function reasonShort(r: AbsenceReason): string {
  return ABSENCE_REASONS.find((x) => x.value === r)?.short ?? r.toUpperCase()
}

/** Inclusive range of YYYY-MM-DD dates. */
export function datesInRange(startDate: string, endDate: string): string[] {
  const out: string[] = []
  const s = new Date(startDate + 'T00:00:00')
  const e = new Date(endDate + 'T00:00:00')
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
