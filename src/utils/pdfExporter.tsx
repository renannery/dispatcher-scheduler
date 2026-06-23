import { Document, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer'
import { format, parseISO } from 'date-fns'

import { SLOTS } from '@/data/coverageTemplate'
import type { DispatcherLevel, DispatcherSchedule, GeneratedSchedule } from '@/types/schedule'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Precompute the real clock time (decimal hours from midnight) at the START
 * of every slot, plus one extra entry for the END of the last slot.
 *
 * SLOTS has a mix of 1 h and 0.5 h entries (break boundaries), so we cannot
 * use the naive "8 + slot_index" formula — that drifts by up to 2 hours by
 * the time we reach the evening slots.
 */
const SLOT_CLOCK: number[] = (() => {
  const times: number[] = []
  let t = 8  // 8 AM
  for (const slot of SLOTS) {
    times.push(t)
    t += slot.hours
  }
  times.push(t)  // end of last slot → 23.5 = 11:30 PM
  return times
})()

function fmtTime(h: number): string {
  const wh    = Math.floor(h)
  const mins  = Math.round((h - wh) * 60)
  const pm    = wh >= 12
  const h12   = wh === 0 ? 12 : wh > 12 ? wh - 12 : wh
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

function levelColors(lvl: DispatcherLevel): { bg: string; bdr: string; fg: string } {
  if (lvl === 'Senior')  return { bg: '#fef3c7', bdr: '#f59e0b', fg: '#b45309' }
  if (lvl === 'Regular') return { bg: '#ffe0e0', bdr: '#ff9090', fg: '#e03b3b' }
  return                        { bg: '#f8fafc', bdr: '#cbd5e1', fg: '#64748b' }
}

function levelShort(lvl: DispatcherLevel): string {
  return lvl === 'Senior' ? 'SR' : lvl === 'Regular' ? 'RG' : 'TR'
}

function weekColors(h: number): { bg: string; bdr: string; fg: string } {
  if (h > 45) return { bg: '#fee2e2', bdr: '#fca5a5', fg: '#dc2626' }
  if (h >= 36) return { bg: '#d1fae5', bdr: '#6ee7b7', fg: '#059669' }
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

// ---------------------------------------------------------------------------
// Shared style tokens
// ---------------------------------------------------------------------------

const T = {
  white:    '#ffffff',
  // Bento brand scale
  blue700:  '#e03b3b',  // dark header background
  blue200:  '#ffbdbd',  // muted text on dark bg
  blue100:  '#ffe0e0',  // very light tint
  slate50:  '#f8fafc',
  slate100: '#f1f5f9',
  slate200: '#e2e8f0',
  slate400: '#94a3b8',
  slate500: '#64748b',
  slate700: '#334155',
  slate800: '#1e293b',
}

// ---------------------------------------------------------------------------
// ── ADMIN / TEAM PDF (all dispatchers, same grid layout) ──────────────────
// ---------------------------------------------------------------------------

const SA = StyleSheet.create({
  page:      { backgroundColor: T.slate50 },

  // Header
  hdr:       { backgroundColor: T.blue700, paddingHorizontal: 26, paddingTop: 18, paddingBottom: 18 },
  hdrTop:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  hdrTitle:  { color: T.white, fontSize: 18, fontFamily: 'Helvetica-Bold' },
  hdrPeriod: { color: T.blue200, fontSize: 9, marginTop: 3 },
  hdrMeta:   { color: T.blue200, fontSize: 8, marginTop: 2 },
  hdrDisps:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  hdrDisp:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hdrDot:    { width: 9, height: 9, borderRadius: 4.5 },
  hdrName:   { color: T.blue100, fontSize: 8.5, fontFamily: 'Helvetica-Bold' },
  hdrLvl:    { fontSize: 6.5, paddingHorizontal: 3.5, paddingVertical: 1.5, borderRadius: 3,
                borderWidth: 1, fontFamily: 'Helvetica-Bold' },
  hdrPeak:   { color: T.blue200, fontSize: 7.5 },

  // Body
  body:      { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 30 },
  wCard:     { backgroundColor: T.white, borderRadius: 6, borderWidth: 1,
                borderColor: T.slate200, marginBottom: 10 },
  wHead:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: T.slate100, paddingHorizontal: 12, paddingVertical: 9,
                borderBottomWidth: 1, borderBottomColor: T.slate200 },
  wLbl:      { fontSize: 10, fontFamily: 'Helvetica-Bold', color: T.slate800 },
  wBadges:   { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  badge:     { paddingHorizontal: 7, paddingVertical: 2.5, borderRadius: 9, borderWidth: 1 },
  badgeTxt:  { fontSize: 7.5, fontFamily: 'Helvetica-Bold' },

  // Day group
  dayGroup:  { borderBottomWidth: 1, borderBottomColor: T.slate200 },
  dayLblRow: { backgroundColor: T.slate50, paddingHorizontal: 12, paddingVertical: 5,
                borderBottomWidth: 1, borderBottomColor: T.slate100 },
  dayLblTxt: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: T.slate500 },

  // Dispatcher row
  dRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
                paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: T.slate50 },
  dDot:      { width: 7, height: 7, borderRadius: 3.5, marginRight: 5 },
  dName:     { width: 44, fontSize: 8, fontFamily: 'Helvetica-Bold', color: T.slate700 },
  dLvl:      { fontSize: 6.5, paddingHorizontal: 3, paddingVertical: 1, borderRadius: 3,
                borderWidth: 1, fontFamily: 'Helvetica-Bold', marginRight: 6 },
  barWrap:   { flex: 1, marginHorizontal: 7 },
  bar:       { flexDirection: 'row', height: 12 },
  cell:      { flex: 1, height: 12 },
  shiftTxt:  { fontSize: 6.5, color: T.slate400, marginTop: 2 },
  dRight:    { width: 44, alignItems: 'flex-end' },
  dHours:    { fontSize: 8, fontFamily: 'Helvetica-Bold' },
  dOff:      { fontSize: 8, color: T.slate400 },

  // Footer
  foot:      { position: 'absolute', bottom: 10, left: 20, right: 20,
                flexDirection: 'row', justifyContent: 'space-between' },
  footTxt:   { fontSize: 7, color: T.slate400 },
})

interface AllDispatchersDocProps {
  schedule: GeneratedSchedule
  /** admin = show per-dispatcher weekly hours; team = hide them */
  showHours: boolean
}

function AllDispatchersDoc({ schedule, showHours }: AllDispatchersDocProps) {
  const period = `${format(parseISO(schedule.startDate), 'MMM d, yyyy')} – ${format(
    parseISO(schedule.endDate), 'MMM d, yyyy',
  )}`
  const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]
  const n = SLOTS.length

  return (
    <Document>
      <Page size="A4" style={SA.page}>
        {/* ── Header ── */}
        <View style={SA.hdr}>
          <View style={SA.hdrTop}>
            <View>
              <Text style={SA.hdrTitle}>Dispatcher Schedule</Text>
              <Text style={SA.hdrPeriod}>{period}</Text>
              <Text style={SA.hdrMeta}>
                Mon–Fri 9 AM–11:30 PM · Sat–Sun 8 AM–11:30 PM · work week Thu→Wed
              </Text>
            </View>
          </View>
          <View style={SA.hdrDisps}>
            {schedule.dispatcherSchedules.map((ds) => {
              const lc   = levelColors(ds.dispatcher.level)
              const peak = Math.max(0, ...Object.values(ds.weeklyHours))
              return (
                <View key={ds.dispatcher.id} style={SA.hdrDisp}>
                  <View style={[SA.hdrDot, { backgroundColor: ds.dispatcher.color }]} />
                  <Text style={SA.hdrName}>{ds.dispatcher.name}</Text>
                  <View style={[SA.hdrLvl, { backgroundColor: lc.bg, borderColor: lc.bdr }]}>
                    <Text style={{ color: lc.fg }}>{levelShort(ds.dispatcher.level)}</Text>
                  </View>
                  {showHours && (
                    <Text style={SA.hdrPeak}>peak {peak.toFixed(1)}h</Text>
                  )}
                </View>
              )
            })}
          </View>
        </View>

        {/* ── Body ── */}
        <View style={SA.body}>
          {weekLabels.map((wl) => {
            const days = schedule.dates.filter((d) => d.weekLabel === wl)
            return (
              <View key={wl} style={SA.wCard}>
                {/* Week header */}
                <View style={SA.wHead}>
                  <Text style={SA.wLbl}>{wl}</Text>
                  {showHours && (
                    <View style={SA.wBadges}>
                      {schedule.dispatcherSchedules.map((ds) => {
                        const wh = ds.weeklyHours[wl] ?? 0
                        const wc = weekColors(wh)
                        return (
                          <View key={ds.dispatcher.id}
                            style={[SA.badge, { backgroundColor: wc.bg, borderColor: wc.bdr }]}>
                            <Text style={[SA.badgeTxt, { color: wc.fg }]}>
                              {ds.dispatcher.name.split(' ')[0]} {wh.toFixed(1)}h
                            </Text>
                          </View>
                        )
                      })}
                    </View>
                  )}
                </View>

                {/* Day groups */}
                {days.map((di) => (
                  <View key={di.date} style={SA.dayGroup} wrap={false}>
                    <View style={SA.dayLblRow}>
                      <Text style={SA.dayLblTxt}>{di.dayLabel}</Text>
                    </View>
                    {schedule.dispatcherSchedules.map((ds) => {
                      const entry = ds.days.find((d) => d.date === di.date)
                      if (!entry) return null
                      const lc = levelColors(ds.dispatcher.level)
                      return (
                        <View key={ds.dispatcher.id} style={SA.dRow}>
                          <View style={[SA.dDot, { backgroundColor: ds.dispatcher.color }]} />
                          <Text style={SA.dName}>{ds.dispatcher.name.split(' ')[0]}</Text>
                          <View style={[SA.dLvl, { backgroundColor: lc.bg, borderColor: lc.bdr }]}>
                            <Text style={{ color: lc.fg }}>{levelShort(ds.dispatcher.level)}</Text>
                          </View>
                          <View style={SA.barWrap}>
                            <View style={SA.bar}>
                              {entry.slots.map((on, i) => (
                                <View key={i} style={[SA.cell, {
                                  backgroundColor: on ? ds.dispatcher.color : T.slate100,
                                  borderTopLeftRadius:     i === 0     ? 2 : 0,
                                  borderBottomLeftRadius:  i === 0     ? 2 : 0,
                                  borderTopRightRadius:    i === n - 1 ? 2 : 0,
                                  borderBottomRightRadius: i === n - 1 ? 2 : 0,
                                }]} />
                              ))}
                            </View>
                            {!entry.isOff && (
                              <Text style={SA.shiftTxt}>{shiftStr(entry.slots)}</Text>
                            )}
                          </View>
                          <View style={SA.dRight}>
                            {entry.isOff
                              ? <Text style={SA.dOff}>OFF</Text>
                              : <Text style={[SA.dHours, { color: ds.dispatcher.color }]}>
                                  {entry.totalHours.toFixed(1)}h
                                </Text>
                            }
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

        {/* ── Footer ── */}
        <View style={SA.foot} fixed>
          <Text style={SA.footTxt}>Dispatcher Scheduler · {period}</Text>
          <Text style={SA.footTxt}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ---------------------------------------------------------------------------
// ── INDIVIDUAL PDF (one dispatcher, spacious single-person layout) ─────────
// ---------------------------------------------------------------------------

const SI = StyleSheet.create({
  page:      { backgroundColor: T.slate50 },

  // Header — uses dispatcher's own color as accent
  hdr:       { backgroundColor: T.blue700, paddingHorizontal: 28, paddingVertical: 22,
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hdrL:      { flexDirection: 'row', alignItems: 'center' },
  avatar:    { width: 48, height: 48, borderRadius: 24, alignItems: 'center',
                justifyContent: 'center', marginRight: 14 },
  avTxt:     { color: T.white, fontSize: 16, fontFamily: 'Helvetica-Bold' },
  hdrName:   { color: T.white, fontSize: 20, fontFamily: 'Helvetica-Bold' },
  hdrSub:    { color: T.blue200, fontSize: 9, marginTop: 3 },
  hdrLvl:    { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1,
                marginTop: 5, alignSelf: 'flex-start' },
  hdrLvlTxt: { fontSize: 8, fontFamily: 'Helvetica-Bold' },
  hdrR:      { alignItems: 'flex-end' },
  peakLbl:   { color: T.blue200, fontSize: 8 },
  peakH:     { color: T.white, fontSize: 22, fontFamily: 'Helvetica-Bold' },

  body:      { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 30 },
  wCard:     { backgroundColor: T.white, borderRadius: 6, borderWidth: 1,
                borderColor: T.slate200, marginBottom: 10 },
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
  ds: DispatcherSchedule
  schedule: GeneratedSchedule
}

function IndividualDoc({ ds, schedule }: IndividualDocProps) {
  const { dispatcher } = ds
  const peakH  = Math.max(0, ...Object.values(ds.weeklyHours))
  const period = `${format(parseISO(schedule.startDate), 'MMM d, yyyy')} – ${format(
    parseISO(schedule.endDate), 'MMM d, yyyy',
  )}`
  const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]
  const n  = SLOTS.length
  const lc = levelColors(dispatcher.level)

  return (
    <Document>
      <Page size="A4" style={SI.page}>
        {/* ── Header ── */}
        <View style={SI.hdr}>
          <View style={SI.hdrL}>
            <View style={[SI.avatar, { backgroundColor: dispatcher.color }]}>
              <Text style={SI.avTxt}>{initials(dispatcher.name)}</Text>
            </View>
            <View>
              <Text style={SI.hdrName}>{dispatcher.name}</Text>
              <Text style={SI.hdrSub}>{period}</Text>
              <View style={[SI.hdrLvl, { backgroundColor: lc.bg, borderColor: lc.bdr }]}>
                <Text style={[SI.hdrLvlTxt, { color: lc.fg }]}>{dispatcher.level}</Text>
              </View>
            </View>
          </View>
          <View style={SI.hdrR}>
            <Text style={SI.peakLbl}>PEAK WEEK</Text>
            <Text style={SI.peakH}>{peakH.toFixed(1)}h</Text>
          </View>
        </View>

        {/* ── Body ── */}
        <View style={SI.body}>
          {weekLabels.map((wl) => {
            const days = schedule.dates.filter((d) => d.weekLabel === wl)
            const wh   = ds.weeklyHours[wl] ?? 0
            const wc   = weekColors(wh)
            return (
              <View key={wl} style={SI.wCard}>
                {/* Week header */}
                <View style={SI.wHead}>
                  <Text style={SI.wLbl}>{wl}</Text>
                  <View style={[SI.badge, { backgroundColor: wc.bg, borderColor: wc.bdr }]}>
                    <Text style={[SI.badgeTxt, { color: wc.fg }]}>{wh.toFixed(1)}h this week</Text>
                  </View>
                </View>

                {/* Day rows */}
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
                              backgroundColor: on ? dispatcher.color : T.slate100,
                              borderTopLeftRadius:     i === 0     ? 3 : 0,
                              borderBottomLeftRadius:  i === 0     ? 3 : 0,
                              borderTopRightRadius:    i === n - 1 ? 3 : 0,
                              borderBottomRightRadius: i === n - 1 ? 3 : 0,
                            }]} />
                          ))}
                        </View>
                        {!entry.isOff && (
                          <Text style={SI.shiftTxt}>{shiftStr(entry.slots)}</Text>
                        )}
                      </View>
                      <View style={SI.dRight}>
                        {entry.isOff
                          ? <Text style={SI.dOff}>OFF</Text>
                          : <Text style={[SI.dHours, { color: dispatcher.color }]}>
                              {entry.totalHours.toFixed(1)}h
                            </Text>
                        }
                      </View>
                    </View>
                  )
                })}
              </View>
            )
          })}
        </View>

        {/* ── Footer ── */}
        <View style={SI.foot} fixed>
          <Text style={SI.footTxt}>Dispatcher Scheduler · {dispatcher.name}</Text>
          <Text style={SI.footTxt}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ---------------------------------------------------------------------------
// Public export functions (lazy-loadable — call via dynamic import)
// ---------------------------------------------------------------------------

function periodFilename(schedule: GeneratedSchedule): string {
  return `${format(parseISO(schedule.startDate), 'yyyy-MM-dd')}_${format(parseISO(schedule.endDate), 'yyyy-MM-dd')}`
}

export async function exportAdminPDF(schedule: GeneratedSchedule): Promise<void> {
  const blob = await pdf(<AllDispatchersDoc schedule={schedule} showHours={true} />).toBlob()
  await triggerDownload(blob, `schedule_admin_${periodFilename(schedule)}.pdf`)
}

export async function exportTeamPDF(schedule: GeneratedSchedule): Promise<void> {
  const blob = await pdf(<AllDispatchersDoc schedule={schedule} showHours={false} />).toBlob()
  await triggerDownload(blob, `schedule_team_${periodFilename(schedule)}.pdf`)
}

export async function exportIndividualPDF(
  schedule: GeneratedSchedule,
  dispatcherId: string,
): Promise<void> {
  const ds = schedule.dispatcherSchedules.find((d) => d.dispatcher.id === dispatcherId)
  if (!ds) return
  const blob = await pdf(<IndividualDoc ds={ds} schedule={schedule} />).toBlob()
  const safe = ds.dispatcher.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  await triggerDownload(blob, `schedule_${safe}_${periodFilename(schedule)}.pdf`)
}
