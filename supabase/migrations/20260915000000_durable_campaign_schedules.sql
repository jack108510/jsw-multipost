-- Durable campaign records and one job per scheduled occurrence. The dashboard
-- saves drafts here; only explicitly enabled campaigns may be admitted.
BEGIN;

CREATE SCHEMA IF NOT EXISTS reachr_private;

ALTER TABLE public.jsw_post_jobs
  ADD COLUMN IF NOT EXISTS first_comment text,
  ADD COLUMN IF NOT EXISTS identity_name text,
  ADD COLUMN IF NOT EXISTS identity_key text,
  ADD COLUMN IF NOT EXISTS identity_type text,
  ADD COLUMN IF NOT EXISTS identity_url text,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS occurrence_id uuid;

CREATE TABLE IF NOT EXISTS public.reachr_campaign_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_campaign_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  message text NOT NULL CHECK (btrim(message) <> ''),
  image_url text,
  first_comment text,
  groups jsonb NOT NULL CHECK (jsonb_typeof(groups) = 'array' AND jsonb_array_length(groups) > 0),
  identity_name text NOT NULL CHECK (btrim(identity_name) <> ''),
  identity_key text NOT NULL CHECK (btrim(identity_key) <> ''),
  identity_type text,
  identity_url text,
  delay integer NOT NULL DEFAULT 90 CHECK (delay >= 90),
  ai_enabled boolean NOT NULL DEFAULT false,
  ai_prompt text,
  timezone text NOT NULL,
  local_time time NOT NULL,
  days integer[] NOT NULL CHECK (array_length(days, 1) BETWEEN 1 AND 7 AND days <@ ARRAY[0,1,2,3,4,5,6]),
  max_runs integer CHECK (max_runs IS NULL OR max_runs > 0),
  ends_at timestamptz,
  fired_count integer NOT NULL DEFAULT 0 CHECK (fired_count >= 0),
  missed_count integer NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  next_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reachr_campaign_active_consistent CHECK (enabled = (status = 'active')),
  CONSTRAINT reachr_campaign_next_required CHECK (NOT enabled OR next_at IS NOT NULL),
  CONSTRAINT reachr_campaign_source_unique UNIQUE (user_id, source_campaign_id)
);
-- Some projects already have a smaller schedule table. Preserve its rows, but
-- leave every pre-existing schedule inactive until it receives a new approval.
ALTER TABLE public.reachr_campaign_schedules
  ADD COLUMN IF NOT EXISTS source_campaign_id text,
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS missed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.reachr_campaign_schedules
  SET source_campaign_id = id::text WHERE source_campaign_id IS NULL;
UPDATE public.reachr_campaign_schedules
  SET enabled = false, status = 'paused', updated_at = now() WHERE enabled;
ALTER TABLE public.reachr_campaign_schedules
  ALTER COLUMN source_campaign_id SET NOT NULL,
  ALTER COLUMN identity_type DROP NOT NULL,
  ALTER COLUMN identity_url DROP NOT NULL,
  ALTER COLUMN next_at DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reachr_campaign_source_unique_idx
  ON public.reachr_campaign_schedules (user_id, source_campaign_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reachr_campaign_active_consistent') THEN
    ALTER TABLE public.reachr_campaign_schedules ADD CONSTRAINT reachr_campaign_active_consistent
      CHECK (enabled = (status = 'active'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reachr_campaign_next_required') THEN
    ALTER TABLE public.reachr_campaign_schedules ADD CONSTRAINT reachr_campaign_next_required
      CHECK (NOT enabled OR next_at IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS reachr_campaign_due_idx
  ON public.reachr_campaign_schedules (user_id, next_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.reachr_schedule_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.reachr_campaign_schedules(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  batch_index integer NOT NULL CHECK (batch_index > 0),
  job_id uuid NOT NULL UNIQUE REFERENCES public.jsw_post_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, scheduled_for, batch_index)
);
ALTER TABLE public.reachr_schedule_occurrences
  ADD COLUMN IF NOT EXISTS batch_index integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS reachr_occurrence_batch_unique_idx
  ON public.reachr_schedule_occurrences (campaign_id, scheduled_for, batch_index);
CREATE UNIQUE INDEX IF NOT EXISTS jsw_post_jobs_occurrence_unique
  ON public.jsw_post_jobs (occurrence_id) WHERE occurrence_id IS NOT NULL;

ALTER TABLE public.reachr_campaign_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reachr_schedule_occurrences ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.reachr_campaign_schedules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reachr_campaign_schedules TO service_role;
GRANT SELECT ON public.reachr_schedule_occurrences TO authenticated, service_role;
CREATE POLICY reachr_campaign_owner_select ON public.reachr_campaign_schedules
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY reachr_campaign_owner_insert ON public.reachr_campaign_schedules
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY reachr_campaign_owner_update ON public.reachr_campaign_schedules
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY reachr_occurrence_owner_select ON public.reachr_schedule_occurrences
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.reachr_campaign_schedules s WHERE s.id = campaign_id AND s.user_id = auth.uid()
  ));

-- The extension calls this with the paired user's JWT. Schedule admission runs
-- inside Postgres, independently of the dashboard tab. The approval migration
-- replaces this private function with its snapshot/approval gated version.
CREATE OR REPLACE FUNCTION reachr_private.schedule_tick_at(p_now timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Campaign approval migration is required before scheduling';
END $$;
REVOKE ALL ON FUNCTION reachr_private.schedule_tick_at(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
