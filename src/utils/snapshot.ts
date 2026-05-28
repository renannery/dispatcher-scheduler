/**
 * Versioned JSON snapshot of an entire team's schedule state.
 * Bump SCHEMA_VERSION when the shape changes in a non-additive way.
 */

import type { Dispatcher, DispatcherTimeOff, GeneratedSchedule } from '@/types/schedule'
import type { Driver, DriverTimeOff, GeneratedDriverSchedule } from '@/drivers/types'

import type { AbsenceReason } from './absence'

export const SCHEMA_VERSION = 1 as const

export type TeamKind = 'drivers' | 'dispatchers'

export interface DriverSnapshotData {
  drivers: Driver[]
  startDate: string
  endDate: string
  fullTimeCap: number
  partTimeCap: number
  /** Per-slot coverage multiplier (1.0 = reference). Optional for back-compat. */
  coverageScale?: number
  /** Per day-of-week override of the 15-slot required-coverage array. */
  coverageOverrides?: Record<number, number[]>
  timeOff: DriverTimeOff
  absenceReasons: Record<string, Record<string, AbsenceReason>>
  /** Persisted weekend-off rotation cursor. Optional for backwards compat. */
  weekendRotationOffset?: number
  schedule: GeneratedDriverSchedule | null
}

export interface DispatcherSnapshotData {
  dispatchers: Dispatcher[]
  startDate: string
  endDate: string
  timeOff: DispatcherTimeOff
  absenceReasons: Record<string, Record<string, AbsenceReason>>
  weekendRotationOffset?: number
  schedule: GeneratedSchedule | null
}

export type SnapshotData = DriverSnapshotData | DispatcherSnapshotData

export interface SnapshotEnvelope<T extends SnapshotData = SnapshotData> {
  version: typeof SCHEMA_VERSION
  team: TeamKind
  exportedAt: string
  data: T
}

/** Build a download-friendly filename based on the snapshot's date range. */
export function snapshotFilename(team: TeamKind, startDate: string, endDate: string): string {
  return `${team}-schedule_${startDate}_to_${endDate}.json`
}

/** Trigger a browser file download of the given snapshot. */
export function downloadSnapshot(envelope: SnapshotEnvelope): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = snapshotFilename(envelope.team, envelope.data.startDate, envelope.data.endDate)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Parse + validate a JSON snapshot. Throws with a user-readable message on failure. */
export function parseSnapshot(text: string): SnapshotEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('File is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON root must be an object.')
  const env = parsed as Partial<SnapshotEnvelope>
  if (env.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot version ${env.version ?? '?'} (expected ${SCHEMA_VERSION}).`)
  }
  if (env.team !== 'drivers' && env.team !== 'dispatchers') {
    throw new Error('Snapshot is missing a valid `team` field.')
  }
  if (!env.data || typeof env.data !== 'object') {
    throw new Error('Snapshot is missing `data`.')
  }
  return env as SnapshotEnvelope
}
