-- Scope imported Facebook groups by posting identity/Page.
-- Before this migration, jsw_groups was unique by (user_id, group_url),
-- which made it impossible to answer "which groups does Wildrose belong to?".

alter table public.jsw_groups
  add column if not exists identity_name text,
  add column if not exists identity_key text,
  add column if not exists identity_type text;

-- Preserve old rows as a legacy/default bucket so the new unique key is stable.
update public.jsw_groups
set identity_key = '__legacy__'
where identity_key is null or btrim(identity_key) = '';

alter table public.jsw_groups
  alter column identity_key set default '__legacy__',
  alter column identity_key set not null;

-- Replace the old cross-identity uniqueness with identity-scoped uniqueness.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'jsw_groups_user_url_unique') then
    alter table public.jsw_groups drop constraint jsw_groups_user_url_unique;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'jsw_groups_user_identity_url_unique') then
    alter table public.jsw_groups
      add constraint jsw_groups_user_identity_url_unique unique (user_id, identity_key, group_url);
  end if;
end $$;

create index if not exists jsw_groups_user_identity_idx
  on public.jsw_groups (user_id, identity_key, created_at desc);
