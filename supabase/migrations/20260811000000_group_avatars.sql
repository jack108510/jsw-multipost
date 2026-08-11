-- Store Facebook group avatars/covers scraped during group import.
-- Dashboard falls back gracefully when Facebook does not expose an image.

alter table public.jsw_groups
  add column if not exists group_avatar_url text;
