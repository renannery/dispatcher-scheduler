# Supabase setup — saved-schedule sync

The Save/Load cloud feature requires a Supabase project. One-time setup:

## 1. Create the project

1. Go to https://supabase.com → new project (free tier is fine).
2. Wait ~1 min for it to provision.
3. Copy the **Project URL** and the **anon public** key from
   *Project Settings → API*.

## 2. Set env vars

Locally:

```bash
cp .env.example .env.local
# edit .env.local with the two values from step 1
```

In Vercel:

*Project → Settings → Environment Variables*, add:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

(Both can be marked as "exposed to browser" — they're meant to be public.)

Redeploy after adding them so the bundle picks them up.

## 3. Create the table + RLS policies

In Supabase SQL editor, paste and run:

```sql
create table schedules (
  team text primary key,
  data jsonb not null,
  start_date date not null,
  end_date date not null,
  updated_at timestamptz not null default now()
);

alter table schedules enable row level security;

create policy "anon read"   on schedules for select to anon using (true);
create policy "anon insert" on schedules for insert to anon with check (true);
create policy "anon update" on schedules for update to anon using (true);
```

That's it — the badge will appear in the schedule view next time the app
loads. If env vars are missing the cloud features stay hidden and the app
keeps working as a local-only tool.

## Security notes

- This setup lets **anyone with your project URL + anon key** read and
  overwrite the saved schedules. The protection is "URL + key are not
  publicly listed anywhere" — fine for a small internal team but NOT
  fine if you embed the app in a public marketing site.
- To tighten: enable Supabase Auth (magic-link or password), require a
  logged-in session, and replace `to anon` with `to authenticated` in the
  policies above.
- The saved schedule is a JSON blob keyed by team — last write wins,
  no history. For multi-editor safety add an `id` + `version` column and
  a `where version = $expected` clause on update.
