/**
 * Cloud storage for the team's "current" saved schedule.
 *
 * Backed by a single Supabase Postgres table:
 *
 *   create table schedules (
 *     team text primary key,
 *     data jsonb not null,
 *     start_date date not null,
 *     end_date date not null,
 *     updated_at timestamptz not null default now()
 *   );
 *
 *   alter table schedules enable row level security;
 *   create policy "anon read"  on schedules for select to anon using (true);
 *   create policy "anon write" on schedules for insert to anon with check (true);
 *   create policy "anon update" on schedules for update to anon using (true);
 *
 * Env vars (set in Vercel + .env.local):
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 *
 * Both are public (the anon key is meant to be embedded in the client);
 * the protection is the table-level RLS policies above. If you later add
 * auth, tighten the policies and require a session.
 *
 * If either env var is missing, every call here resolves to a "disabled"
 * result so the app keeps working as a local-only tool.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  type SnapshotEnvelope,
  SCHEMA_VERSION,
  type SnapshotData,
  type TeamKind,
} from './snapshot'

const url  = import.meta.env.VITE_SUPABASE_URL  as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const cloudEnabled = !!(url && anon)

let client: SupabaseClient | null = null
function getClient(): SupabaseClient | null {
  if (!cloudEnabled) return null
  if (!client) client = createClient(url!, anon!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

/** Metadata for a saved schedule (no data blob) — fast pill render. */
export interface SavedScheduleMeta {
  team: TeamKind
  startDate: string
  endDate: string
  updatedAt: string  // ISO timestamp
}

interface SchedulesRow {
  team: TeamKind
  data: SnapshotEnvelope
  start_date: string
  end_date: string
  updated_at: string
}

/** Returns just the metadata (date range + updated_at) for the pill. */
export async function fetchSavedMetadata(team: TeamKind): Promise<SavedScheduleMeta | null> {
  const c = getClient()
  if (!c) return null
  const { data, error } = await c
    .from('schedules')
    .select('team, start_date, end_date, updated_at')
    .eq('team', team)
    .maybeSingle<Pick<SchedulesRow, 'team' | 'start_date' | 'end_date' | 'updated_at'>>()
  if (error) throw new Error(`Supabase fetchSavedMetadata: ${error.message}`)
  if (!data) return null
  return {
    team: data.team,
    startDate: data.start_date,
    endDate: data.end_date,
    updatedAt: data.updated_at,
  }
}

/** Returns the full saved snapshot envelope for hydration. */
export async function fetchSavedSnapshot(team: TeamKind): Promise<SnapshotEnvelope | null> {
  const c = getClient()
  if (!c) return null
  const { data, error } = await c
    .from('schedules')
    .select('data')
    .eq('team', team)
    .maybeSingle<{ data: SnapshotEnvelope }>()
  if (error) throw new Error(`Supabase fetchSavedSnapshot: ${error.message}`)
  return data?.data ?? null
}

/** Upsert the team's current snapshot. Last-write-wins. */
export async function saveSnapshot(
  team: TeamKind,
  snapshotData: SnapshotData,
): Promise<SavedScheduleMeta> {
  const c = getClient()
  if (!c) throw new Error('Cloud storage is disabled — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  const envelope: SnapshotEnvelope = {
    version: SCHEMA_VERSION,
    team,
    exportedAt: new Date().toISOString(),
    data: snapshotData,
  }
  const row = {
    team,
    data: envelope,
    start_date: snapshotData.startDate,
    end_date: snapshotData.endDate,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await c
    .from('schedules')
    .upsert(row, { onConflict: 'team' })
    .select('team, start_date, end_date, updated_at')
    .single<Pick<SchedulesRow, 'team' | 'start_date' | 'end_date' | 'updated_at'>>()
  if (error) throw new Error(`Supabase saveSnapshot: ${error.message}`)
  return {
    team: data.team,
    startDate: data.start_date,
    endDate: data.end_date,
    updatedAt: data.updated_at,
  }
}
