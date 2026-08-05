-- ============================================================
-- JSW Multi-Post — Database Schema
-- Run this in Supabase SQL Editor to create all tables.
-- All tables have Row Level Security (RLS) enabled so that each
-- user can only access their own rows (user_id = auth.uid()).
-- ============================================================

-- ============================================================
-- 1. jsw_groups
-- ============================================================
create table if not exists public.jsw_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  group_url   text not null,
  group_name  text not null,
  created_at  timestamptz not null default now()
);

alter table public.jsw_groups enable row level security;

drop policy if exists "groups_select_own"  on public.jsw_groups;
drop policy if exists "groups_insert_own"  on public.jsw_groups;
drop policy if exists "groups_update_own"  on public.jsw_groups;
drop policy if exists "groups_delete_own"  on public.jsw_groups;

create policy "groups_select_own" on public.jsw_groups
  for select using (auth.uid() = user_id);
create policy "groups_insert_own" on public.jsw_groups
  for insert with check (auth.uid() = user_id);
create policy "groups_update_own" on public.jsw_groups
  for update using (auth.uid() = user_id);
create policy "groups_delete_own" on public.jsw_groups
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 2. jsw_schedules
-- ============================================================
create table if not exists public.jsw_schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  message      text not null default '',
  groups       jsonb not null default '[]'::jsonb,
  frequency    text not null default 'once',
  post_time    text not null default '09:00',
  day_of_week  int  not null default 0,
  ai_enabled   boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.jsw_schedules enable row level security;

drop policy if exists "schedules_select_own" on public.jsw_schedules;
drop policy if exists "schedules_insert_own" on public.jsw_schedules;
drop policy if exists "schedules_update_own" on public.jsw_schedules;
drop policy if exists "schedules_delete_own" on public.jsw_schedules;

create policy "schedules_select_own" on public.jsw_schedules
  for select using (auth.uid() = user_id);
create policy "schedules_insert_own" on public.jsw_schedules
  for insert with check (auth.uid() = user_id);
create policy "schedules_update_own" on public.jsw_schedules
  for update using (auth.uid() = user_id);
create policy "schedules_delete_own" on public.jsw_schedules
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 3. jsw_drafts
-- ============================================================
create table if not exists public.jsw_drafts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  message     text not null default '',
  image_url   text not null default '',
  ai_prompt   text not null default '',
  created_at  timestamptz not null default now()
);

alter table public.jsw_drafts enable row level security;

drop policy if exists "drafts_select_own" on public.jsw_drafts;
drop policy if exists "drafts_insert_own" on public.jsw_drafts;
drop policy if exists "drafts_update_own" on public.jsw_drafts;
drop policy if exists "drafts_delete_own" on public.jsw_drafts;

create policy "drafts_select_own" on public.jsw_drafts
  for select using (auth.uid() = user_id);
create policy "drafts_insert_own" on public.jsw_drafts
  for insert with check (auth.uid() = user_id);
create policy "drafts_update_own" on public.jsw_drafts
  for update using (auth.uid() = user_id);
create policy "drafts_delete_own" on public.jsw_drafts
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 4. jsw_settings
-- One row per user (enforced by unique user_id).
-- ============================================================
create table if not exists public.jsw_settings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  ai_provider         text not null default 'openai',
  api_key_encrypted   text not null default '',
  ai_model            text not null default 'gpt-4o-mini',
  default_delay       int  not null default 30,
  ai_enabled          boolean not null default false,
  created_at          timestamptz not null default now()
);

create unique index if not exists jsw_settings_user_unique
  on public.jsw_settings (user_id);

alter table public.jsw_settings enable row level security;

drop policy if exists "settings_select_own" on public.jsw_settings;
drop policy if exists "settings_insert_own" on public.jsw_settings;
drop policy if exists "settings_update_own" on public.jsw_settings;
drop policy if exists "settings_delete_own" on public.jsw_settings;

create policy "settings_select_own" on public.jsw_settings
  for select using (auth.uid() = user_id);
create policy "settings_insert_own" on public.jsw_settings
  for insert with check (auth.uid() = user_id);
create policy "settings_update_own" on public.jsw_settings
  for update using (auth.uid() = user_id);
create policy "settings_delete_own" on public.jsw_settings
  for delete using (auth.uid() = user_id);

-- ============================================================
-- 5. jsw_posts
-- ============================================================
create table if not exists public.jsw_posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  message     text not null default '',
  groups      jsonb not null default '[]'::jsonb,
  status      text not null default 'posted',
  posted_at   timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.jsw_posts enable row level security;

drop policy if exists "posts_select_own" on public.jsw_posts;
drop policy if exists "posts_insert_own" on public.jsw_posts;
drop policy if exists "posts_update_own" on public.jsw_posts;
drop policy if exists "posts_delete_own" on public.jsw_posts;

create policy "posts_select_own" on public.jsw_posts
  for select using (auth.uid() = user_id);
create policy "posts_insert_own" on public.jsw_posts
  for insert with check (auth.uid() = user_id);
create policy "posts_update_own" on public.jsw_posts
  for update using (auth.uid() = user_id);
create policy "posts_delete_own" on public.jsw_posts
  for delete using (auth.uid() = user_id);
