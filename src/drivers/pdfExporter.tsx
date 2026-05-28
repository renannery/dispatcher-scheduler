import { Document, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer'
import { format, parseISO } from 'date-fns'

import { DRIVER_SLOTS } from './coverageTemplate'
import type { DriverSchedule, EmploymentType, GeneratedDriverSchedule } from './types'

// ─── Helpers ──────────────────────────────────────────────────────────────
// Slots are uniform 1h, 8 AM → 11 PM, so the clock is just an arithmetic
// progression. Kept as a precomputed array for symmetry with the dispatcher
// PDF (and to keep shift-string assembly identical).
const SLOT_CLOCK: number[] = (() => {
  const times: number[] = []
  let t = 8
  for (const slot of DRIVER_SLOTS) {
    times.push(t)
    t += slot.hours
  }
  times.push(t)
  return times
})()

function fmtTime(h: number): string {
  const wh = Math.floor(h)
  const mins = Math.round((h - wh) * 60)
  const pm = wh >= 12
  const h12 = wh === 0 ? 12 : wh > 12 ? wh - 12 : wh
  const suffix = pm ? 'PM' : 'AM'
  return mins === 0 ? `${h12}${suffix}` : `${h12}:${String(mins).padStart(2, '0')}${suffix}`
}

function shiftStr(slots: boolean[]): string {
  const ranges: string[] = []
  let start = -1
  for (let i = 0; i <= slots.length; i++) {
    const on = i < slots.length && slots[i]
    if (on && start < 0) start = i
    else if (!on && start >= 0) {
      ranges.push(`${fmtTime(SLOT_CLOCK[start])}–${fmtTime(SLOT_CLOCK[i])}`)
      start = -1
    }
  }
  return ranges.join(' · ')
}

function initials(name: string): string {
  return name.split(' ').map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase()
}

function typeColors(t: EmploymentType): { bg: string; bdr: string; fg: string } {
  if (t === 'part') return { bg: '#d1fae5', bdr: '#6ee7b7', fg: '#059669' }
  return { bg: '#dbeafe', bdr: '#93c5fd', fg: '#1d4ed8' }
}

function typeShort(t: EmploymentType): string {
  return t === 'full' ? 'FT' : 'PT'
}

function weekColors(hours: number, cap: number): { bg: string; bdr: string; fg: string } {
  if (hours > cap) return { bg: '#fee2e2', bdr: '#fca5a5', fg: '#dc2626' }
  if (hours >= cap * 0.9) return { bg: '#d1fae5', bdr: '#6ee7b7', fg: '#059669' }
  return { bg: '#fef3c7', bdr: '#fde68a', fg: '#d97706' }
}

async function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Shared style tokens ──────────────────────────────────────────────────
const T = {
  white:    '#ffffff',
  brand700: '#1d4ed8',  // blue header bg
  brand200: '#bfdbfe',  // muted text on dark bg
  brand100: '#dbeafe',
  slate50:  '#f8fafc',
  slate100: '#f1f5f9',
  slate200: '#e2e8f0',
  slate400: '#94a3b8',
  slate500: '#64748b',
  slate700: '#334155',
  slate800: '#1e293b',
}

// ─── ALL DRIVERS PDF (admin = with hours, team = without) ─────────────────
const SA = StyleSheet.create({
  page:      { backgroundColor: T.slate50 },

  hdr:       { backgroundColor: T.brand700, paddingHorizontal: 26, paddingTop: 18, paddingBottom: 18 },
  hdrTitle:  { color: T.white, fontSize: 18, fontFamily: 'Helvetica-Bold' },
  hdrPeriod: { color: T.brand200, fontSize: 9, marginTop: 3 },
  hdrMeta:   { color: T.brand200, fontSize: 8, marginTop: 2 },
  hdrStats:  { flexDirection: 'row', gap: 18, marginTop: 10 },
  statBlk:   { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  statN:     { color: T.white, fontSize: 14, fontFamily: 'Helvetica-Bold' },
  statL:     { color: T.brand200, fontSize: 8 },

  body:      { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 30 },
  wCard:     { backgroundColor: T.white, borderRadius: 6, borderWidth: 1, borderColor: T.slate200, marginBottom: 10 },
  wHead:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: T.slate100, paddingHorizontal: 12, paddingVertical: 9,
                borderBottomWidth: 1, borderBottomColor: T.slate200 },
  wLbl:      { fontSize: 10, fontFamily: 'Helvetica-Bold', color: T.slate800 },
  wBadges:   { flexDirection: 'row', flexWrap: 'wrap', gap: 4, maxWidth: '70%', justifyContent: 'flex-end' },
  badge:     { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 9, borderWidth: 1 },
  badgeTxt:  { fontSize: 7, fontFamily: 'Helvetica-Bold' },

  dayGroup:  { borderBottomWidth: 1, borderBottomColor: T.slate200 },
  dayLblRow: { backgroundColor: T.slate50, paddingHorizontal: 12, paddingVertical: 5,
                borderBottomWidth: 1, borderBottomColor: T.slate100 },
  dayLblTxt: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: T.slate500 },

  dRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
                paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.slate50 },
  dDot:      { width: 7, height: 7, borderRadius: 3.5, marginRight: 5 },
  dName:     { width: 80, fontSize: 8, fontFamily: 'Helvetica-Bold', color: T.slate700 },
  dLvl:      { fontSize: 6.5, paddingHorizontal: 3, paddingVertical: 1, borderRadius: 3,
                borderWidth: 1, fontFamily: 'Helvetica-Bold', marginRight: 6 },
  barWrap:   { flex: 1, marginHorizontal: 7 },
  bar:       { flexDirection: 'row', height: 11 },
  cell:      { flex: 1, height: 11 },
  shiftTxt:  { fontSize: 6.5, color: T.slate400, marginTop: 2 },
  dRight:    { width: 44, alignItems: 'flex-end' },
  dHours:    { fontSize: 8, fontFamily: 'Helvetica-Bold' },
  dOff:      { fontSize: 8, color: T.slate400 },

  foot:      { position: 'absolute', bottom: 10, left: 20, right: 20,
                flexDirection: 'row', justifyContent: 'space-between' },
  footTxt:   { fontSize: 7, color: T.slate400 },
})

