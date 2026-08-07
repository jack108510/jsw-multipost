-- ============================================================
-- Amplr API — Schema Migration
-- Run AFTER the base schema.sql in the Supabase SQL editor
-- Project: https://xacehhtgvubcqdoltazg.supabase.co
-- ============================================================

-- ── 1. API key store ─────────────────────────────────────────────
create table if not exists public.jsw_api_keys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null default 'Default',          -- human label
  key_hash       text not null unique,                      -- SHA-256 of the raw key
  key_preview    text not null,                             -- e.g. "amplr_Ab12...Xy89"
  scopes         text[] not null default array['jobs:write','jobs:read','groups:read'],
  rate_limit     integer not null default 30,               -- req/minute
  request_count  integer not null default 0,
  window_start   timestamptz,
  last_used_at   timestamptz,
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.jsw_api_keys enable row level security;

-- Users can only see/manage their own keys
create policy "api_keys_select_own" on public.jsw_api_keys
  for select using (auth.uid() = user_id);
create policy "api_keys_insert_own" on public.jsw_api_keys
  for insert with check (auth.uid() = user_id);
create policy "api_keys_update_own" on public.jsw_api_keys
  for update using (auth.uid() = user_id);
create policy "api_keys_delete_own" on public.jsw_api_keys
  for delete using (auth.uid() = user_id);

-- Service role needs to look up keys by hash (no user context during auth)
-- This is handled by the Edge Function using the service role key — no extra policy needed.

create index if not exists jsw_api_keys_user_idx on public.jsw_api_keys (user_id);
create index if not exists jsw_api_keys_hash_idx on public.jsw_api_keys (key_hash);

-- ── 2. Add webhook + API-source columns to jsw_post_jobs ─────────
alter table public.jsw_post_jobs
  add column if not exists webhook_url  text,
  add column if not exists source       text not null default 'extension',  -- 'api' | 'extension' | 'dashboard'
  add column if not exists api_key_id   uuid references public.jsw_api_keys(id) on delete set null;

-- ── 3. Add ext_heartbeat to jsw_settings (safe — may already exist) ──
alter table public.jsw_settings
  add column if not exists ext_heartbeat timestamptz;

-- ── 4. Grant Edge Function service role access to jsw_api_keys ───
-- (Supabase service role bypasses RLS — no extra grants needed for the edge fn)

-- ============================================================
-- HOW TO ISSUE YOUR FIRST API KEY
--
-- In the Amplr dashboard (or Supabase SQL editor), run:
--
--   select amplr_create_api_key(auth.uid(), 'My App', array['jobs:write','jobs:read','groups:read']);
--
-- Or use the dashboard UI (Settings → API Keys → Generate).
-- ============================================================

-- Helper function — creates a key, stores the hash, returns the raw key ONCE
create or replace function amplr_create_api_key(
  p_user_id uuid,
  p_name    text default 'Default',
  p_scopes  text[] default array['jobs:write','jobs:read','groups:read'],
  p_rate_limit integer default 30
)
returns table (api_key text, key_id uuid, preview text)
language plpgsql security definer
as $$
declare
  v_raw     text;
  v_bytes   bytea;
  v_hash    text;
  v_preview text;
  v_id      uuid;
begin
  -- Generate 32 random bytes → base64url
  v_bytes := gen_random_bytes(32);
  v_raw   := 'amplr_' || replace(replace(encode(v_bytes, 'base64'), '/', '_'), '+', '-');
  v_raw   := rtrim(v_raw, '=');

  -- SHA-256 hash
  v_hash  := encode(digest(v_raw, 'sha256'), 'hex');

  -- Preview: first 12 + last 4 chars
  v_preview := left(v_raw, 12) || '...' || right(v_raw, 4);

  insert into public.jsw_api_keys (user_id, name, key_hash, key_preview, scopes, rate_limit)
    values (p_user_id, p_name, v_hash, v_preview, p_scopes, p_rate_limit)
    returning id into v_id;

  return query select v_raw, v_id, v_preview;
end;
$$;
