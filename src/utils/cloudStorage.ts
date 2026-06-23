/**
 * Cloud storage for the team's "current" saved schedule.
 *
 * Backed by a single GitHub Gist with one file per team
 * (`dispatchers.json`, `drivers.json`), each containing a serialized
 * SnapshotEnvelope.
 *
 * Env vars (set in Vercel + .env.local):
 *   VITE_GIST_ID     — the gist's id (the hash in its URL)
 *   VITE_GIST_TOKEN  — a fine-grained PAT with "Gists - Read and write"
 *
 * Both end up in the bundle, so anyone who loads the app can read or
 * overwrite the saved schedule. This is UX-level convenience, not real
 * access control. Keep the PAT scoped to *just* gist read/write to
 * limit blast radius if the bundle ever leaks publicly; revoke and
 * rotate the token if that happens. For real auth: move data behind
 * an authenticated API.
 *
 * If either env var is missing, every call here resolves to a "disabled"
 * result so the app keeps working as a local-only tool.
 */

import {
  type SnapshotEnvelope,
  SCHEMA_VERSION,
  type SnapshotData,
  type TeamKind,
} from './snapshot'

const GIST_ID    = (import.meta.env.VITE_GIST_ID    as string | undefined)?.trim()
const GIST_TOKEN = (import.meta.env.VITE_GIST_TOKEN as string | undefined)?.trim()

export const cloudEnabled = !!(GIST_ID && GIST_TOKEN)

const API = 'https://api.github.com/gists'

const teamFilename = (team: TeamKind) => `${team}.json`

interface GistFile {
  filename: string
  content?: string
  truncated?: boolean
  /** Raw URL for fetching content when files are >1 MB and `truncated`. */
  raw_url?: string
}
interface GistResponse {
  id: string
  files: Record<string, GistFile>
  updated_at: string
}

async function gistGet(): Promise<GistResponse> {
  const r = await fetch(`${API}/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept:        'application/vnd.github+json',
    },
    // Bypass aggressive browser HTTP cache so a Save → reload round-trip
    // returns the just-written content.
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(`Gist GET failed (${r.status}): ${await r.text()}`)
  return r.json()
}

async function gistPatch(files: Record<string, { content: string }>): Promise<GistResponse> {
  const r = await fetch(`${API}/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization:   `Bearer ${GIST_TOKEN}`,
      Accept:          'application/vnd.github+json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ files }),
  })
  if (!r.ok) throw new Error(`Gist PATCH failed (${r.status}): ${await r.text()}`)
  return r.json()
}

/** Read the saved envelope for a team, or null if no save exists yet. */
export async function fetchSavedSnapshot(team: TeamKind): Promise<SnapshotEnvelope | null> {
  if (!cloudEnabled) return null
  const gist  = await gistGet()
  const file  = gist.files[teamFilename(team)]
  if (!file) return null
  let content = file.content
  // If GitHub truncated the inline content (>1 MB), fall back to the
  // raw URL. The dispatcher snapshot easily exceeds this once you have
  // multiple weeks + per-day per-slot bitmaps, so we always handle it.
  if ((!content || file.truncated) && file.raw_url) {
    const r = await fetch(file.raw_url, { cache: 'no-store' })
    if (!r.ok) throw new Error(`Gist raw fetch failed (${r.status})`)
    content = await r.text()
  }
  if (!content) return null
  try {
    return JSON.parse(content) as SnapshotEnvelope
  } catch (e) {
    throw new Error(`Gist file for ${team} is not valid JSON: ${e instanceof Error ? e.message : e}`)
  }
}

/** Metadata for the saved schedule — fast pill render. */
export interface SavedScheduleMeta {
  team: TeamKind
  startDate: string
  endDate: string
  updatedAt: string  // ISO timestamp (from envelope.exportedAt)
}

export async function fetchSavedMetadata(team: TeamKind): Promise<SavedScheduleMeta | null> {
  const env = await fetchSavedSnapshot(team)
  if (!env) return null
  return {
    team,
    startDate: env.data.startDate,
    endDate:   env.data.endDate,
    updatedAt: env.exportedAt,
  }
}

/** Overwrite the team's saved schedule. Last-write-wins. */
export async function saveSnapshot(
  team: TeamKind,
  snapshotData: SnapshotData,
): Promise<SavedScheduleMeta> {
  if (!cloudEnabled) throw new Error('Cloud storage is disabled — set VITE_GIST_ID and VITE_GIST_TOKEN.')
  const envelope: SnapshotEnvelope = {
    version:    SCHEMA_VERSION,
    team,
    exportedAt: new Date().toISOString(),
    data:       snapshotData,
  }
  await gistPatch({
    [teamFilename(team)]: { content: JSON.stringify(envelope, null, 2) },
  })
  return {
    team,
    startDate: snapshotData.startDate,
    endDate:   snapshotData.endDate,
    updatedAt: envelope.exportedAt,
  }
}