interface AllDriversDocProps {
  schedule: GeneratedDriverSchedule
  /** admin = show hours; team = hide them */
  showHours: boolean
}

function AllDriversDoc({ schedule, showHours }: AllDriversDocProps) {
  const period = `${format(parseISO(schedule.startDate), 'MMM d, yyyy')} – ${format(
    parseISO(schedule.endDate), 'MMM d, yyyy',
  )}`
  const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]
  const n = DRIVER_SLOTS.length
  const ftCount = schedule.driverSchedules.filter((ds) => ds.driver.employmentType === 'full').length
  const ptCount = schedule.driverSchedules.length - ftCount

  // Per-week, list only drivers who actually worked that week to keep the
  // badge strip readable for big rosters.
  const workedThisWeek = (ds: DriverSchedule, wl: string) => (ds.weeklyHours[wl] ?? 0) > 0

  return (
    <Document>
      <Page size="A4" style={SA.page} orientation="landscape">
        <View style={SA.hdr}>
          <View>
            <Text style={SA.hdrTitle}>Driver Schedule</Text>
            <Text style={SA.hdrPeriod}>{period}</Text>
            <Text style={SA.hdrMeta}>
              Mon–Fri 9 AM–11 PM · Sat–Sun 8 AM–11 PM · work week Thu→Wed · max 9h/day
            </Text>
          </View>
          <View style={SA.hdrStats}>
            <View style={SA.statBlk}>
              <Text style={SA.statN}>{schedule.driverSchedules.length}</Text>
              <Text style={SA.statL}>drivers</Text>
            </View>
            <View style={SA.statBlk}>
              <Text style={SA.statN}>{ftCount}</Text>
              <Text style={SA.statL}>full-time</Text>
            </View>
            <View style={SA.statBlk}>
              <Text style={SA.statN}>{ptCount}</Text>
              <Text style={SA.statL}>part-time</Text>
            </View>
            {showHours && (
              <>
                <View style={SA.statBlk}>
                  <Text style={SA.statN}>{schedule.fullTimeCap}h</Text>
                  <Text style={SA.statL}>FT cap</Text>
                </View>
                <View style={SA.statBlk}>
                  <Text style={SA.statN}>{schedule.partTimeCap}h</Text>
                  <Text style={SA.statL}>PT cap</Text>
                </View>
              </>
            )}
          </View>
        </View>

        <View style={SA.body}>
          {weekLabels.map((wl) => {
            const days = schedule.dates.filter((d) => d.weekLabel === wl)
            return (
              <View key={wl} style={SA.wCard}>
                <View style={SA.wHead}>
                  <Text style={SA.wLbl}>{wl}</Text>
                  {showHours && (
                    <View style={SA.wBadges}>
                      {schedule.driverSchedules
                        .filter((ds) => workedThisWeek(ds, wl))
                        .map((ds) => {
                          const wh = ds.weeklyHours[wl] ?? 0
                          const cap = ds.driver.employmentType === 'full' ? schedule.fullTimeCap : schedule.partTimeCap
                          const wc = weekColors(wh, cap)
                          return (
                            <View key={ds.driver.id}
                              style={[SA.badge, { backgroundColor: wc.bg, borderColor: wc.bdr }]}>
                              <Text style={[SA.badgeTxt, { color: wc.fg }]}>
                                {ds.driver.name.split(' ')[0]} {wh}h
                              </Text>
                            </View>
                          )
                        })}
                    </View>
                  )}
                </View>

                {days.map((di) => (
                  <View key={di.date} style={SA.dayGroup} wrap={false}>
                    <View style={SA.dayLblRow}>
                      <Text style={SA.dayLblTxt}>{di.dayLabel}</Text>
                    </View>
                    {schedule.driverSchedules.map((ds) => {
                      const entry = ds.days.find((d) => d.date === di.date)
                      if (!entry || entry.isOff) return null
                      const tc = typeColors(ds.driver.employmentType)
                      return (
                        <View key={ds.driver.id} style={SA.dRow}>
                          <View style={[SA.dDot, { backgroundColor: ds.driver.color }]} />
                          <Text style={SA.dName}>{ds.driver.name}</Text>
                          <View style={[SA.dLvl, { backgroundColor: tc.bg, borderColor: tc.bdr }]}>
                            <Text style={{ color: tc.fg }}>{typeShort(ds.driver.employmentType)}</Text>
                          </View>
                          <View style={SA.barWrap}>
                            <View style={SA.bar}>
                              {entry.slots.map((on, i) => (
                                <View key={i} style={[SA.cell, {
                                  backgroundColor: on ? ds.driver.color : T.slate100,
                                  borderTopLeftRadius:     i === 0     ? 2 : 0,
                                  borderBottomLeftRadius:  i === 0     ? 2 : 0,
                                  borderTopRightRadius:    i === n - 1 ? 2 : 0,
                                  borderBottomRightRadius: i === n - 1 ? 2 : 0,
                                }]} />
                              ))}
                            </View>
                            <Text style={SA.shiftTxt}>{shiftStr(entry.slots)}</Text>
                          </View>
                          <View style={SA.dRight}>
                            {showHours && (
                              <Text style={[SA.dHours, { color: ds.driver.color }]}>
                                {entry.totalHours}h
                              </Text>
                            )}
                          </View>
                        </View>
                      )
                    })}
                  </View>
                ))}
              </View>
            )
          })}
        </View>

        <View style={SA.foot} fixed>
          <Text style={SA.footTxt}>Driver Scheduler · {period}</Text>
          <Text style={SA.footTxt}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ─── INDIVIDUAL PDF ───────────────────────────────────────────────────────
const SI = StyleSheet.create({
  page:      { backgroundColor: T.slate50 },

  hdr:       { backgroundColor: T.brand700, paddingHorizontal: 28, paddingVertical: 22,
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hdrL:      { flexDirection: 'row', alignItems: 'center' },
  avatar:    { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  avTxt:     { color: T.white, fontSize: 16, fontFamily: 'Helvetica-Bold' },
  hdrName:   { color: T.white, fontSize: 20, fontFamily: 'Helvetica-Bold' },
  hdrSub:    { color: T.brand200, fontSize: 9, marginTop: 3 },
  hdrLvl:    { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1,
                marginTop: 5, alignSelf: 'flex-start' },
  hdrLvlTxt: { fontSize: 8, fontFamily: 'Helvetica-Bold' },
  hdrR:      { alignItems: 'flex-end' },
  peakLbl:   { color: T.brand200, fontSize: 8 },
  peakH:     { color: T.white, fontSize: 22, fontFamily: 'Helvetica-Bold' },
  peakCap:   { color: T.brand200, fontSize: 7, marginTop: 1 },

  body:      { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 30 },
  wCard:     { backgroundColor: T.white, borderRadius: 6, borderWidth: 1, borderColor: T.slate200, marginBottom: 10 },
  wHead:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                backgroundColor: T.slate100, paddingHorizontal: 14, paddingVertical: 9,
                borderBottomWidth: 1, borderBottomColor: T.slate200 },
  wLbl:      { fontSize: 10, fontFamily: 'Helvetica-Bold', color: T.slate800 },
  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  badgeTxt:  { fontSize: 9, fontFamily: 'Helvetica-Bold' },

  dRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
                paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.slate100 },
  dLbl:      { width: 90, fontSize: 9, fontFamily: 'Helvetica-Bold', color: T.slate700 },
  barWrap:   { flex: 1, marginHorizontal: 8 },
  bar:       { flexDirection: 'row', height: 14 },
  cell:      { flex: 1, height: 14 },
  shiftTxt:  { fontSize: 7, color: T.slate400, marginTop: 2.5 },
  dRight:    { width: 48, alignItems: 'flex-end' },
  dHours:    { fontSize: 9, fontFamily: 'Helvetica-Bold' },
  dOff:      { fontSize: 9, color: T.slate400 },

  foot:      { position: 'absolute', bottom: 10, left: 28, right: 28,
                flexDirection: 'row', justifyContent: 'space-between' },
  footTxt:   { fontSize: 7, color: T.slate400 },
})

interface IndividualDocProps {
  ds: DriverSchedule
  schedule: GeneratedDriverSchedule
}

function IndividualDoc({ ds, schedule }: IndividualDocProps) {
  const { driver } = ds
  const cap = driver.employmentType === 'full' ? schedule.fullTimeCap : schedule.partTimeCap
  const peakH = Math.max(0, ...Object.values(ds.weeklyHours))
  const period = `${format(parseISO(schedule.startDate), 'MMM d, yyyy')} – ${format(
    parseISO(schedule.endDate), 'MMM d, yyyy',
  )}`
  const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]
  const n = DRIVER_SLOTS.length
  const tc = typeColors(driver.employmentType)

  return (
    <Document>
      <Page size="A4" style={SI.page}>
        <View style={SI.hdr}>
          <View style={SI.hdrL}>
            <View style={[SI.avatar, { backgroundColor: driver.color }]}>
              <Text style={SI.avTxt}>{initials(driver.name)}</Text>
            </View>
            <View>
              <Text style={SI.hdrName}>{driver.name}</Text>
              <Text style={SI.hdrSub}>{period}</Text>
              <View style={[SI.hdrLvl, { backgroundColor: tc.bg, borderColor: tc.bdr }]}>
                <Text style={[SI.hdrLvlTxt, { color: tc.fg }]}>
                  {driver.employmentType === 'full' ? 'Full-time' : 'Part-time'}
                </Text>
              </View>
            </View>
          </View>
          <View style={SI.hdrR}>
            <Text style={SI.peakLbl}>PEAK WEEK</Text>
            <Text style={SI.peakH}>{peakH}h</Text>
            <Text style={SI.peakCap}>cap {cap}h</Text>
          </View>
        </View>

        <View style={SI.body}>
          {weekLabels.map((wl) => {
            const days = schedule.dates.filter((d) => d.weekLabel === wl)
            const wh = ds.weeklyHours[wl] ?? 0
            const wc = weekColors(wh, cap)
            return (
              <View key={wl} style={SI.wCard}>
                <View style={SI.wHead}>
                  <Text style={SI.wLbl}>{wl}</Text>
                  <View style={[SI.badge, { backgroundColor: wc.bg, borderColor: wc.bdr }]}>
                    <Text style={[SI.badgeTxt, { color: wc.fg }]}>{wh}h this week</Text>
                  </View>
                </View>

                {days.map((di) => {
                  const entry = ds.days.find((d) => d.date === di.date)
                  if (!entry) return null
                  return (
                    <View key={di.date} style={SI.dRow}>
                      <Text style={SI.dLbl}>{di.dayLabel}</Text>
                      <View style={SI.barWrap}>
                        <View style={SI.bar}>
                          {entry.slots.map((on, i) => (
                            <View key={i} style={[SI.cell, {
                              backgroundColor: on ? driver.color : T.slate100,
                              borderTopLeftRadius:     i === 0     ? 3 : 0,
                              borderBottomLeftRadius:  i === 0     ? 3 : 0,
                              borderTopRightRadius:    i === n - 1 ? 3 : 0,
                              borderBottomRightRadius: i === n - 1 ? 3 : 0,
                            }]} />
                          ))}
                        </View>
                        {!entry.isOff && <Text style={SI.shiftTxt}>{shiftStr(entry.slots)}</Text>}
                      </View>
                      <View style={SI.dRight}>
                        {entry.isOff
                          ? <Text style={SI.dOff}>OFF</Text>
                          : <Text style={[SI.dHours, { color: driver.color }]}>{entry.totalHours}h</Text>
                        }
                      </View>
                    </View>
                  )
                })}
              </View>
            )
          })}
        </View>

        <View style={SI.foot} fixed>
          <Text style={SI.footTxt}>Driver Scheduler · {driver.name}</Text>
          <Text style={SI.footTxt}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ─── Public exports ───────────────────────────────────────────────────────
function periodFilename(schedule: GeneratedDriverSchedule): string {
  return `${format(parseISO(schedule.startDate), 'yyyy-MM-dd')}_${format(parseISO(schedule.endDate), 'yyyy-MM-dd')}`
}

export async function exportDriverAdminPDF(schedule: GeneratedDriverSchedule): Promise<void> {
  const blob = await pdf(<AllDriversDoc schedule={schedule} showHours={true} />).toBlob()
  await triggerDownload(blob, `drivers_admin_${periodFilename(schedule)}.pdf`)
}

export async function exportDriverTeamPDF(schedule: GeneratedDriverSchedule): Promise<void> {
  const blob = await pdf(<AllDriversDoc schedule={schedule} showHours={false} />).toBlob()
  await triggerDownload(blob, `drivers_team_${periodFilename(schedule)}.pdf`)
}

export async function exportDriverIndividualPDF(
  schedule: GeneratedDriverSchedule,
  driverId: string,
): Promise<void> {
  const ds = schedule.driverSchedules.find((d) => d.driver.id === driverId)
  if (!ds) return
  const blob = await pdf(<IndividualDoc ds={ds} schedule={schedule} />).toBlob()
  const safe = ds.driver.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  await triggerDownload(blob, `driver_${safe}_${periodFilename(schedule)}.pdf`)
}
