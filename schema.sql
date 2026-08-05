-- ============================================================
-- Amplr Dashboard Schema
-- Run this in the Supabase SQL Editor for project:
-- https://xacehhtgvubcqdoltazg.supabase.co
-- ============================================================

-- Required extension for uuid generation
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLE: jsw_groups
-- ============================================================
create table if not exists public.jsw_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  group_url   text not null,
  group_name  text,
  created_at  timestamptz not null default now()
);
alter table public.jsw_groups enable row level security;
drop policy if exists "jsw_groups_select_own" on public.jsw_groups;
create policy "jsw_groups_select_own" on public.jsw_groups
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_groups_insert_own" on public.jsw_groups;
create policy "jsw_groups_insert_own" on public.jsw_groups
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_groups_update_own" on public.jsw_groups;
create policy "jsw_groups_update_own" on public.jsw_groups
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_groups_delete_own" on public.jsw_groups;
create policy "jsw_groups_delete_own" on public.jsw_groups
  for delete using (auth.uid() = user_id);

-- ============================================================
-- TABLE: jsw_post_jobs  (core pairing feature)
-- The extension reads jobs where status = 'pending' and
-- updates them through processing -> done / failed.
-- ============================================================
create table if not exists public.jsw_post_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  message      text not null,
  image_url    text,
  groups       jsonb not null default '[]'::jsonb,
  delay        integer not null default 30,
  ai_enabled   boolean not null default false,
  ai_prompt    text,
  status       text not null default 'pending',
  error        text,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.jsw_post_jobs enable row level security;
drop policy if exists "jsw_post_jobs_select_own" on public.jsw_post_jobs;
create policy "jsw_post_jobs_select_own" on public.jsw_post_jobs
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_post_jobs_insert_own" on public.jsw_post_jobs;
create policy "jsw_post_jobs_insert_own" on public.jsw_post_jobs
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_post_jobs_update_own" on public.jsw_post_jobs;
create policy "jsw_post_jobs_update_own" on public.jsw_post_jobs
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_post_jobs_delete_own" on public.jsw_post_jobs;
create policy "jsw_post_jobs_delete_own" on public.jsw_post_jobs
  for delete using (auth.uid() = user_id);

create index if not exists jsw_post_jobs_user_status_idx
  on public.jsw_post_jobs (user_id, status, created_at);

-- ============================================================
-- TABLE: jsw_schedules
-- ============================================================
create table if not exists public.jsw_schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  message      text not null,
  groups       jsonb not null default '[]'::jsonb,
  frequency    text not null default 'daily',
  post_time    text not null default '09:00',
  day_of_week  integer,
  ai_enabled   boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.jsw_schedules enable row level security;
drop policy if exists "jsw_schedules_select_own" on public.jsw_schedules;
create policy "jsw_schedules_select_own" on public.jsw_schedules
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_schedules_insert_own" on public.jsw_schedules;
create policy "jsw_schedules_insert_own" on public.jsw_schedules
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_schedules_update_own" on public.jsw_schedules;
create policy "jsw_schedules_update_own" on public.jsw_schedules
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_schedules_delete_own" on public.jsw_schedules;
create policy "jsw_schedules_delete_own" on public.jsw_schedules
  for delete using (auth.uid() = user_id);

-- ============================================================
-- TABLE: jsw_drafts
-- ============================================================
create table if not exists public.jsw_drafts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  message    text,
  image_url  text,
  ai_prompt  text,
  created_at timestamptz not null default now()
);
alter table public.jsw_drafts enable row level security;
drop policy if exists "jsw_drafts_select_own" on public.jsw_drafts;
create policy "jsw_drafts_select_own" on public.jsw_drafts
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_drafts_insert_own" on public.jsw_drafts;
create policy "jsw_drafts_insert_own" on public.jsw_drafts
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_drafts_update_own" on public.jsw_drafts;
create policy "jsw_drafts_update_own" on public.jsw_drafts
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_drafts_delete_own" on public.jsw_drafts;
create policy "jsw_drafts_delete_own" on public.jsw_drafts
  for delete using (auth.uid() = user_id);

-- ============================================================
-- TABLE: jsw_settings
-- ============================================================
create table if not exists public.jsw_settings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  ai_provider   text default 'openai',
  api_key       text,
  ai_model      text default 'gpt-4o-mini',
  default_delay integer default 30,
  ai_enabled    boolean default false,
  pairing_code  text,
  created_at    timestamptz not null default now()
);
alter table public.jsw_settings enable row level security;
drop policy if exists "jsw_settings_select_own" on public.jsw_settings;
create policy "jsw_settings_select_own" on public.jsw_settings
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_settings_insert_own" on public.jsw_settings;
create policy "jsw_settings_insert_own" on public.jsw_settings
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_settings_update_own" on public.jsw_settings;
create policy "jsw_settings_update_own" on public.jsw_settings
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_settings_delete_own" on public.jsw_settings;
create policy "jsw_settings_delete_own" on public.jsw_settings
  for delete using (auth.uid() = user_id);

-- ============================================================
-- TABLE: jsw_posts  (history of completed posts)
-- ============================================================
create table if not exists public.jsw_posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  message    text,
  groups     jsonb not null default '[]'::jsonb,
  status     text default 'success',
  posted_at  timestamptz,
  created_at timestamptz not null default now()
);
alter table public.jsw_posts enable row level security;
drop policy if exists "jsw_posts_select_own" on public.jsw_posts;
create policy "jsw_posts_select_own" on public.jsw_posts
  for select using (auth.uid() = user_id);
drop policy if exists "jsw_posts_insert_own" on public.jsw_posts;
create policy "jsw_posts_insert_own" on public.jsw_posts
  for insert with check (auth.uid() = user_id);
drop policy if exists "jsw_posts_update_own" on public.jsw_posts;
create policy "jsw_posts_update_own" on public.jsw_posts
  for update using (auth.uid() = user_id);
drop policy if exists "jsw_posts_delete_own" on public.jsw_posts;
create policy "jsw_posts_delete_own" on public.jsw_posts
  for delete using (auth.uid() = user_id);

-- ============================================================
-- TABLE: amplr_data (dashboard JSON store — posts, templates, groups, etc.)
-- ============================================================
create table if not exists public.amplr_data (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz default now(),
  unique(user_id, key)
);
alter table public.amplr_data enable row level security;
drop policy if exists "amplr_data_select_own" on public.amplr_data;
create policy "amplr_data_select_own" on public.amplr_data
  for select using (auth.uid() = user_id);
drop policy if exists "amplr_data_insert_own" on public.amplr_data;
create policy "amplr_data_insert_own" on public.amplr_data
  for insert with check (auth.uid() = user_id);
drop policy if exists "amplr_data_update_own" on public.amplr_data;
create policy "amplr_data_update_own" on public.amplr_data
  for update using (auth.uid() = user_id);
drop policy if exists "amplr_data_delete_own" on public.amplr_data;
create policy "amplr_data_delete_own" on public.amplr_data
  for delete using (auth.uid() = user_id);

-- ============================================================
-- NOTE ON EXTENSION ACCESS
-- The Chrome extension updates jsw_post_jobs using the anon
-- key. Because RLS requires auth.uid() = user_id, the
-- extension must include the user's session token in the
-- request (it is stored in chrome.storage during pairing).
-- The dashboard creates the session via Supabase email/password
-- auth and the code is exchanged for the user_id during pairing.
-- ============================================================
