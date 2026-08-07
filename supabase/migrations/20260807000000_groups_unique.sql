-- Add unique constraint on jsw_groups for upsert support
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jsw_groups_user_url_unique'
  ) THEN
    ALTER TABLE public.jsw_groups
      ADD CONSTRAINT jsw_groups_user_url_unique UNIQUE (user_id, group_url);
  END IF;
END $$;
